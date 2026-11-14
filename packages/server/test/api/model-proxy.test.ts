import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import postgres from 'postgres';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelClaims, RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { MAX_REQUEST_BYTES } from '../../src/model/proxy.js';
import { recordDirectly } from '../../src/model/routes.js';
import { runCli } from '../../src/operator/commands.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import {
  answer,
  claimRun,
  fakeAnthropic,
  installModelRelease,
  modelRelease,
  PICK,
  testRunTokens,
  type Upstream,
} from '../helpers/model.js';

// Model calls spec 3.2-3.6 and 7: the self-hosted proxy, against real
// Postgres, with Anthropic faked at the HTTP boundary.
const db = useTestDatabase();
const KEY = 'sk-ant-retainer-secret-key';
const SECRET = 'usage-secret-'.padEnd(40, 'x');
const PROXY = 'http://retainer.test/v1/extensions/runtime/model';
const release = modelRelease();
const catalog = new ExtensionCatalog([
  { manifest: release, actorCeiling: 'agent', runtimeEnabled: true },
]);
let t: TestApp,
  upstream: Upstream,
  tokens: RunTokens,
  sign: Awaited<ReturnType<typeof testRunTokens>>['sign'];
let run: {
  workspace: string;
  id: string;
  key: string;
  token: string;
  claims: ModelClaims;
  runToken: string;
};

beforeAll(async () => {
  upstream = await fakeAnthropic();
  ({ tokens, sign } = await testRunTokens());
  t = startTestApp(db, {
    extensionCatalog: catalog,
    runTokens: tokens,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    model: { apiKey: KEY, upstream: upstream.origin },
    modelUsageSecret: SECRET,
  });
  const installed = await installModelRelease(t, db, release);
  const job = await claimRun(t, catalog, installed.workspace, installed.id, PICK);
  expect(job.uses).toEqual(['model']);
  const token = await tokens.issueModel(job);
  run = {
    workspace: installed.workspace,
    id: installed.id,
    key: installed.key,
    token,
    claims: await tokens.verifyModel(token),
    runToken: await tokens.issue(t.sql, job, release.universalId, job.scopes),
  };
});
afterEach(() => upstream.respond(answer));

const message = {
  model: 'claude-opus-5-5',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Which company is acme.test?' }],
};
type AnthropicError = { type: string; message: string };
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: AnthropicError }).error;
const call = (
  body: unknown = message,
  options: {
    path?: string;
    token?: string;
    headers?: Record<string, string>;
    method?: string;
    raw?: string;
  } = {},
): Promise<Response> | Response =>
  t.app.request(`${PROXY}${options.path ?? '/v1/messages'}`, {
    method: options.method ?? 'POST',
    headers: {
      'x-api-key': options.token ?? run.token,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      ...options.headers,
    },
    ...((options.method ?? 'POST') === 'POST' ? { body: options.raw ?? JSON.stringify(body) } : {}),
  });
const rows = () =>
  db.owner<
    Record<string, unknown>[]
  >`select *,input_tokens::int as input_tokens,output_tokens::int as output_tokens,
    cache_read_tokens::int as cache_read_tokens,cache_write_tokens::int as cache_write_tokens
    from ai_usage where installation_id=${run.id} order by created_at`;

describe('admission', () => {
  it('refuses a missing, forged, expired or run token with 401, before reaching Anthropic', async () => {
    const before = upstream.received.length;
    const other = await testRunTokens();
    const now = Math.floor(Date.now() / 1000);
    for (const token of [
      '',
      'rt_model_garbage',
      await other.sign(run.claims, now, now + 60),
      await sign(run.claims, now - 400, now - 100),
      run.runToken,
    ]) {
      const response = await call(message, { token });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        type: 'error',
        error: { type: 'authentication_error', message: expect.any(String) },
      });
    }
    expect(upstream.received.length).toBe(before);
  });

  it("is refused by Retainer's API: a model token opens nothing in a workspace", async () => {
    expect((await t.request('/v1/extensions', { key: run.token })).status).toBe(401);
    expect((await t.request('/v1/objects/company/records', { key: run.token })).status).toBe(401);
  });

  it('answers 503 model_unavailable without a key', async () => {
    const keyless = startTestApp(db, {
      extensionCatalog: catalog,
      runTokens: tokens,
      model: { apiKey: undefined, upstream: upstream.origin },
    });
    const response = await keyless.app.request(`${PROXY}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': run.token },
      body: JSON.stringify(message),
    });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).type).toBe('model_unavailable');
  });
});

describe('forwarding', () => {
  it("swaps in Retainer's key and forwards the body and allowed headers unchanged, and nothing else", async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const raw = `{"model":"claude-opus-5-5",  "max_tokens":100,"messages":[{"role":"user","content":"exact bytes"}]}`;
    const response = await call(undefined, {
      raw,
      headers: {
        'anthropic-beta': 'compact-2026-01-12, server-side-fallback-2026-07-01',
        authorization: 'Bearer something',
        'x-custom': 'leak',
        cookie: 'a=b',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    const sent = upstream.received.at(-1);
    expect(sent?.body).toBe(raw);
    expect(sent?.url).toBe('/v1/messages');
    expect(sent?.headers['x-api-key']).toBe(KEY);
    expect(sent?.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent?.headers['anthropic-beta']).toBe(
      'compact-2026-01-12, server-side-fallback-2026-07-01',
    );
    for (const name of [
      'authorization',
      'x-custom',
      'cookie',
      'anthropic-dangerous-direct-browser-access',
    ])
      expect(sent?.headers[name]).toBeUndefined();
    // The key never comes back or reaches a log; nor does the run's token.
    expect(text).not.toContain(KEY);
    expect([...response.headers.values()].join()).not.toContain(KEY);
    expect(response.headers.get('request-id')).toMatch(/^req_/);
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
      expect(JSON.stringify(spy.mock.calls)).not.toContain('exact bytes');
      spy.mockRestore();
    }
  });

  it('records usage of a plain response: the model that answered, the whole usage object, the request ID, no content', async () => {
    upstream.respond((request, res) => answer(request, res, 'claude-sonnet-5-5'));
    const before = (await rows()).length;
    const response = await call();
    const body = (await response.json()) as { content: { text: string }[] };
    const recorded = await rows();
    expect(recorded.length).toBe(before + 1);
    const row = recorded.at(-1) as Record<string, unknown>;
    expect(row).toMatchObject({
      workspace_id: run.workspace,
      kind: 'model',
      installation_id: run.id,
      registration_id: release.universalId,
      release_digest: run.claims.releaseDigest,
      function_id: PICK,
      job_id: run.claims.jobId,
      attempt: run.claims.attempt,
      model: 'claude-sonnet-5-5',
      input_tokens: 12,
      output_tokens: 7,
      cache_read_tokens: 3,
      cache_write_tokens: 0,
      usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3 },
      provider_request_id: response.headers.get('request-id'),
      partial: false,
    });
    expect(body.content[0]?.text).toBe('hello');
    expect(JSON.stringify(row)).not.toContain('hello');
    expect(JSON.stringify(row)).not.toContain('acme.test');
  });

  it('streams a streamed response as it arrives and records its final counts', async () => {
    let release_: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release_ = resolve;
    });
    upstream.respond(async (_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_stream' });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 20, output_tokens: 1 } } })}\n\n`,
      );
      await gate;
      res.write(
        `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 33 } })}\n\n`,
      );
      res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    });
    const response = await call({ ...message, stream: true });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    // The first event arrives while Anthropic is still generating.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('message_start');
    release_();
    while (!(await reader.read()).done);
    const row = (await rows()).find((r) => r.provider_request_id === 'req_stream');
    expect(row).toMatchObject({ input_tokens: 20, output_tokens: 33, partial: false });
  });

  it('aborts the request to Anthropic when the extension goes away, and records what it saw as partial', async () => {
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_cut' });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 9, output_tokens: 1 } } })}\n\n`,
      );
      // Never ends on its own.
    });
    const aborted = upstream.aborted();
    const response = await call({ ...message, stream: true });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await reader.cancel();
    await aborted;
    const row = (await rows()).find((r) => r.provider_request_id === 'req_cut');
    expect(row).toMatchObject({ input_tokens: 9, output_tokens: 1, partial: true });
  });

  it("stops the request to Anthropic when the model token expires, not at the proxy's longest timeout", async () => {
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_expired' });
      res.write(
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 4, output_tokens: 1 } } })}\n\n`,
      );
      // Never ends on its own.
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await sign(run.claims, now - 10, now + 2);
    const aborted = upstream.aborted();
    const started = Date.now();
    const response = await call({ ...message, stream: true }, { token });
    await response.text().catch(() => undefined);
    await aborted;
    expect(Date.now() - started).toBeLessThan(10_000);
    const row = (await rows()).find((r) => r.provider_request_id === 'req_expired');
    expect(row).toMatchObject({ input_tokens: 4, output_tokens: 1, partial: true });
  });

  it('does not reach Anthropic when the extension went away before the request was forwarded', async () => {
    const before = upstream.received.length;
    const gone = new AbortController();
    gone.abort();
    const response = await t.app.request(`${PROXY}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': run.token,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
      signal: gone.signal,
    });
    expect(response.status).toBe(502);
    expect(upstream.received.length).toBe(before);
  });

  it('records each of several concurrent calls once', async () => {
    const before = (await rows()).length;
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => call(i % 2 ? { ...message, stream: true } : message)),
    );
    await Promise.all(responses.map((r) => r.text()));
    const after = await rows();
    expect(after.length).toBe(before + 6);
    expect(new Set(after.map((r) => r.id)).size).toBe(after.length);
  });

  it('passes provider errors through unchanged and records nothing', async () => {
    upstream.respond((_request, res) => {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '7',
        'request-id': 'req_429',
      });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'slow down' },
        }),
      );
    });
    const before = (await rows()).length;
    const response = await call();
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect((await errorOf(response)).type).toBe('rate_limit_error');
    expect((await rows()).length).toBe(before);
  });

  it('forwards token counting and the models list without recording usage', async () => {
    upstream.respond((_request, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 5, data: [] }));
    });
    const before = (await rows()).length;
    expect((await call(message, { path: '/v1/messages/count_tokens' })).status).toBe(200);
    expect((await call(undefined, { path: '/v1/models', method: 'GET' })).status).toBe(200);
    expect(
      (await call(undefined, { path: '/v1/models/claude-opus-5-5', method: 'GET' })).status,
    ).toBe(200);
    expect(upstream.received.at(-1)?.url).toBe('/v1/models/claude-opus-5-5');
    expect((await rows()).length).toBe(before);
  });
});

describe('allowed requests (spec 3.2.1)', () => {
  it('refuses other paths with 404, without reaching Anthropic', async () => {
    const before = upstream.received.length;
    for (const [method, path] of [
      ['POST', '/v1/files'],
      ['GET', '/v1/files/file_1/content'],
      ['POST', '/v1/messages/batches'],
      ['GET', '/v1/skills'],
      ['POST', '/v1/agents'],
      ['GET', '/v1/organizations/usage_report/messages'],
    ] as const) {
      const response = await call(message, { path, method });
      expect(response.status).toBe(404);
      expect((await errorOf(response)).type).toBe('not_found_error');
    }
    expect(upstream.received.length).toBe(before);
  });

  it('refuses stored-state fields, unknown fields, file sources and unlisted betas with 400 naming them, on both Messages paths', async () => {
    const before = upstream.received.length;
    for (const path of ['/v1/messages', '/v1/messages/count_tokens']) {
      for (const field of ['container', 'thread', 'diagnostics', 'brand_new_field']) {
        const response = await call({ ...message, [field]: 'x' }, { path });
        expect(response.status).toBe(400);
        expect(await errorOf(response)).toMatchObject({
          type: 'invalid_request_error',
          message: expect.stringContaining(field),
        });
      }
      const file = { type: 'document', source: { type: 'file', file_id: 'file_other_workspace' } };
      for (const content of [
        [file],
        [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [file] }],
      ]) {
        const response = await call(
          { ...message, messages: [{ role: 'user', content }] },
          { path },
        );
        expect(response.status).toBe(400);
      }
      for (const beta of ['files-api-2025-04-14', 'compact-2026-01-12,files-api-2025-04-14']) {
        const response = await call(message, { path, headers: { 'anthropic-beta': beta } });
        expect(response.status).toBe(400);
        expect((await errorOf(response)).message).toContain('files-api-2025-04-14');
      }
    }
    expect(upstream.received.length).toBe(before);
  });

  it('refuses a body over 6 MB with 413', async () => {
    const response = await call(undefined, { raw: 'x'.repeat(MAX_REQUEST_BYTES + 1) });
    expect(response.status).toBe(413);
    expect((await errorOf(response)).type).toBe('request_too_large');
  });
});

describe('the official SDK', () => {
  const sdk = (apiKey: string) =>
    new Anthropic({
      baseURL: PROXY,
      apiKey,
      authToken: null,
      maxRetries: 0,
      fetch: t.inProcessFetch as typeof fetch,
    });

  it('creates messages through the proxy, plain and streamed', async () => {
    const plain = await sdk(run.token).messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(plain.content[0]).toMatchObject({ type: 'text', text: 'hello' });
    const streamed = await sdk(run.token)
      .messages.stream({
        model: 'claude-opus-5-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      })
      .finalMessage();
    expect(streamed.usage.output_tokens).toBe(7);
  });

  it('raises its typed errors for the errors the proxy adds', async () => {
    await expect(
      sdk('rt_model_bad').messages.create({ model: 'm', max_tokens: 1, messages: [] }),
    ).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
    await expect(
      sdk(run.token).messages.create({
        model: 'm',
        max_tokens: 1,
        messages: [],
        container: 'container_1',
      } as never),
    ).rejects.toBeInstanceOf(Anthropic.BadRequestError);
  });
});

describe('the self-hosted recorder', () => {
  it('retries a failed insert, then logs the ID and counts, no content', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Nothing listens on port 1: every insert fails to connect.
    const down = postgres('postgres://retainer@127.0.0.1:1/retainer', {
      connect_timeout: 1,
      max: 1,
    });
    const report = {
      id: randomUUID(),
      model: 'claude-opus-5-5',
      providerRequestId: 'req_lost',
      partial: false,
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usage: { input_tokens: 5, output_tokens: 6 },
      at: new Date().toISOString(),
    };
    await recordDirectly(down, 1)(run.token, run.claims, report);
    await down.end({ timeout: 0 });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain(report.id);
    expect(logged).toContain('input 5, output 6');
    expect(logged).not.toContain(run.token);
    error.mockRestore();
  });
});

describe('the usage report route (spec 3.6)', () => {
  const report = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    token: run.token,
    model: 'claude-opus-5-5',
    providerRequestId: 'req_report',
    partial: false,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usage: { input_tokens: 100, output_tokens: 50 },
    at: new Date().toISOString(),
    ...overrides,
  });
  const send = (body: unknown, secret: string | null = SECRET) =>
    t.request('/v1/extensions/internal/ai-usage', {
      body,
      ...(secret === null ? {} : { headers: { authorization: `Bearer ${secret}` } }),
    });
  const count = async (id: string) =>
    (await db.owner<{ n: number }[]>`select count(*)::int as n from ai_usage where id=${id}`)[0]?.n;

  it('needs both the secret and a model token', async () => {
    const body = report();
    expect((await send(body, null)).status).toBe(401);
    expect((await send(body, 'wrong'.padEnd(40, 'x'))).status).toBe(401);
    expect((await send({ ...body, token: 'rt_model_bad' })).status).toBe(401);
    expect((await send({ ...body, token: run.runToken })).status).toBe(401);
    expect(await count(body.id)).toBe(0);
    expect((await send(body)).status).toBe(200);
    expect(await count(body.id)).toBe(1);
  });

  it('takes every ID from the token, and refuses IDs in the body', async () => {
    const body = report();
    expect(
      (await send({ ...body, workspaceId: randomUUID(), installationId: randomUUID() })).status,
    ).toBe(400);
    expect(await count(body.id)).toBe(0);
    await send(body);
    const [row] = await db.owner`select * from ai_usage where id=${body.id}`;
    expect(row).toMatchObject({
      workspace_id: run.workspace,
      installation_id: run.id,
      job_id: run.claims.jobId,
      function_id: PICK,
    });
  });

  it('accepts a token up to 15 minutes past its expiry, and refuses an older one', async () => {
    const now = Math.floor(Date.now() / 1000);
    const recent = await sign(run.claims, now - 14 * 60 - 60, now - 14 * 60);
    const old = await sign(run.claims, now - 16 * 60 - 60, now - 16 * 60);
    expect((await send(report({ token: recent }))).status).toBe(200);
    expect((await send(report({ token: old }))).status).toBe(401);
  });

  it('writes one row for a repeated report, including concurrent ones', async () => {
    const body = report();
    const results = await Promise.all(Array.from({ length: 5 }, () => send(body)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect((await send(body)).status).toBe(200);
    expect(await count(body.id)).toBe(1);
  });

  it('is not mounted without the secret: the request meets the ordinary caller chain', async () => {
    const plain = startTestApp(db, { extensionCatalog: catalog, runTokens: tokens });
    const body = report();
    const response = await plain.request('/v1/extensions/internal/ai-usage', {
      body,
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(response.status).toBe(401);
    expect(await count(body.id)).toBe(0);
  });
});

describe('reading usage', () => {
  it("shows an installation's model use this month to its workspace", async () => {
    const response = await call();
    await response.text();
    const recorded = await rows();
    const usage = await t.request(`/v1/extensions/${run.id}/usage`, { key: run.key });
    expect(usage.status).toBe(200);
    expect(usage.body.model).toEqual({
      month: new Date().toISOString().slice(0, 7),
      requests: recorded.length,
      inputTokens: recorded.reduce((n, r) => n + Number(r.input_tokens), 0),
      outputTokens: recorded.reduce((n, r) => n + Number(r.output_tokens), 0),
      cacheReadTokens: recorded.reduce((n, r) => n + Number(r.cache_read_tokens), 0),
      cacheWriteTokens: recorded.reduce((n, r) => n + Number(r.cache_write_tokens), 0),
    });
    // A run credential or another workspace can't read it.
    expect((await t.request(`/v1/extensions/${run.id}/usage`, { key: run.runToken })).status).toBe(
      404,
    );
    const other = await t.setupWorkspace(
      { name: `Other ${randomUUID()}` },
      { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
    );
    expect(
      (await t.request(`/v1/extensions/${run.id}/usage`, { key: other.keys.admin })).status,
    ).toBe(404);
  });

  it('gives the operator totals per day', async () => {
    const out: string[] = [];
    const code = await runCli(['model', 'usage', '--days', '2', '--json'], {
      sql: db.owner,
      out: (line) => out.push(line),
      err: () => {},
    });
    expect(code).toBe(0);
    const days = JSON.parse(out.join('\n')) as { day: string; kind: string; requests: number }[];
    const total = (await rows()).length;
    expect(days.reduce((n, d) => n + d.requests, 0)).toBeGreaterThanOrEqual(total);
    expect(days[0]).toMatchObject({
      kind: 'model',
      day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(
      await runCli(['model', 'usage', '--days', '0'], {
        sql: db.owner,
        out: () => {},
        err: () => {},
      }),
    ).toBe(1);
  });
});
