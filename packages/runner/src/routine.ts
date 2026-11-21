import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionResult } from '@retainer/extension';
import {
  ROUTINE_LIMITS,
  ROUTINE_STOP_CODES,
  type RoutineEffectResponse,
  type RoutineInvocation,
  type RoutineProblem,
  type RoutineRunContext,
} from '@retainer/shared';
import { buildRoutine } from './routine-builder.js';
import { SANDBOX_PRELUDE } from './routine-sandbox.js';

/**
 * The routine runner (routines spec §3.3): a first-party bundle that runs
 * routine code. It fetches the run, type-checks the code against the
 * workspace's types, and runs it in a child process with no file system,
 * no child processes, no environment and no network of its own. The child
 * reaches Retainer only by asking this process, which holds the run's token.
 */

/** What a routine run ends with; the executor maps it to the run's status. */
export type RoutineOutcome = {
  outcome: 'succeeded' | 'failed' | 'stopped';
  code?: string;
  result?: unknown;
  error?: string;
  problems?: RoutineProblem[];
  logs?: string[];
  typesFingerprint?: string;
  stoppedAt?: number;
  valid?: boolean;
  [key: string]: unknown;
};

/** An API refusal; a stop code ends the run, any other is thrown into the code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Codes that end the run where it stands, rather than reaching the code. */
const ENDING_CODES = new Set([
  ...Object.keys(ROUTINE_STOP_CODES),
  'record_used_up',
  'lease_expired',
  'unauthorized',
]);

export class RoutineApi {
  constructor(
    private readonly invocation: RoutineInvocation,
    private readonly signal: AbortSignal,
    private readonly transport: typeof fetch = fetch,
  ) {}
  get origin() {
    return this.invocation.apiOrigin;
  }
  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let attempt = 0;
    for (;;) {
      let response: Response;
      try {
        response = await this.transport(new URL(`/v1/routines/runtime/${path}`, this.origin), {
          method,
          headers: {
            authorization: `Bearer ${this.invocation.runToken}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: this.signal,
          redirect: 'error',
        });
      } catch (error) {
        if (this.signal.aborted || attempt++ >= 3) throw error;
        await delay(500 * 2 ** attempt, this.signal);
        continue;
      }
      const text = await response.text();
      const json = text ? (JSON.parse(text) as unknown) : null;
      if (response.ok) return json as T;
      if ((response.status >= 500 || response.status === 429) && attempt++ < 3) {
        await delay(500 * 2 ** attempt, this.signal);
        continue;
      }
      const error = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiError(
        response.status,
        error?.code ?? (response.status === 401 ? 'unauthorized' : 'api_error'),
        error?.message ?? `the API answered ${response.status}`,
      );
    }
  }
  /** One model call through the proxy with the call's own token (§4.5). */
  async model(
    model: Extract<RoutineEffectResponse, { state: 'model' }>['model'],
    request: { system: string; user: string; schema: Record<string, unknown> },
  ): Promise<unknown> {
    const origin = new URL(model.origin, this.origin);
    const base = origin.href.endsWith('/') ? origin.href : `${origin.href}/`;
    let attempt = 0;
    for (;;) {
      const response = await this.transport(new URL('v1/messages', base), {
        method: 'POST',
        headers: {
          'x-api-key': model.token,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: model.name,
          max_tokens: model.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: providerSchema(request.schema) },
          },
        }),
        signal: this.signal,
        redirect: 'error',
      });
      if ((response.status === 429 || response.status >= 500) && attempt++ < 2) {
        await delay(1000 * 2 ** attempt, this.signal);
        continue;
      }
      const body = (await response.json().catch(() => null)) as {
        stop_reason?: string;
        content?: { type: string; text?: string }[];
        error?: { type?: string; code?: string; message?: string };
      } | null;
      if (!response.ok)
        throw new ApiError(
          response.status,
          response.status === 503 ? 'model_unavailable' : 'model_failed',
          body?.error?.message ?? 'the model call failed',
        );
      if (body?.stop_reason === 'refusal')
        throw new ApiError(422, 'model_refused', 'the model declined to answer');
      if (body?.stop_reason !== 'end_turn')
        throw new ApiError(422, 'model_output', 'the answer was cut off');
      const text = (body.content ?? []).flatMap((b) => (b.type === 'text' ? [b.text ?? ''] : []));
      let answer: unknown;
      try {
        answer = JSON.parse(text.join(''));
      } catch {
        throw new ApiError(422, 'model_output', 'the answer was not valid JSON');
      }
      return fitAnswer(request.schema, answer);
    }
  }
}

/**
 * What the provider's structured outputs accept. Its schema supports fewer
 * keywords than `OutputSchema` allows, and refuses a call that sends one it
 * does not (`maxItems` on an array, for one). Every other keyword is left
 * out of the request; `fitAnswer` applies the ones Retainer enforces itself.
 */
const PROVIDER_KEYWORDS = new Set([
  'type',
  'description',
  'enum',
  'properties',
  'required',
  'items',
]);

/** The schema the provider receives: its own keywords only, every object closed. */
export function providerSchema(schema: unknown, depth = 0): unknown {
  if (depth > 20 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(schema as Record<string, unknown>).filter(([key]) => PROVIDER_KEYWORDS.has(key)),
  );
  if (out.type === 'object') {
    out.additionalProperties = false;
    const props = (out.properties ?? {}) as Record<string, unknown>;
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, value]) => [key, providerSchema(value, depth + 1)]),
    );
  }
  if (out.type === 'array' && out.items) out.items = providerSchema(out.items, depth + 1);
  return out;
}

/**
 * The model's answer held to the schema's limits the provider cannot take:
 * an array keeps its first `maxItems` items.
 */
export function fitAnswer(schema: unknown, value: unknown, depth = 0): unknown {
  if (depth > 20 || !schema || typeof schema !== 'object') return value;
  const s = schema as {
    type?: string;
    items?: unknown;
    maxItems?: unknown;
    properties?: Record<string, unknown>;
  };
  if (s.type === 'array' && Array.isArray(value)) {
    const max = typeof s.maxItems === 'number' && s.maxItems >= 0 ? s.maxItems : value.length;
    return value.slice(0, max).map((item) => fitAnswer(s.items, item, depth + 1));
  }
  if (s.type === 'object' && value && typeof value === 'object' && !Array.isArray(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        fitAnswer(s.properties?.[key], item, depth + 1),
      ]),
    );
  return value;
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

// ---------------------------------------------------------------------------
// The type-check (§5.2, item 3): TypeScript's own compiler, on a temp directory.

const SANDBOX_GLOBALS = `
declare const console: {
  log(...data: unknown[]): void;
  info(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
`;

const require = createRequire(import.meta.url);
function tscPath() {
  return join(require.resolve('typescript/package.json'), '..', 'bin', 'tsc');
}

export type Checked = { problems: RoutineProblem[]; js?: string; dir: string };

/**
 * Type-checks routine code against the workspace's types and emits its
 * JavaScript. `check: false` only emits: the code passed against these types.
 */
export async function typeCheck(
  types: string,
  code: string,
  check: boolean,
  signal: AbortSignal,
  contextType = 'never',
): Promise<Checked> {
  // The permission model matches real paths; macOS's tmpdir is a symlink.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'routine-')));
  await writeFile(join(dir, 'retainer.d.ts'), `${types}\n${SANDBOX_GLOBALS}`);
  // A file name the code cannot know, so no import resolves, its own file
  // included: the sandbox loads nothing but the routine.
  const source = `routine-${randomUUID()}`;
  await writeFile(join(dir, `${source}.ts`), code);
  // The exported `main` must take the context this routine is called with,
  // as Macro checks a step's `main` against its `StepContext`.
  if (check)
    await writeFile(
      join(dir, MAIN_CHECK),
      `import { main } from './${source}.js';\nexport const routineMain: (context: ${contextType}) => unknown = main;\n`,
    );
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'es2023',
        module: 'esnext',
        moduleResolution: 'bundler',
        lib: ['es2023'],
        types: [],
        outDir: 'out',
        rootDir: '.',
        noEmitOnError: false,
        skipLibCheck: true,
        pretty: false,
        ...(check ? {} : { noCheck: true }),
      },
      files: ['retainer.d.ts', `${source}.ts`, ...(check ? [MAIN_CHECK] : [])],
    }),
  );
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [tscPath(), '-p', dir], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (text.length < 200000) text += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (text.length < 200000) text += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', () => resolve(text));
  });
  const problems = parseProblems(output);
  let js: string | undefined;
  try {
    js = await readFile(join(dir, 'out', `${source}.js`), 'utf8');
  } catch {
    js = undefined;
  }
  if (!js && !problems.length)
    problems.push({ part: 'code', code: 'check_failed', message: 'the code did not compile' });
  return { problems, ...(js ? { js } : {}), dir };
}

/** The file that checks the exported `main` is callable; its errors are `missing_main`. */
const MAIN_CHECK = 'main-check.ts';

/** `routine.ts(3,9): error TS2322: message` lines, with their continuation lines. */
export function parseProblems(output: string): RoutineProblem[] {
  const problems: RoutineProblem[] = [];
  for (const line of output.split('\n')) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (match) {
      const [, file, row, column, code, message] = match;
      problems.push(
        file?.endsWith(MAIN_CHECK)
          ? {
              part: 'code',
              code: 'missing_main',
              message: `export a function named main: ${message}`,
            }
          : {
              part: 'code',
              ...(file && /routine(-[0-9a-f-]+)?\.ts$/.test(file)
                ? { at: `${row}:${column}` }
                : {}),
              code: code as string,
              message: message as string,
            },
      );
    } else if (/^\s+\S/.test(line) && problems.length) {
      const last = problems[problems.length - 1] as RoutineProblem;
      if (last.message.length < 2000) last.message += `\n${line.trim()}`;
    }
    if (problems.length >= 50) break;
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The sandbox: a child process that can only ask this one for things.

type SandboxMessage =
  | { id: number; kind: 'read'; operation: string; args: Record<string, unknown> }
  | {
      id: number;
      kind: 'effect';
      position: number;
      operation: string;
      args: Record<string, unknown>;
    }
  | { kind: 'log'; text: string }
  | { kind: 'done'; result: unknown }
  | { kind: 'error'; message: string; code?: string };

class Ended extends Error {
  constructor(readonly outcome: RoutineOutcome) {
    super(outcome.code ?? outcome.outcome);
  }
}

const MAX_LOGS = 50;

/**
 * Runs emitted routine code (§3.3). Effects are numbered by the child when
 * the code calls them, and sent here one after another in that order, so a
 * retried run asks for the same positions.
 */
export async function runSandboxed(
  api: RoutineApi,
  context: RoutineRunContext,
  dir: string,
  js: string,
  deadline: number,
  parent: AbortSignal,
): Promise<RoutineOutcome> {
  await writeFile(join(dir, 'routine.mjs'), js);
  await writeFile(join(dir, 'run.mjs'), SANDBOX_PRELUDE);
  const logs: string[] = [];
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const child = spawn(
    process.execPath,
    [
      '--permission',
      `--allow-fs-read=${dir}`,
      '--disallow-code-generation-from-strings',
      '--max-old-space-size=192',
      '--no-warnings',
      join(dir, 'run.mjs'),
    ],
    { cwd: dir, env: {}, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  // A process that died, or was killed, before the runner saw it exit makes
  // the next write fail with EPIPE. Its 'close' already ends the run, so a
  // lost answer needs nothing more; unheard, the error would crash the runner.
  child.stdin.on('error', () => {});
  const reply = (message: unknown) => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  // Effects go one at a time, in position order.
  const waiting = new Map<number, SandboxMessage & { kind: 'effect' }>();
  let nextPosition = 1;
  let effects = Promise.resolve();
  const drain = () => {
    for (;;) {
      const message = waiting.get(nextPosition);
      if (!message) return;
      waiting.delete(nextPosition);
      nextPosition++;
      effects = effects.then(() => answer(message));
    }
  };
  let finish!: (outcome: RoutineOutcome) => void;
  const finished = new Promise<RoutineOutcome>((resolve) => {
    finish = resolve;
  });
  const end = (outcome: RoutineOutcome) => {
    finish({ ...outcome, ...(logs.length ? { logs } : {}) });
    controller.abort();
  };
  const answer = async (
    message: Extract<SandboxMessage, { kind: 'read' } | { kind: 'effect' }>,
  ) => {
    if (signal.aborted) return;
    try {
      const result =
        message.kind === 'read'
          ? (
              await api.call<{ result: unknown }>('POST', 'read', {
                operation: message.operation,
                args: message.args,
              })
            ).result
          : await effect(api, context, message, signal);
      reply({
        id: message.id,
        result:
          message.kind === 'read' && message.operation === 'files.text'
            ? (result as { text: string }).text
            : result,
      });
    } catch (error) {
      if (error instanceof Ended) return end(error.outcome);
      if (error instanceof ApiError && ENDING_CODES.has(error.code))
        return end({ outcome: 'stopped', code: error.code, error: error.message });
      if (signal.aborted) return;
      reply({
        id: message.id,
        error: {
          code: error instanceof ApiError ? error.code : 'runtime_error',
          message: error instanceof Error ? error.message : 'the call failed',
        },
      });
    }
  };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1048576) return end({ outcome: 'failed', code: 'output_too_large' });
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message: SandboxMessage;
      try {
        message = JSON.parse(line) as SandboxMessage;
      } catch {
        continue;
      }
      if (message.kind === 'log') {
        if (logs.length < MAX_LOGS) logs.push(String(message.text).slice(0, 500));
      } else if (message.kind === 'done') {
        void effects.then(() => end({ outcome: 'succeeded', result: capped(message.result) }));
      } else if (message.kind === 'error') {
        void effects.then(() =>
          end({
            outcome: 'failed',
            code: 'routine_error',
            error: String(message.message).slice(0, 2000),
          }),
        );
      } else if (message.kind === 'read' && Number.isInteger(message.id)) {
        void answer(message);
      } else if (
        message.kind === 'effect' &&
        Number.isInteger(message.position) &&
        message.position >= nextPosition &&
        message.position < nextPosition + 1000
      ) {
        waiting.set(message.position, message);
        drain();
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (logs.length < MAX_LOGS) logs.push(chunk.toString().slice(0, 500));
  });
  child.on(
    'close',
    (status) =>
      void effects.then(() =>
        end({
          outcome: 'failed',
          code: status === null ? 'routine_killed' : 'routine_crashed',
        }),
      ),
  );
  const timer = setTimeout(
    () => end({ outcome: 'failed', code: 'run_timeout' }),
    Math.max(0, deadline - Date.now() - ROUTINE_LIMITS.reportMarginMs),
  );
  parent.addEventListener('abort', () => end({ outcome: 'failed', code: 'run_timeout' }), {
    once: true,
  });
  reply({
    kind: 'start',
    context: {
      startedAt: context.run.startedAt,
      record: context.record,
      run: {
        id: context.run.id,
        at: context.run.at,
        timezone: context.run.timezone,
        dryRun: context.run.dryRun,
      },
      trigger: context.trigger,
    },
  });
  try {
    return await finished;
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
  }
}

function capped(result: unknown) {
  const text = JSON.stringify(result ?? null);
  return text.length > 32768 ? { truncated: true } : JSON.parse(text);
}

/**
 * One numbered effect (§6.2): asked of the API; a tool call is polled until
 * it ends, a model call is made with its own token and its answer recorded.
 */
async function effect(
  api: RoutineApi,
  context: RoutineRunContext,
  message: { position: number; operation: string; args: Record<string, unknown> },
  signal: AbortSignal,
): Promise<unknown> {
  const response = await api.call<RoutineEffectResponse>('POST', 'effects', {
    position: message.position,
    operation: message.operation,
    args: message.args,
  });
  return settleEffect(api, context, message, response, signal);
}

/** Statuses a model call keeps failing with however often it is sent. */
const DEFINITE_MODEL_FAILURES = new Set([400, 404, 413, 422]);

/** Whether a model call failed in a way sending it again would not change. */
export const definiteModelFailure = (error: unknown): error is ApiError =>
  error instanceof ApiError && DEFINITE_MODEL_FAILURES.has(error.status);

/**
 * A refusal or an unusable answer keeps its position, so the run's page can
 * say why and a retry gets the same error (§11.4). A rate limit, an outage
 * or a rejected token may pass, so a later attempt asks again.
 */
export async function recordModelFailure(
  api: RoutineApi,
  position: number,
  error: unknown,
  signal: AbortSignal,
) {
  if (!definiteModelFailure(error) || signal.aborted) return;
  await api
    .call('POST', `effects/${position}/result`, {
      error: { code: error.code, message: error.message.slice(0, 2000) },
    })
    .catch(() => {});
}

export async function settleEffect(
  api: RoutineApi,
  context: RoutineRunContext,
  message: { position: number; operation: string; args: Record<string, unknown> },
  response: RoutineEffectResponse,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.state === 'done') return response.result;
  if (response.state === 'reported') {
    if (response.stop)
      throw new Ended({ outcome: 'succeeded', stoppedAt: message.position, result: null });
    return dryRunResult(context.run.id, message);
  }
  if (response.state === 'model') {
    const args = message.args as { instructions?: unknown; input?: unknown; output?: unknown };
    let result: unknown;
    try {
      result = await api.model(response.model, {
        system: `${String(args.instructions ?? '')}\n\nAnswer with JSON that matches the given schema, and nothing else.`,
        user: JSON.stringify(args.input ?? null),
        schema: (args.output ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      });
    } catch (error) {
      await recordModelFailure(api, message.position, error, signal);
      throw error;
    }
    const recorded = await api.call<RoutineEffectResponse>(
      'POST',
      `effects/${message.position}/result`,
      { result },
    );
    return recorded.state === 'done' ? recorded.result : result;
  }
  // A tool call: poll until it ends (extension tools spec 4).
  for (let wait = 500; ; wait = Math.min(5000, wait * 1.5)) {
    await delay(wait, signal);
    const polled = await api.call<RoutineEffectResponse>('GET', `effects/${message.position}`);
    if (polled.state !== 'pending') return settleEffect(api, context, message, polled, signal);
  }
}

// ---------------------------------------------------------------------------

/**
 * What a write returns in a dry run, in the shape the SDK types (§5.2): the
 * written fields read `applied`, and a record the run would create gets a
 * placeholder ID, the same on every attempt. Nothing was written.
 */
export function dryRunResult(
  runId: string,
  message: { position: number; operation: string; args: Record<string, unknown> },
): unknown {
  const placeholder = () => {
    const hex = createHash('sha256').update(`${runId}:${message.position}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const fields = () =>
    Object.fromEntries(
      Object.keys((message.args.values ?? {}) as Record<string, unknown>).map((key) => [
        key,
        'applied',
      ]),
    );
  switch (message.operation) {
    case 'record.create':
      return { id: placeholder(), fields: fields() };
    case 'record.update':
      return { id: String(message.args.id ?? ''), fields: fields() };
    case 'events.log':
    case 'remember':
      return { id: placeholder() };
    default:
      return { dryRun: true };
  }
}

/** Runs one routine invocation to its outcome. */
export async function executeRoutine(
  invocation: RoutineInvocation,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ExecutionResult> {
  const api = new RoutineApi(invocation, signal, transport);
  const deadline = new Date(invocation.deadline).getTime();
  let outcome: RoutineOutcome;
  let dir: string | undefined;
  try {
    const context = await api.call<RoutineRunContext>('GET', 'run');
    if (context.run.mode === 'build') outcome = await buildRoutine(api, context, signal);
    else if (!context.code) outcome = { outcome: 'failed', code: 'no_code' };
    else {
      const checking = context.run.mode === 'check' || context.check;
      const checked = await typeCheck(
        context.types,
        context.code,
        checking,
        signal,
        context.contextType,
      );
      dir = checked.dir;
      const fingerprint = checking ? { typesFingerprint: context.typesFingerprint } : {};
      if (context.run.mode === 'check')
        outcome = {
          outcome: 'succeeded',
          valid: checked.problems.length === 0,
          problems: checked.problems,
          ...fingerprint,
        };
      else if (checked.problems.length || !checked.js)
        outcome = { outcome: 'failed', code: 'check_failed', problems: checked.problems };
      else
        outcome = {
          ...(await runSandboxed(api, context, checked.dir, checked.js, deadline, signal)),
          ...fingerprint,
        };
    }
  } catch (error) {
    if (error instanceof Ended) outcome = error.outcome;
    else if (error instanceof ApiError && ENDING_CODES.has(error.code))
      outcome = { outcome: 'stopped', code: error.code };
    else if (signal.aborted) outcome = { outcome: 'failed', code: 'run_timeout' };
    else return { status: 'retry', code: 'runner_unavailable' };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { status: 'succeeded', output: fit(outcome) };
}

/** Keeps the outcome within the protocol's 64 KiB, counted in serialized bytes. */
function fit(outcome: RoutineOutcome) {
  const fits = (text: string) => Buffer.byteLength(text) < 60000;
  let text = JSON.stringify(outcome);
  if (fits(text)) return JSON.parse(text);
  const { logs: _logs, result: _result, ...rest } = outcome;
  text = JSON.stringify({ ...rest, problems: rest.problems?.slice(0, 20) });
  return JSON.parse(
    fits(text) ? text : JSON.stringify({ outcome: outcome.outcome, code: outcome.code }),
  );
}

export { ROUTINE_LIMITS };
