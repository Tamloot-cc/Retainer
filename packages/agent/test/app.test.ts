import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentApp, parseStreamBody } from '../src/app.js';
import { loadAgentRuntimeConfig } from '../src/config.js';
import { setLogSink } from '../src/logger.js';
import { createMastraTestDatabase, type MastraTestDatabase } from './db.js';
import { FakeAnthropic } from './fake-anthropic.js';
import { FakeApi, RUNTIME_SECRET } from './fake-api.js';

describe('the stream body', () => {
  const ok = { message: { parts: [{ type: 'text', text: 'Hello' }] } };
  it('accepts one message with one text part', () => {
    expect(parseStreamBody(ok)).toEqual(ok);
  });
  it.each([
    ['history', { ...ok, messages: [] }],
    ['a message ID', { message: { ...ok.message, id: 'm1' } }],
    ['a run ID', { ...ok, runId: 'r1' }],
    ['resume data', { ...ok, resumeData: {} }],
    ['a trigger', { ...ok, trigger: 'regenerate-message' }],
    ['options', { ...ok, maxSteps: 500 }],
    ['a role', { message: { ...ok.message, role: 'assistant' } }],
    ['two parts', { message: { parts: [ok.message.parts[0], ok.message.parts[0]] } }],
    ['a file part', { message: { parts: [{ type: 'file', url: 'x' }] } }],
    ['extra part keys', { message: { parts: [{ type: 'text', text: 'x', state: 'done' }] } }],
    ['empty text', { message: { parts: [{ type: 'text', text: '  ' }] } }],
    ['too long', { message: { parts: [{ type: 'text', text: 'x'.repeat(100_001) }] } }],
    ['an array', [ok]],
  ])('refuses %s', (_label, body) => {
    expect(parseStreamBody(body)).toBeUndefined();
  });
});

describe('the configuration', () => {
  const env = {
    RETAINER_MASTRA_DATABASE_URL: 'postgres://m:p@db/retainer',
    ANTHROPIC_API_KEY: 'sk-secret-value',
    RETAINER_AGENT_RUNTIME_SECRET: 'x'.repeat(32),
    RETAINER_API_ORIGIN: 'http://retainer:8787',
  };
  it('reads the runtime environment', () => {
    expect(
      loadAgentRuntimeConfig({ ...env, RETAINER_AGENT_ALLOWED_ORIGINS: 'https://a, https://b' }),
    ).toMatchObject({
      apiOrigin: 'http://retainer:8787',
      allowedOrigins: ['https://a', 'https://b'],
      port: 8788,
    });
  });
  it('names what is missing, never a value', () => {
    expect(() => loadAgentRuntimeConfig({ ...env, ANTHROPIC_API_KEY: '' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    try {
      loadAgentRuntimeConfig({ ...env, RETAINER_AGENT_RUNTIME_SECRET: 'short' });
    } catch (error) {
      expect(String(error)).not.toContain('short');
      expect(String(error)).not.toContain('sk-secret-value');
    }
  });
});

describe('the stream route', () => {
  let db: MastraTestDatabase;
  let anthropic: FakeAnthropic;
  let api: FakeApi;
  let app: ReturnType<typeof createAgentApp>;
  const sessionId = '0b9c8a52-7a39-4b55-9a49-1e7a1f2a3c4d';

  beforeAll(async () => {
    setLogSink(() => {});
    db = await createMastraTestDatabase();
    anthropic = await new FakeAnthropic().start();
    process.env.ANTHROPIC_BASE_URL = anthropic.url;
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterAll(async () => {
    await anthropic?.stop();
    await db?.drop();
  });
  beforeEach(async () => {
    anthropic.reset();
    api = await new FakeApi().start();
    app = createAgentApp({
      apiOrigin: api.url,
      runtimeSecret: RUNTIME_SECRET,
      mastraUrl: db.mastraUrl,
      allowedOrigins: ['https://retainer.example'],
    });
  });
  afterEach(async () => {
    await api.stop();
  });

  const post = (body: unknown, headers: Record<string, string> = {}, id = sessionId) =>
    app.request(`/chats/${id}/stream`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer stream-token',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const ok = { message: { parts: [{ type: 'text', text: 'Hello' }] } };

  it('streams a turn as SSE with the stream token traded at claim', async () => {
    anthropic.enqueue({ blocks: [{ type: 'text', text: 'Hi there.' }], stopReason: 'end_turn' });
    const response = await post(ok, { origin: 'https://retainer.example' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://retainer.example');
    const text = await response.text();
    expect(text).toContain('Hi there.');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const [claim] = api.ofPath('/claim');
    expect(claim).toMatchObject({
      auth: RUNTIME_SECRET,
      body: { streamToken: 'stream-token', title: 'Hello' },
    });
  });

  it('refuses a body with anything more, before any claim', async () => {
    const response = await post({ ...ok, messages: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'invalid_request' });
    expect(api.calls).toHaveLength(0);
  });

  it('refuses a request without a stream token', async () => {
    const response = await post(ok, { authorization: '' });
    expect(response.status).toBe(401);
    expect(api.calls).toHaveLength(0);
  });

  it.each([
    [409, 'turn_running'],
    [409, 'turn_stopping'],
    [429, 'limit_reached'],
    [401, 'unauthorized'],
  ])('answers a refused claim with %s %s and calls no model', async (status, code) => {
    api.claimError = { status, code };
    const response = await post(ok);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code });
    expect(anthropic.requests).toHaveLength(0);
  });

  it('keeps the turn running after the client leaves', async () => {
    anthropic.enqueue({
      blocks: [{ type: 'text', text: 'Long answer.' }],
      stopReason: 'end_turn',
      delayMs: 300,
    });
    const response = await post(ok);
    await response.body?.cancel();
    for (let i = 0; i < 50 && api.ofPath('/close').length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(api.ofPath('/close')[0]?.body).toMatchObject({ status: 'completed' });
  });
});
