import { toAISdkStream } from '@mastra/ai-sdk';
import type { MastraDBMessage } from '@mastra/core/memory';
import { RequestContext } from '@mastra/core/request-context';
import {
  ANTHROPIC_PROVIDER_OPTIONS,
  buildTools,
  createRetainerAgent,
  MODEL_MAX_RETRIES,
} from './agent.js';
import {
  type Claim,
  type ReportAnswer,
  type RuntimeApi,
  RuntimeApiError,
  type StepReport,
  type TurnCloseStatus,
} from './api-client.js';
import { TURN_CREDENTIAL_KEY, TurnCredential } from './credential.js';
import { UI_MESSAGE_VERSION } from './history.js';
import { ContentFreeLogger, errorFields, logEvent } from './logger.js';
import { serverAddedTextPart } from './parts.js';
import { createMastraStore } from './store.js';
import { parsePinnedTools } from './tools.js';

/** After its deadline a turn may still save its last step and close, for this long (spec §6.3). */
export const TURN_GRACE_MS = 60_000;
/** How often the runtime asks the API whether the turn was cancelled (spec §6.5). */
export const POLL_INTERVAL_MS = 5_000;
/** Titles are the start of the first message (spec §3.1). */
export const TITLE_LENGTH = 80;

export type TurnStatus = TurnCloseStatus;

export type TurnOutcome = { status: TurnStatus; errorCode: string | null; steps: number };

export type TurnDeps = {
  api: RuntimeApi;
  /** The `retainer_mastra` role's connection (D8). */
  mastraUrl: string;
  pollIntervalMs?: number;
  graceMs?: number;
};

/** The first 80 characters of a message's text, whitespace collapsed. */
export function titleFrom(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TITLE_LENGTH);
}

/** Why the runtime stopped a turn itself, if it did. */
type StopCause =
  | { kind: 'cancelled'; code: string }
  | { kind: 'limit'; reason: string }
  | { kind: 'deadline' }
  | { kind: 'report_failed' };

/**
 * Maps a model error to how the turn ends (spec §3.4, §5.5, §10.2). Reads
 * only status codes and Anthropic's error text, never logs them.
 */
export function classifyModelError(error: unknown): { status: TurnStatus; code: string } {
  const errors: unknown[] = [];
  const visit = (e: unknown) => {
    if (!e || typeof e !== 'object' || errors.includes(e)) return;
    errors.push(e);
    const r = e as Record<string, unknown>;
    visit(r.lastError);
    visit(r.cause);
    if (Array.isArray(r.errors)) for (const inner of r.errors) visit(inner);
  };
  visit(error);
  const text = (e: unknown) => {
    const r = e as Record<string, unknown>;
    return `${typeof r.message === 'string' ? r.message : ''} ${
      typeof r.responseBody === 'string' ? r.responseBody : ''
    }`;
  };
  for (const e of errors) {
    const r = e as Record<string, unknown>;
    const status = typeof r.statusCode === 'number' ? r.statusCode : undefined;
    const body = text(e);
    if (status === 413 || (status === 400 && /prompt is too long/i.test(body))) {
      return { status: 'context_limit_reached', code: 'context_limit_reached' };
    }
    if (status === 400 && /invalid\W+signature\W+in\W+thinking\W+block/i.test(body)) {
      return { status: 'history_rejected', code: 'history_rejected' };
    }
  }
  for (const e of errors) {
    const r = e as Record<string, unknown>;
    const status = typeof r.statusCode === 'number' ? r.statusCode : undefined;
    if (r.name === 'AbortError') return { status: 'failed', code: 'aborted' };
    if (
      (status !== undefined && (status === 429 || status >= 500)) ||
      r.reason === 'maxRetriesExceeded' ||
      r.name === 'AI_RetryError' ||
      (status === undefined && r.isRetryable === true)
    ) {
      return { status: 'model_unavailable', code: 'model_unavailable' };
    }
  }
  for (const e of errors) {
    const code = (e as { code?: unknown }).code;
    if (
      typeof code === 'string' &&
      ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(code)
    ) {
      return { status: 'model_unavailable', code: 'model_unavailable' };
    }
  }
  return { status: 'failed', code: 'model_error' };
}

/**
 * How a turn ends from the last step's stop reason (spec §3.4). A cut
 * answer is never reported as finished.
 */
export function statusFromStop(
  rawReason: string | null,
  reason: string | undefined,
): { status: TurnStatus; code: string | null } {
  switch (rawReason) {
    case 'end_turn':
    case 'stop_sequence':
      return { status: 'completed', code: null };
    case 'tool_use':
      return { status: 'limit_reached', code: 'max_steps' };
    case 'max_tokens':
      return { status: 'incomplete', code: 'max_tokens' };
    case 'model_context_window_exceeded':
      return { status: 'context_limit_reached', code: 'context_limit_reached' };
    case 'refusal':
      return { status: 'refused', code: 'refused' };
    case 'pause_turn':
      return { status: 'incomplete', code: 'pause_turn' };
    case null:
    case undefined:
      // Anthropic always sends a stop reason; a step without one was cut
      // (a dropped stream), so its answer is never reported as finished.
      if (reason === 'content-filter') return { status: 'refused', code: 'refused' };
      return { status: 'incomplete', code: reason === 'length' ? 'length' : 'no_stop_reason' };
    default:
      return { status: 'incomplete', code: rawReason };
  }
}

type StepUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
};

/** One step's report from Mastra's `onStepFinish` (spec §10.2). */
export function stepReport(
  stepId: string,
  step: {
    finishReason?: string;
    usage?: StepUsage;
    providerMetadata?: Record<string, unknown>;
    toolCalls?: unknown[];
    content?: unknown[];
  },
  rawFinishReason: string | null,
): StepReport {
  const usage = step.usage ?? {};
  const cacheRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheCreationInputTokens ?? 0;
  const anthropic = (step.providerMetadata?.anthropic ?? {}) as {
    usage?: { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } };
  };
  const serverToolUse = anthropic.usage?.server_tool_use;
  // Mastra's step lists its tool calls as chunks: { payload: { toolName, providerExecuted } }.
  const calls = (step.toolCalls ?? []).map((call) => {
    const c = call as {
      toolName?: string;
      providerExecuted?: boolean;
      payload?: { toolName?: string; providerExecuted?: boolean };
    };
    return {
      toolName: c.payload?.toolName ?? c.toolName,
      providerExecuted: (c.payload?.providerExecuted ?? c.providerExecuted) === true,
    };
  });
  const serverCalls = (name: string) =>
    calls.filter((call) => call.providerExecuted && call.toolName === name).length;
  // A count Anthropic sent is used as is, zero included. Without one, a step
  // that ran no server tool counts zero; one that did counts as missing, and
  // the API charges the full allowance (spec §10.1).
  const count = (key: 'web_search_requests' | 'web_fetch_requests', tool: string) => {
    const value = serverToolUse?.[key];
    if (typeof value === 'number') return value;
    return serverCalls(tool) === 0 ? 0 : null;
  };
  const clientToolCalls = calls.filter((call) => !call.providerExecuted).length;
  return {
    stepId,
    usage: {
      input: Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite),
      cacheRead,
      cacheWrite,
      output: usage.outputTokens ?? 0,
    },
    webSearches: count('web_search_requests', 'web_search'),
    webFetches: count('web_fetch_requests', 'web_fetch'),
    toolCalls: clientToolCalls,
    finishReason: step.finishReason ?? 'unknown',
    rawFinishReason,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The SSE framing of the AI SDK UI message stream. */
function sse(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export type RunTurnInput = {
  claim: Claim;
  /** The person's text (a chat), or the task's first message. */
  text: string;
  title?: string;
};

export type RunningTurn = {
  /** The AI SDK UI message stream, SSE-framed. Starts once the message is saved. */
  stream: ReadableStream<Uint8Array>;
  /** Settles when the turn is closed; never rejects. */
  done: Promise<TurnOutcome>;
};

/**
 * Runs one claimed turn to its end (spec §6.2): saves the person's message
 * before any model request, streams the agent's steps, reports each step and
 * waits for the answer before the next request, polls for a cancel, and
 * closes the turn. It keeps going if the client leaves: the stream's reader
 * may go away at any time.
 */
export async function runTurn(deps: TurnDeps, input: RunTurnInput): Promise<RunningTurn> {
  const { api } = deps;
  const { claim } = input;
  const sessionId = claim.session.id;
  const started = Date.now();
  const graceMs = deps.graceMs ?? TURN_GRACE_MS;
  const deadline = Date.parse(claim.deadline);
  const fence = deadline + graceMs;
  const credential = new TurnCredential(claim.turnToken);
  const logger = new ContentFreeLogger();
  const handle = createMastraStore({ connectionString: deps.mastraUrl, fence });

  const closeTurn = async (status: TurnStatus, errorCode: string | null) => {
    const body = {
      status,
      errorCode,
      durationMs: Date.now() - started,
    };
    for (let attempt = 0; attempt < 3 && Date.now() < fence; attempt++) {
      try {
        await api.close(sessionId, credential.reveal(), body);
        return;
      } catch (error) {
        if (error instanceof RuntimeApiError && error.status < 500) return;
        await sleep(500 * (attempt + 1));
      }
    }
    logEvent('warn', 'turn_close_failed', { sessionId, turnId: claim.turnId });
  };

  // Everything before the stream starts: the session's tools, the thread,
  // and the person's message, saved before any model request (spec §6.2).
  let agent: ReturnType<typeof createRetainerAgent>;
  let message: MastraDBMessage;
  const abort = new AbortController();
  let stopCause: StopCause | undefined;
  const stop = (cause: StopCause) => {
    if (!stopCause) stopCause = cause;
    if (!abort.signal.aborted) abort.abort();
  };
  try {
    const pinned = parsePinnedTools(claim.session.tools);
    const tools = buildTools(pinned, {
      api,
      sessionId,
      deadline,
      onFenced: (code) => stop({ kind: 'cancelled', code }),
    });
    agent = createRetainerAgent({
      store: handle.store,
      systemBlocks: claim.session.systemBlocks,
      tools,
      logger,
    });
    const memory = await agent.getMemory();
    if (!memory) throw new Error('the agent has no memory');
    const thread = await memory.getThreadById({ threadId: sessionId });
    if (!thread) {
      await memory.createThread({
        threadId: sessionId,
        resourceId: sessionId,
        title: input.title ?? titleFrom(input.text),
        saveThread: true,
      });
    }
    message = {
      id: crypto.randomUUID(),
      role: 'user',
      threadId: sessionId,
      resourceId: sessionId,
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [
          { type: 'text', text: input.text },
          ...claim.addedParts.map((text) => serverAddedTextPart(text)),
        ],
      },
    };
    await memory.saveMessages({ messages: [message] });
  } catch (error) {
    logEvent('error', 'turn_setup_failed', {
      sessionId,
      turnId: claim.turnId,
      ...errorFields(error),
    });
    await closeTurn('failed', 'setup_failed');
    await handle.close().catch(() => {});
    throw error;
  }

  const requestContext = new RequestContext();
  requestContext.set(TURN_CREDENTIAL_KEY, credential);

  let toolCalls = 0;
  let stepIndex = 0;
  let lastReport: Promise<ReportAnswer | null> = Promise.resolve(null);
  const rawReasons: Array<string | null> = [];
  let lastFinishReason: string | undefined;
  let modelError: unknown;

  const report = async (body: StepReport): Promise<ReportAnswer | null> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const answer = await api.report(sessionId, credential.reveal(), body);
        if (answer.action === 'stop') {
          stop(
            answer.reason === 'cancelled' || answer.reason === 'stale'
              ? { kind: 'cancelled', code: answer.reason }
              : { kind: 'limit', reason: answer.reason ?? 'limit_reached' },
          );
        }
        return answer;
      } catch (error) {
        if (error instanceof RuntimeApiError && error.status >= 400 && error.status < 500) break;
        await sleep(300 * (attempt + 1));
      }
    }
    // A step that can't be counted ends the turn rather than start another
    // one uncounted (spec §10.2).
    stop({ kind: 'report_failed' });
    return null;
  };

  // The raw stop reason of each step arrives on the full stream's
  // step-finish chunk, which can come just after Mastra's onStepFinish; the
  // report waits for it, briefly (spec §3.4).
  const rawWaiters: Array<(reason: string | null) => void> = [];
  const rawReasonOf = (index: number): Promise<string | null> => {
    if (index < rawReasons.length) return Promise.resolve(rawReasons[index] ?? null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2_000);
      rawWaiters[index] = (reason) => {
        clearTimeout(timer);
        resolve(reason);
      };
    });
  };
  const recordRawReason = (reason: string | null) => {
    rawReasons.push(reason);
    rawWaiters[rawReasons.length - 1]?.(reason);
  };

  // One settled report per step, by the step's index in the turn. Mastra
  // calls onStepFinish from its output consumer, which can run after the
  // next step's prepareStep has started, so prepareStep waits on the index,
  // not on whatever report is latest.
  const reports: Array<Promise<ReportAnswer | null>> = [];
  const reportWaiters: Array<(report: Promise<ReportAnswer | null>) => void> = [];
  const reportOf = (index: number): Promise<ReportAnswer | null> => {
    const known = reports[index];
    if (known) return known;
    return new Promise((resolve) => {
      reportWaiters[index] = (next) => resolve(next);
    });
  };

  // A failed request's step finish has no usage: it isn't reported.
  const onStepFinish = async (step: Record<string, unknown>) => {
    const index = stepIndex++;
    lastFinishReason = step.finishReason as string | undefined;
    const previous = lastReport;
    const usage = step.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    const failed = step.finishReason === 'error' && !usage?.inputTokens && !usage?.outputTokens;
    const next = failed
      ? previous
      : (async () => {
          await previous;
          const raw = await rawReasonOf(index);
          return report(stepReport(`${claim.runId}:${index}`, step as never, raw));
        })();
    lastReport = next;
    reports[index] = next;
    reportWaiters[index]?.(next);
  };

  // The report of the previous step gates the next request (spec §10.2), and
  // the step's settings carry the retries (D9). Mastra retries at two levels;
  // the agent's own level is 0 (createRetainerAgent), so only the provider
  // call is retried, and only before its response starts.
  let segmentBase = 0;
  const prepareStep = async (args: { stepNumber?: number }) => {
    const stepNumber = args.stepNumber ?? 0;
    if (stepNumber > 0) {
      const settled = await Promise.race([
        reportOf(segmentBase + stepNumber - 1),
        sleep(Math.max(0, fence - Date.now())).then(() => null),
      ]);
      if (settled === null && !stopCause) stop({ kind: 'report_failed' });
    }
    if (abort.signal.aborted) throw new Error('turn stopped');
    return {
      modelSettings: {
        maxOutputTokens: claim.limits.maxOutputTokens,
        maxRetries: MODEL_MAX_RETRIES,
      },
    };
  };

  const poll = setInterval(() => {
    void api
      .turn(sessionId, credential.reveal())
      .then((state) => {
        if (state.status !== 'running' || !state.current) {
          stop({ kind: 'cancelled', code: state.current ? state.status : 'stale' });
        }
      })
      .catch(() => {});
  }, deps.pollIntervalMs ?? POLL_INTERVAL_MS);
  const deadlineTimer = setTimeout(
    () => stop({ kind: 'deadline' }),
    Math.max(0, deadline - Date.now()),
  );

  const encoder = new TextEncoder();
  let clientGone = false;
  // The turn never waits on its reader: the readable side buffers whatever
  // the client hasn't read yet, and a client that leaves stops nothing.
  const pipe = new TransformStream<Uint8Array, Uint8Array>(
    {},
    { highWaterMark: Number.POSITIVE_INFINITY },
    { highWaterMark: Number.POSITIVE_INFINITY },
  );
  const writer = pipe.writable.getWriter();
  const send = async (chunk: unknown) => {
    if (clientGone) return;
    try {
      await writer.write(encoder.encode(sse(chunk)));
    } catch {
      clientGone = true;
    }
  };

  const done = (async (): Promise<TurnOutcome> => {
    let outcome: TurnOutcome = { status: 'failed', errorCode: 'internal', steps: 0 };
    try {
      await send({ type: 'data-received', data: { messageId: message.id }, transient: true });
      let first = true;
      let input: MastraDBMessage | MastraDBMessage[] = message;
      // A turn continues across `pause_turn` within its limits (spec §3.4).
      for (;;) {
        segmentBase = stepIndex;
        const output = await agent.stream(input as never, {
          memory: { thread: sessionId, resource: sessionId },
          runId: claim.runId,
          savePerStep: true,
          maxSteps: Math.max(1, claim.limits.maxSteps - stepIndex),
          modelSettings: { maxOutputTokens: claim.limits.maxOutputTokens },
          providerOptions: { anthropic: ANTHROPIC_PROVIDER_OPTIONS as never },
          requestContext,
          abortSignal: abort.signal,
          onStepFinish: onStepFinish as never,
          prepareStep: prepareStep as never,
          hooks: {
            beforeToolCall: () => {
              toolCalls++;
              if (toolCalls > claim.limits.maxToolCalls) {
                return {
                  proceed: false,
                  output: {
                    error: {
                      code: 'tool_call_limit',
                      message: 'This turn has made as many tool calls as it may.',
                    },
                  },
                };
              }
              return undefined;
            },
          },
        });
        const ui = toAISdkStream(
          output as never,
          {
            from: 'agent',
            version: UI_MESSAGE_VERSION,
            sendReasoning: true,
            sendSources: true,
            sendStart: first,
            sendFinish: false,
            onError: (error: unknown) => classifyModelError(error).code,
          } as never,
        ) as ReadableStream<unknown>;
        first = false;
        const readFull = (async () => {
          for await (const chunk of output.fullStream as AsyncIterable<{
            type: string;
            payload?: { stepResult?: { rawReason?: string }; error?: unknown };
          }>) {
            if (chunk.type === 'step-finish') {
              recordRawReason(chunk.payload?.stepResult?.rawReason ?? null);
            } else if (chunk.type === 'error') {
              modelError ??= chunk.payload?.error;
            }
          }
        })();
        const readUi = (async () => {
          for await (const chunk of ui as unknown as AsyncIterable<unknown>) await send(chunk);
        })();
        await Promise.all([readFull, readUi]);
        await lastReport;
        const lastRaw = rawReasons.at(-1) ?? null;
        if (
          lastRaw === 'pause_turn' &&
          !stopCause &&
          !modelError &&
          stepIndex < claim.limits.maxSteps &&
          Date.now() < deadline
        ) {
          input = [];
          continue;
        }
        break;
      }

      const lastRaw = rawReasons.at(-1) ?? null;
      const finishedAnswer = lastRaw === 'end_turn' || lastRaw === 'stop_sequence';
      let status: TurnStatus;
      let code: string | null;
      if (stopCause?.kind === 'cancelled') {
        status = 'cancelled';
        code = stopCause.code;
      } else if (stopCause?.kind === 'deadline') {
        status = 'timed_out';
        code = 'deadline';
      } else if (stopCause?.kind === 'report_failed') {
        status = 'failed';
        code = 'report_failed';
      } else if (stopCause?.kind === 'limit' && !finishedAnswer) {
        status = 'limit_reached';
        code = stopCause.reason;
      } else if (modelError && !finishedAnswer) {
        ({ status, code } = classifyModelError(modelError));
        logEvent('warn', 'turn_model_error', { sessionId, ...errorFields(modelError) });
      } else {
        ({ status, code } = statusFromStop(lastRaw, lastFinishReason));
      }
      outcome = { status, errorCode: code, steps: stepIndex };
    } catch (error) {
      const classified = stopCause
        ? { status: 'cancelled' as TurnStatus, code: 'stopped' }
        : classifyModelError(error);
      outcome = { status: classified.status, errorCode: classified.code, steps: stepIndex };
      logEvent('error', 'turn_failed', { sessionId, ...errorFields(error) });
    } finally {
      clearInterval(poll);
      clearTimeout(deadlineTimer);
    }
    if (outcome.status !== 'completed') {
      await send({
        type: 'data-turn-end',
        data: { status: outcome.status, code: outcome.errorCode },
      });
    }
    await send({ type: 'finish' });
    if (!clientGone) {
      try {
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        await writer.close();
      } catch {
        clientGone = true;
      }
    }
    // Pending saves finish (or hit the fence) before the close (spec §5.2).
    await handle.close().catch(() => {});
    await closeTurn(outcome.status, outcome.errorCode);
    logEvent('info', 'turn_closed', {
      sessionId,
      turnId: claim.turnId,
      status: outcome.status,
      code: outcome.errorCode,
      steps: outcome.steps,
      durationMs: Date.now() - started,
    });
    return outcome;
  })();

  return { stream: pipe.readable, done };
}
