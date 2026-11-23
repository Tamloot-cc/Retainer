import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { EXECUTOR_ROLE } from '../../src/config.js';
import { createModelProxy } from '../../src/model/proxy.js';
import { reportTrace, reportUsage, USAGE_REPORT_PATH } from '../../src/model/routes.js';
import type { ModelTrace } from '../../src/model/trace.js';
import { ChangeMaintenance } from '../../src/worker/changes.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { testRunTokens } from '../helpers/model.js';

const db = useTestDatabase();
const secret = 'trace-test-secret-'.padEnd(40, 'x');
const model = 'claude-opus-5-5';
const runId = randomUUID();
let setup: Awaited<ReturnType<typeof testRunTokens>>;
let app: ReturnType<typeof startTestApp>;
let workspace: string;
let token: string;
beforeAll(async () => {
  setup = await testRunTokens();
  app = startTestApp(db, { runTokens: setup.tokens, modelUsageSecret: secret });
  const created = await app.setupWorkspace({ name: 'Model traces' }, {});
  workspace = created.workspace.id;
  token = await setup.tokens.issueRoutineModel(
    {
      kind: 'routine',
      workspaceId: workspace,
      routineId: null,
      runId,
      model,
      attempt: 2,
      position: 1,
      maxTokens: 20,
    },
    new Date(Date.now() + 120_000),
  );
});

function proxyRequest() {
  return new Request('https://proxy.test/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': token },
    body: JSON.stringify({ model, messages: [], max_tokens: 10, stream: true }),
  });
}

it('records every provider attempt once and joins partial and complete usage by call ID', async () => {
  const responses = [
    new Response(
      'data: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":3}}}\n\ndata: {"type":"message_stop"}\n\n',
      {
        headers: { 'request-id': 'req_ok' },
      },
    ),
    new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
      status: 429,
      headers: { 'request-id': 'req_limited' },
    }),
    new Error('connection failed'),
    new Response(
      'data: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":4}}}\n\n',
      {
        headers: { 'request-id': 'req_incomplete' },
      },
    ),
    new Response(null, { status: 204 }),
  ];
  const reporting = {
    origin: 'https://retainer.test',
    secret,
    fetch: app.inProcessFetch as typeof fetch,
  };
  const proxy = createModelProxy({
    tokens: setup.tokens,
    apiKey: 'fake-key',
    upstream: 'https://provider.test',
    fetch: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('unexpected upstream request');
      return next;
    },
    record: reportUsage(reporting),
    trace: reportTrace(reporting),
  });
  for (const status of [200, 429, 502, 200, 204]) {
    const response = await proxy(proxyRequest(), '/v1/messages');
    expect(response.status).toBe(status);
    await response.text();
  }
  const calls = await db.owner`
    select c.id, c.owner_id, c.attempt, c.outcome, c.http_status, c.code, c.duration_ms, u.partial, u.id as usage_id
    from model_calls c left join ai_usage u on u.workspace_id=c.workspace_id and u.id=c.id
    where c.owner_id=${runId} order by c.started_at, c.id`;
  expect(calls).toHaveLength(5);
  expect(calls.map((c) => [c.outcome, c.http_status, c.partial])).toEqual([
    ['completed', 200, false],
    ['provider_error', 429, null],
    ['transport_error', null, null],
    ['stream_interrupted', 200, true],
    ['stream_interrupted', 204, null],
  ]);
  expect(calls[1]?.code).toBe('rate_limit_error');
  expect(calls[4]?.code).toBe('stream_incomplete');
  for (const c of calls) {
    expect(c).toMatchObject({ owner_id: runId, attempt: 2, duration_ms: expect.any(Number) });
    if (c.partial !== null) expect(c.usage_id).toBe(c.id);
  }
});

it('makes terminal-first reports and concurrent replays idempotent and derives ownership from the token', async () => {
  const start = {
    id: randomUUID(),
    type: 'model_call',
    requestedModel: 'spoofed-model',
    startedAt: new Date().toISOString(),
    outcome: 'started',
  } as const;
  const terminal: ModelTrace = {
    ...start,
    outcome: 'transport_error',
    finishedAt: new Date().toISOString(),
    durationMs: 25,
    returnedModel: null,
    providerRequestId: null,
    httpStatus: null,
    code: 'fetch_failed',
  };
  const send = async (trace: ModelTrace, runToken = token, auth = secret) =>
    app.inProcessFetch(new URL(USAGE_REPORT_PATH, 'https://retainer.test'), {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ token: runToken, ...trace }),
    });
  expect((await send(terminal, token, 'wrong-secret')).status).toBe(401);
  expect((await send(terminal, 'bad-model-token')).status).toBe(401);
  expect((await send(terminal)).status).toBe(200);
  const deliveries = await Promise.all([send(start), send(terminal), send(start)]);
  expect(deliveries.map((r) => r.status)).toEqual([200, 200, 200]);

  const records = await db.owner`select * from model_calls where id=${start.id}`;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    workspace_id: workspace,
    owner_id: runId,
    requested_model: model,
    outcome: 'transport_error',
    duration_ms: 25,
  });

  const pending = { ...start, id: randomUUID() };
  expect((await send(pending)).status).toBe(200);
  const [row] = await db.owner`select outcome, finished_at from model_calls where id=${pending.id}`;
  expect(row).toEqual({ outcome: 'started', finished_at: null });
  await db.owner`update model_calls set started_at=now()-interval '31 days' where id=${pending.id}`;
  const executor = db.connect({ role: EXECUTOR_ROLE });
  await executor`select public.retainer_prune_model_calls()`;
  expect(await db.owner`select id from model_calls where id=${pending.id}`).toHaveLength(0);
});

it('captures a bounded response only inside the approved scope and prunes payloads independently', async () => {
  const recorder = {
    origin: 'https://retainer.test',
    secret,
    fetch: app.inProcessFetch as typeof fetch,
  };
  const now = Date.now();
  const policy = {
    workspaceId: workspace,
    ownerKind: 'routine' as const,
    ownerId: runId,
    startsAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const bytes = 'a'.repeat(40_000);
  const send = async (
    capturePolicy?: typeof policy,
    content?: string,
    captureWorkspaces: ReadonlySet<string> = new Set(),
  ) => {
    const proxy = createModelProxy({
      tokens: setup.tokens,
      apiKey: 'fake-key-never-captured',
      upstream: 'https://provider.test',
      fetch: async () => new Response(bytes),
      record: reportUsage(recorder),
      trace: reportTrace(recorder),
      capturePolicy,
      captureWorkspaces,
    });
    const request = new Request('https://proxy.test/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': token, authorization: 'Bearer fixture-header' },
      body: JSON.stringify({
        model,
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: content ?? 'Synthetic input' }],
      }),
    });
    const response = await proxy(request, '/v1/messages');
    expect(await response.text()).toBe(bytes);
  };
  await send();
  await send({ ...policy, ownerId: randomUUID() });
  await send({
    ...policy,
    startsAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now - 1_000).toISOString(),
  });
  await send(policy, 'Bearer rt_model_secret_fixture');
  await send(undefined, undefined, new Set([randomUUID()]));
  await send(undefined, 'Bearer rt_model_secret_fixture', new Set([workspace]));
  expect(await db.owner`select call_id from model_call_payloads`).toHaveLength(0);
  await send(undefined, undefined, new Set([workspace]));
  const [automatic] = await db.owner`delete from model_call_payloads returning request_body`;
  if (!automatic) throw new Error('expected an automatic capture');
  expect((automatic.request_body as Buffer).toString()).toContain('Synthetic input');
  await send(policy, bytes);

  const captures = await db.owner`select * from model_call_payloads`;
  expect(captures).toHaveLength(1);
  const capture = captures[0];
  if (!capture) throw new Error('expected a captured payload');
  expect(capture).toMatchObject({
    request_truncated: true,
    response_truncated: true,
    response_partial: true,
  });
  expect(Buffer.byteLength(capture.request_body as Buffer)).toBe(32768);
  expect(Buffer.byteLength(capture.response_body as Buffer)).toBe(32768);
  expect((capture.request_body as Buffer).toString('utf8')).not.toContain('fixture-header');

  const runtime = db.connect({ role: 'retainer_app' });
  await expect(runtime`select request_body from model_call_payloads`).rejects.toMatchObject({
    code: '42501',
  });
  const executor = db.connect({ role: EXECUTOR_ROLE });
  await db.owner`update model_call_payloads set expires_at=now()-interval '1 minute'`;
  await executor`select public.retainer_prune_model_call_payloads()`;
  expect(await db.owner`select call_id from model_call_payloads`).toHaveLength(0);
  expect(
    await db.owner`select id from model_calls where id=${capture.call_id as string}`,
  ).toHaveLength(1);

  const extra = await app.setupWorkspace({ name: 'Workspace erase test' }, {});
  await db.owner`insert into model_calls (id,workspace_id,owner_kind,owner_id,attempt,provider,started_at,outcome)
    values (${randomUUID()},${extra.workspace.id},'routine',${runId},1,'anthropic',now(),'started')`;
  await db.owner`insert into model_call_payloads (workspace_id,call_id,request_body,response_body,request_truncated,response_truncated,response_partial,expires_at)
    select workspace_id,id,decode('','hex'),decode('','hex'),false,false,true,now()+interval '7 days'
    from model_calls where workspace_id=${extra.workspace.id}`;
  await db.owner`delete from workspaces where id=${extra.workspace.id}`;
  expect(
    await db.owner`select id from model_calls where workspace_id=${extra.workspace.id}`,
  ).toHaveLength(0);
  expect(
    await db.owner`select call_id from model_call_payloads where workspace_id=${extra.workspace.id}`,
  ).toHaveLength(0);
});

it('drains more than one batch of expired traces in a single maintenance tick', async () => {
  const owner = randomUUID();
  await db.owner`insert into model_calls (id,workspace_id,owner_kind,owner_id,attempt,provider,started_at,outcome)
    select uuidv7(),${workspace},'routine',${owner},1,'anthropic',now()-interval '31 days','started'
    from generate_series(1, 2500)`;
  const maintenance = new ChangeMaintenance(db.owner, db.connect({ role: EXECUTOR_ROLE }));
  expect((await maintenance.tick()).failed).toBe(0);
  expect(await db.owner`select id from model_calls where owner_id=${owner}`).toHaveLength(0);
});
