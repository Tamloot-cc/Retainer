import {
  aggregateOps,
  type FieldType,
  filterOperatorsFor,
  generateRoutineTypes,
  type RoutineInvocation,
  type RoutineRunContext,
  SORTABLE_TYPES,
  writeRules,
} from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import { executeRoutine, parseProblems, typeCheck } from './routine.js';

const TYPES = `
type RecordId = string;
type DealRecord = { id: RecordId; createdAt: string; updatedAt: string; stage: 'lead' | 'won'; amount: number | null };
type Retainer = {
  deal: {
    get(id: RecordId): Promise<DealRecord | null>;
    update(id: RecordId, values: { stage?: 'lead' | 'won' }): Promise<{ id: RecordId }>;
  };
  tools: { notify(input: { text: string }): Promise<{ sent: boolean }> };
  ai: { generate(input: { instructions: string; input: unknown; output: unknown }): Promise<any> };
};
type RunInfo = { id: string; at: string; timezone: string; dryRun: boolean };
type RoutineContext<O = undefined> = { retainer: Retainer; record: O extends 'deal' ? DealRecord : undefined; run: RunInfo; trigger: { kind: string } };
`;

const invocation: RoutineInvocation = {
  kind: 'routine',
  protocolVersion: 1,
  runId: '00000000-0000-4000-8000-000000000001',
  attempt: 1,
  releaseDigest: 'a'.repeat(64),
  apiOrigin: 'http://api.test/',
  runToken: 'rt_routine_test',
  deadline: new Date(Date.now() + 60000).toISOString(),
};

function context(code: string, mode: RoutineRunContext['run']['mode'] = 'run'): RoutineRunContext {
  return {
    run: {
      id: invocation.runId,
      mode,
      at: '2026-11-20T10:00:00.000Z',
      startedAt: '2026-11-20T10:01:00.000Z',
      timezone: 'UTC',
      dryRun: mode === 'dry',
      attempt: 1,
    },
    trigger: { kind: 'record' },
    code,
    types: TYPES,
    typesFingerprint: 'f'.repeat(64),
    check: false,
    record: {
      id: 'deal-1',
      object: 'deal',
      createdAt: 'x',
      updatedAt: 'x',
      stage: 'lead',
      amount: 5,
    },
  } as RoutineRunContext;
}

/** A fake routine API: only the HTTP edge is faked; it records what the runner asked. */
function fakeApi(
  ctx: RoutineRunContext,
  answer: (path: string, body: any) => unknown = (path) =>
    path === 'effects' ? { state: 'done', result: { ok: true }, replayed: false } : undefined,
) {
  const calls: { path: string; body: any; auth: string | null }[] = [];
  const transport = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace('/v1/routines/runtime/', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, auth: new Headers(init?.headers).get('authorization') });
    if (path === 'run') return Response.json(ctx);
    const result = answer(path, body);
    if (result instanceof Response) return result;
    if (path === 'read')
      return Response.json({ result: result ?? { id: body.args.id, stage: 'lead' } });
    return Response.json(result);
  }) as typeof fetch;
  return { calls, transport };
}

const run = (ctx: RoutineRunContext, answer?: (path: string, body: any) => unknown) => {
  const api = fakeApi(ctx, answer);
  return executeRoutine(invocation, AbortSignal.timeout(30000), api.transport).then((result) => ({
    result,
    calls: api.calls,
  }));
};

it('holds the sandbox clock fixed during module evaluation and across attempts', async () => {
  const ctx = context(`
    const moduleTime = Date.now();
    export function main() {
      return {
        moduleTime,
        now: Date.now(),
        noArgs: new Date().toISOString(),
        explicit: new Date(0).toISOString(),
        called: Date() === new Date().toString(),
      };
    }
  `);
  const first = await run(ctx);
  const second = await run({ ...ctx, run: { ...ctx.run, attempt: 2 } });
  expect(first.result).toMatchObject({
    status: 'succeeded',
    output: {
      outcome: 'succeeded',
      result: {
        moduleTime: Date.parse(ctx.run.startedAt),
        now: Date.parse(ctx.run.startedAt),
        noArgs: ctx.run.startedAt,
        explicit: '1970-01-01T00:00:00.000Z',
        called: true,
      },
    },
  });
  expect(second).toEqual(first);
});

describe('routine type-check', () => {
  it('reports type errors with their position, and emits JavaScript', async () => {
    const checked = await typeCheck(
      TYPES,
      `export async function main({ record }: RoutineContext<'deal'>) {\n  const n: string = record.amount;\n  return n;\n}\n`,
      true,
      AbortSignal.timeout(30000),
    );
    expect(checked.problems).toEqual([
      expect.objectContaining({ part: 'code', at: '2:9', code: 'TS2322' }),
    ]);
    expect(checked.js).toContain('export async function main');
  });

  it('refuses imports and require as syntax, and nothing that only looks like one', async () => {
    const check = async (code: string) =>
      (await typeCheck(TYPES, code, true, AbortSignal.timeout(30000))).problems.map((p) => p.at);
    // No module resolves in the sandbox, so every real import fails the check.
    expect(
      await check(`import fs from 'fs';\nexport async function main() { return fs; }`),
    ).toEqual(['1:16']);
    expect(await check(`export async function main() { return await import('fs'); }`)).toEqual([
      '1:52',
    ]);
    expect(await check(`export async function main() { return require('fs'); }`)).toEqual(['1:39']);
    // Nor does the routine's own file, which the sandbox would not load either.
    expect(
      await check(
        `import { main as again } from './routine.js';\nexport async function main() { return again; }`,
      ),
    ).toEqual(['1:31']);
    expect(await check(`export async function main() { return import('./routine.js'); }`)).toEqual([
      '1:46',
    ]);
    // Strings, comments, a member named import and a regex literal are not imports.
    expect(
      await check(`const helper = { import: (v: number) => v };
const trim = (u: string) => u.replace(/\\/*$/, '');
const tick = /\`/g;
// import('fs')
export async function main() {
  return [helper.import(1), trim('a//'), tick.source, "Never call import(...) or require(x)"];
}
`),
    ).toEqual([]);
  });

  it('refuses an exported main that is not a function', async () => {
    const codes = async (code: string) =>
      (await typeCheck(TYPES, code, true, AbortSignal.timeout(30000))).problems.map((p) => p.code);
    expect(await codes('export const main = 1;\n')).toEqual(['missing_main']);
    expect(await codes('export const main = async () => 1;\n')).toEqual([]);
    // Typed for a record when the routine has none, `main` cannot take its context.
    const deal = `export async function main({ record }: RoutineContext<'deal'>) {\n  return record.id;\n}\n`;
    const against = async (contextType: string) =>
      (await typeCheck(TYPES, deal, true, AbortSignal.timeout(30000), contextType)).problems.map(
        (p) => p.code,
      );
    expect(await against("RoutineContext<'deal'>")).toEqual([]);
    expect(await against('RoutineContext')).toEqual(['missing_main']);
  });

  it('parses continuation lines into the problem message', () => {
    expect(
      parseProblems("routine.ts(3,9): error TS2322: Type 'a' is wrong.\n  Type 'b' is not 'c'.\n"),
    ).toEqual([
      {
        part: 'code',
        at: '3:9',
        code: 'TS2322',
        message: "Type 'a' is wrong.\nType 'b' is not 'c'.",
      },
    ]);
  });
});

/** A fixture field with what the API takes for it, from the API's own rules. */
const withRules = (
  objects: {
    fields: { type: string; filterable: boolean; nullable: boolean; many?: boolean }[];
  }[],
) =>
  objects.map((object) => ({
    ...object,
    fields: object.fields.map((field) => {
      const rules = {
        type: field.type as FieldType,
        settings: { relationCardinality: field.many ? 'many_to_many' : 'many_to_one' },
      };
      return {
        ...field,
        operators: field.filterable ? [...filterOperatorsFor(rules)] : [],
        sortable: field.filterable && SORTABLE_TYPES.includes(rules.type),
        aggregates: aggregateOps(rules),
        ...writeRules({ ...rules, isNullable: field.nullable }),
      };
    }),
  }));

describe('generated workspace types', () => {
  const types = generateRoutineTypes({
    model: true,
    objects: withRules([
      {
        name: 'deal',
        universalId: 'u-deal',
        label: 'Deal',
        description: 'A sale in progress',
        isEvent: false,
        fields: [
          {
            key: 'stage',
            name: 'stage',
            label: 'Stage',
            type: 'select',
            description: null,
            filterable: true,
            nullable: true,
            options: ['lead', 'won'],
          },
          {
            key: 'amount_k',
            name: 'amount',
            label: 'Amount',
            type: 'money',
            description: null,
            filterable: true,
            nullable: true,
          },
          {
            key: 'company',
            name: 'company',
            label: 'Company',
            type: 'relation',
            description: null,
            filterable: true,
            nullable: true,
            target: 'company',
            many: false,
          },
          {
            key: 'title',
            name: 'title',
            label: 'Title',
            type: 'text',
            description: null,
            filterable: true,
            nullable: false,
          },
          {
            key: 'owner',
            name: 'owner',
            label: 'Owner',
            type: 'relation',
            description: null,
            filterable: true,
            nullable: false,
            target: 'company',
            many: false,
          },
          {
            key: 'partners',
            name: 'partners',
            label: 'Partners',
            type: 'relation',
            description: null,
            filterable: true,
            nullable: true,
            target: 'company',
            many: true,
          },
          {
            key: 'meta',
            name: 'meta',
            label: 'Meta',
            type: 'json',
            description: null,
            filterable: false,
            nullable: true,
          },
        ],
      },
      {
        name: 'meeting',
        universalId: 'u-meeting',
        label: 'Meeting',
        description: null,
        isEvent: true,
        fields: [
          {
            key: 'notes',
            name: 'notes',
            label: 'Notes',
            type: 'text',
            description: null,
            filterable: false,
            nullable: true,
          },
        ],
      },
    ]),
    tools: [
      {
        name: 'send_email',
        title: 'Send an email',
        description: 'Sends one email.',
        effect: 'send',
        connection: 'workspace',
        model: false,
        extension: 'Mailer',
        status: 'ready',
        inputSchema: {
          type: 'object',
          properties: { to: { type: 'string' }, body: { type: 'string' } },
          required: ['to', 'body'],
        },
        outputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
    ],
  } as never);

  it('compile, and check real routine code against the workspace', async () => {
    const good = await typeCheck(
      types,
      `export async function main({ retainer, record, run }: RoutineContext<'deal'>) {
  if (record.stage !== 'won') return null;
  const meetings = await retainer.meeting.query({ filter: { occurredAt: { gt: run.at } }, limit: 5 });
  const big = await retainer.deal.query({ filter: { amount_k: { gte: 5000000 }, stage: { in: ['won'] } } });
  const { tone } = await retainer.ai.generate({
    instructions: 'Pick a tone',
    input: { count: meetings.count + big.count },
    output: { type: 'object', properties: { tone: { type: 'string', enum: ['warm', 'formal'] } }, required: ['tone'] },
  });
  const stats = await retainer.deal.aggregate({ aggregates: [{ field: 'stage', op: 'countEmpty' }, { field: 'amount_k', op: 'sum' }] });
  await retainer.meeting.query({ sort: [{ field: 'occurredAt', direction: 'desc' }, { field: 'id' }] });
  const sent = await retainer.tools.send_email({ to: 'a@b.c', body: tone + run.at + stats.total });
  await retainer.deal.update(record.id, { stage: 'lead', meta: null, partners: [] });
  await retainer.deal.create({ title: record.title + ' renewal', owner: record.owner ?? record.id, meta: { tags: ['a'], n: 1 } });
  return sent.id;
}
`,
      true,
      AbortSignal.timeout(30000),
    );
    expect(good.problems).toEqual([]);
    const bad = await typeCheck(
      types,
      `export async function main({ retainer, record }: RoutineContext<'deal'>) {
  await retainer.deal.update(record.id, { stage: 'lost' });
  await retainer.tools.send_email({ to: 'a@b.c' });
  await retainer.deal.aggregate({ aggregates: [{ field: 'stage', op: 'count_empty' }] });
  await retainer.meeting.query({ filter: { notes: { contains: 'quote' } } });
  await retainer.deal.query({ filter: { stage: { gt: 'won' }, amount_k: { gt: { amountMicros: 1, currency: 'USD' } } } });
  await retainer.meeting.query({ sort: [{ field: 'notes' }] });
  await retainer.deal.aggregate({ aggregates: [{ field: 'stage', op: 'sum' }] });
  await retainer.deal.create({ stage: 'won' });
  await retainer.deal.update(record.id, { title: null });
  await retainer.deal.update(record.id, { meta: () => 1 });
  await retainer.deal.update(record.id, { owner: null });
  await retainer.deal.update(record.id, { partners: null });
  return retainer.invoice.get('x');
}
`,
      true,
      AbortSignal.timeout(30000),
    );
    // The aggregate operators are the API's own names. Filters take only
    // filterable fields, the operators the API allows for each type, and its
    // operand (money compares amountMicros). A create sets every required
    // field, null clears only a nullable one, and a JSON field takes JSON.
    expect(bad.problems.map((p) => p.at)).toEqual([
      '2:43',
      '3:35',
      expect.stringMatching(/^4:/),
      expect.stringMatching(/^5:/),
      expect.stringMatching(/^6:/),
      expect.stringMatching(/^6:/),
      expect.stringMatching(/^7:/),
      expect.stringMatching(/^8:/),
      expect.stringMatching(/^9:/),
      expect.stringMatching(/^10:/),
      expect.stringMatching(/^11:/),
      expect.stringMatching(/^12:/),
      expect.stringMatching(/^13:/),
      '14:19',
    ]);
  });
});

describe('routine sandbox', () => {
  it('runs the code with the record, reads through the runner and returns its result', async () => {
    const { result, calls } = await run(
      context(`export async function main({ retainer, record, run }: RoutineContext<'deal'>) {
        const deal = await retainer.deal.get(record.id);
        console.log('stage', deal?.stage);
        return { stage: deal?.stage, at: run.at };
      }`),
    );
    expect(result).toEqual({
      status: 'succeeded',
      output: {
        outcome: 'succeeded',
        result: { stage: 'lead', at: '2026-11-20T10:00:00.000Z' },
        logs: ['stage lead'],
      },
    });
    expect(calls.find((c) => c.path === 'read')?.body).toEqual({
      operation: 'record.get',
      args: { object: 'deal', id: 'deal-1' },
    });
    // Only the runner holds the token.
    expect(calls.every((c) => c.auth === 'Bearer rt_routine_test')).toBe(true);
  });

  it('numbers effects in call order and sends them one after another, even when started together', async () => {
    const seen: number[] = [];
    const { result } = await run(
      context(`export async function main({ retainer, record }: RoutineContext<'deal'>) {
        await Promise.all([1, 2, 3, 4].map(() => retainer.deal.update(record.id, { stage: 'won' })));
        return 'ok';
      }`),
      (path, body) => {
        if (path === 'effects') seen.push(body.position);
        return { state: 'done', result: { id: 'deal-1' }, replayed: false };
      },
    );
    expect(result.status).toBe('succeeded');
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('closes the sandbox: no network, modules, process, file system or eval', async () => {
    const { result } = await run(
      context(`export async function main() {
        const g = globalThis as any;
        const out: Record<string, string> = {};
        out.fetch = typeof g.fetch;
        out.process = typeof g.process;
        out.WebSocket = typeof g.WebSocket;
        try { await (0, eval)('1'); out.eval = 'ran'; } catch { out.eval = 'blocked'; }
        try { new Function('return 1')(); out.fn = 'ran'; } catch { out.fn = 'blocked'; }
        const load = 'im' + 'port';
        out.importGlobal = typeof g[load];
        return out;
      }`),
    );
    expect(result).toMatchObject({
      status: 'succeeded',
      output: {
        outcome: 'succeeded',
        result: {
          fetch: 'undefined',
          process: 'undefined',
          WebSocket: 'undefined',
          eval: 'blocked',
          fn: 'blocked',
          importGlobal: 'undefined',
        },
      },
    });
  });

  it('refuses dynamic imports at the loader, however they are written', async () => {
    const { result } = await run(
      context(`export async function main() {
        try { await import /* hidden */ ('node:fs'); return 'loaded'; } catch (e) { return (e as Error).message; }
      }`),
    );
    expect(result).toMatchObject({
      output: { outcome: 'succeeded', result: 'routine code cannot import modules' },
    });
  });

  it('throws API refusals into the code, and ends the run on a stop code', async () => {
    const caught = await run(
      context(`export async function main({ retainer, record }: RoutineContext<'deal'>) {
        try { await retainer.deal.update(record.id, { stage: 'won' }); } catch (e: any) { return e.code; }
      }`),
      () => Response.json({ error: { code: 'pending_review', message: 'no' } }, { status: 422 }),
    );
    expect(caught.result).toMatchObject({
      output: { outcome: 'succeeded', result: 'pending_review' },
    });

    const stopped = await run(
      context(`export async function main({ retainer, record }: RoutineContext<'deal'>) {
        try { await retainer.deal.update(record.id, { stage: 'won' }); } catch { return 'swallowed'; }
      }`),
      () =>
        Response.json({ error: { code: 'routine_paused', message: 'paused' } }, { status: 409 }),
    );
    expect(stopped.result).toMatchObject({
      output: { outcome: 'stopped', code: 'routine_paused' },
    });
  });

  it('ends a dry run at the first tool call', async () => {
    const { result, calls } = await run(
      context(
        `export async function main({ retainer }: RoutineContext<'deal'>) {
          await retainer.tools.notify({ text: 'hi' });
          await retainer.tools.notify({ text: 'again' });
          return 'never';
        }`,
        'dry',
      ),
      () => ({ state: 'reported', stop: true }),
    );
    expect(result).toMatchObject({ output: { outcome: 'succeeded', stoppedAt: 1 } });
    expect(calls.filter((c) => c.path === 'effects')).toHaveLength(1);
  });

  it('polls a tool call until it ends', async () => {
    let polls = 0;
    const { result } = await run(
      context(`export async function main({ retainer }: RoutineContext<'deal'>) {
        return retainer.tools.notify({ text: 'hi' });
      }`),
      (path) => {
        if (path === 'effects') return { state: 'pending', tool: { callId: 'job-1' } };
        polls++;
        return polls < 2
          ? { state: 'pending', tool: { callId: 'job-1' } }
          : { state: 'done', result: { sent: true }, replayed: false };
      },
    );
    expect(result).toMatchObject({ output: { outcome: 'succeeded', result: { sent: true } } });
  });

  it('a check run reports problems instead of running', async () => {
    const { result, calls } = await run(
      context(
        `export async function main({ record }: RoutineContext<'deal'>) { return record.missing; }`,
        'check',
      ),
    );
    expect(result).toMatchObject({
      output: { outcome: 'succeeded', valid: false, typesFingerprint: 'f'.repeat(64) },
    });
    expect(calls.map((c) => c.path)).toEqual(['run']);
  });

  it('keeps a multibyte result within the protocol limit, counted in bytes', async () => {
    // 25,000 CJK characters are under 60,000 code units but about 75 KB of UTF-8.
    const { result } = await run(
      context(`export async function main() { return '漢'.repeat(25000); }`),
    );
    expect(result).toEqual({ status: 'succeeded', output: { outcome: 'succeeded' } });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
  });

  it('fails a run whose code throws', async () => {
    const { result } = await run(
      context(`export async function main() { throw new Error('boom'); }`),
    );
    expect(result).toMatchObject({
      output: { outcome: 'failed', code: 'routine_error', error: 'boom' },
    });
  });
});
