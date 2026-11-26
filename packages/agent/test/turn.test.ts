import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeApi } from '../src/api-client.js';
import { listSessionMessages } from '../src/history.js';
import { setLogSink } from '../src/logger.js';
import { createMastraStore } from '../src/store.js';
import { runTurn, type TurnOutcome } from '../src/turn.js';
import { createMastraTestDatabase, type MastraTestDatabase } from './db.js';
import { type FakeAnswer, FakeAnthropic } from './fake-anthropic.js';
import { FakeApi, RUNTIME_SECRET } from './fake-api.js';

let db: MastraTestDatabase;
let anthropic: FakeAnthropic;
let api: FakeApi;
let client: RuntimeApi;
const logs: string[] = [];
const FAKE_KEY = 'sk-ant-test-key-should-never-be-logged';

let anthropicServer: FakeAnthropic;

beforeAll(async () => {
  db = await createMastraTestDatabase();
  setLogSink((line) => logs.push(line));
  // One upstream for the file: Mastra's model router keeps the base URL it
  // first resolved.
  anthropicServer = await new FakeAnthropic().start();
  process.env.ANTHROPIC_BASE_URL = anthropicServer.url;
  process.env.ANTHROPIC_API_KEY = FAKE_KEY;
});
afterAll(async () => {
  await anthropicServer?.stop();
  await db?.drop();
});
beforeEach(async () => {
  anthropicServer.reset();
  anthropic = anthropicServer;
  api = await new FakeApi().start();
  client = new RuntimeApi({ origin: api.url, runtimeSecret: RUNTIME_SECRET });
});
afterEach(async () => {
  await api.stop();
});

const thinking = (n: number) => ({
  type: 'thinking' as const,
  thinking: `thought ${n}`,
  signature: `sig-${n}`,
});

async function turn(
  sessionId: string,
  text: string,
  options: { pollIntervalMs?: number } = {},
): Promise<{ outcome: TurnOutcome; sse: string; chunks: Array<Record<string, unknown>> }> {
  const claim = await client.claim(sessionId, { streamToken: 'stream-token', title: text });
  const running = await runTurn(
    { api: client, mastraUrl: db.mastraUrl, pollIntervalMs: options.pollIntervalMs },
    { claim, text },
  );
  const sse = await new Response(running.stream).text();
  const outcome = await running.done;
  const chunks = sse
    .split('\n\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
  return { outcome, sse, chunks };
}

const toolStep: FakeAnswer = {
  blocks: [
    thinking(1),
    { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'acme' } },
  ],
  stopReason: 'tool_use',
  usage: { input_tokens: 40, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 },
};
const answerStep = (text = 'Acme raised a seed round.', n = 2): FakeAnswer => ({
  blocks: [thinking(n), { type: 'text', text }],
  stopReason: 'end_turn',
});

describe('a chat turn', () => {
  it('saves the message first, streams the steps, reports each one and closes', async () => {
    const sessionId = crypto.randomUUID();
    anthropic.enqueue(toolStep, answerStep());
    const { outcome, chunks } = await turn(sessionId, 'What do we know about Acme?');
    expect(outcome).toEqual({ status: 'completed', errorCode: null, steps: 2 });

    // The request shape (spec §3.4, §3.5, §10.1).
    const first = anthropic.requests[0]!;
    expect(first.body.model).toBe('claude-sonnet-5-5');
    expect(first.body.max_tokens).toBe(32000);
    expect(first.body.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    });
    expect(first.body.output_config).toEqual({ effort: 'medium' });
    expect(first.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(first.body.fallbacks).toBeUndefined();
    expect(first.body.context_management).toBeUndefined();
    expect(String(first.headers['anthropic-beta'])).toContain(
      'thinking-binding-controls-2026-08-01',
    );
    expect(first.headers['x-api-key']).toBe(FAKE_KEY);
    const system = first.body.system as Array<Record<string, unknown>>;
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const tools = first.body.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).toEqual(['search', 'web_search', 'web_fetch']);
    expect(tools.find((t) => t.name === 'web_search')).toMatchObject({
      type: 'web_search_20260209',
      max_uses: 10,
    });
    expect(tools.find((t) => t.name === 'web_fetch')).toMatchObject({
      type: 'web_fetch_20260209',
      max_uses: 10,
    });
    // The person's message and the server-added context go to the model.
    const userContent = (first.body.messages as Array<{ content: Array<{ text?: string }> }>)[0]!
      .content;
    expect(userContent.map((c) => c.text)).toEqual([
      'What do we know about Acme?',
      api.addedParts[0],
    ]);

    // The tool went through the runtime route with the turn token.
    const toolCalls = api.ofPath('/tools/search');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]!.auth).toBe(api.turnToken);
    expect(toolCalls[0]!.body).toMatchObject({ toolCallId: 'toolu_1', input: { query: 'acme' } });

    // Step usage maps to the report's columns (spec §15, Limits).
    const reports = api.ofPath('/report').map((call) => call.body as Record<string, unknown>);
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({
      usage: { input: 40, cacheRead: 500, cacheWrite: 20, output: 5 },
      webSearches: 0,
      webFetches: 0,
      toolCalls: 1,
      finishReason: 'tool-calls',
      rawFinishReason: 'tool_use',
    });
    expect(reports[1]).toMatchObject({ rawFinishReason: 'end_turn', toolCalls: 0 });
    expect(new Set(reports.map((r) => r.stepId)).size).toBe(2);
    expect(api.ofPath('/close').map((c) => c.body)).toEqual([
      expect.objectContaining({ status: 'completed', errorCode: null }),
    ]);

    // The stream: received first, reasoning, the tool, the answer; no server-added text.
    expect(chunks[0]).toMatchObject({ type: 'data-received' });
    const types = chunks.map((c) => c.type);
    expect(types).toContain('reasoning-delta');
    expect(types).toContain('tool-output-available');
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta)).toEqual([
      'Acme raised a seed round.',
    ]);
    expect(JSON.stringify(chunks)).not.toContain(api.addedParts[0]);
    expect(types.at(-1)).toBe('finish');

    // The history: one user message (saved once), the thinking with its signature.
    const handle = createMastraStore({ connectionString: db.mastraUrl });
    try {
      const stored = await listSessionMessages(handle, sessionId);
      expect(stored.filter((m) => m.role === 'user')).toHaveLength(1);
      const memory = await handle.store.getStore('memory');
      const thread = await memory!.getThreadById({ threadId: sessionId });
      expect(thread?.title).toBe('What do we know about Acme?');
      expect(JSON.stringify(stored)).toContain('sig-1');
    } finally {
      await handle.close();
    }
  });

  it('replays the whole history with signatures, the request only growing (caching)', async () => {
    const sessionId = crypto.randomUUID();
    anthropic.enqueue(toolStep, answerStep('First.', 2));
    await turn(sessionId, 'First question');
    anthropic.enqueue(answerStep('Second.', 3));
    await turn(sessionId, 'Second question');
    const [r1, r2, r3] = anthropic.requests.map((r) => r.body);
    // Tools and system are byte-identical on every request.
    for (const r of [r2, r3]) {
      expect(JSON.stringify(r!.tools)).toBe(JSON.stringify(r1!.tools));
      expect(JSON.stringify(r!.system)).toBe(JSON.stringify(r1!.system));
    }
    // Each request's messages start with the previous one's, unchanged.
    const m2 = r2!.messages as unknown[];
    const m3 = r3!.messages as unknown[];
    expect(JSON.stringify(m3.slice(0, m2.length))).toBe(JSON.stringify(m2));
    // The first turn's thinking goes back with its signature.
    expect(JSON.stringify(m3)).toContain('"signature":"sig-1"');
    expect(JSON.stringify(m3)).toContain('"signature":"sig-2"');
    // A later turn of the same day carries the API's added parts only when given.
    expect(r3!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it.each([
    ['max_tokens', 'incomplete'],
    ['model_context_window_exceeded', 'context_limit_reached'],
    ['refusal', 'refused'],
  ])('ends on %s as %s, never as a finished answer', async (stopReason, status) => {
    anthropic.enqueue({ blocks: [{ type: 'text', text: 'Partial' }], stopReason });
    const { outcome, chunks } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome.status).toBe(status);
    expect(chunks.find((c) => c.type === 'data-turn-end')).toMatchObject({ data: { status } });
    expect(api.ofPath('/close')[0]!.body).toMatchObject({ status });
  });

  it.each([
    [
      400,
      'invalid_request_error',
      'prompt is too long: 1000001 tokens > 1000000 maximum',
      'context_limit_reached',
    ],
    [
      413,
      'request_too_large',
      'Request exceeds the maximum allowed number of bytes.',
      'context_limit_reached',
    ],
    [
      400,
      'invalid_request_error',
      'messages.1.content.0: Invalid `signature` in `thinking` block',
      'history_rejected',
    ],
  ])('maps an HTTP %s (%s) to %s', async (statusCode, type, message, status) => {
    anthropic.enqueue({ error: { status: statusCode, type, message } });
    const { outcome } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome.status).toBe(status);
    expect(anthropic.requests).toHaveLength(1);
  });

  it('continues across pause_turn within the limits', async () => {
    anthropic.enqueue(
      { blocks: [thinking(1), { type: 'text', text: 'Searching…' }], stopReason: 'pause_turn' },
      answerStep('Done.', 2),
    );
    const { outcome } = await turn(crypto.randomUUID(), 'Look it up');
    expect(outcome.status).toBe('completed');
    expect(anthropic.requests).toHaveLength(2);
  });

  it('ends a pause_turn past the step limit as incomplete', async () => {
    api.limits = { ...api.limits, maxSteps: 1 };
    anthropic.enqueue({ blocks: [{ type: 'text', text: 'Searching…' }], stopReason: 'pause_turn' });
    const { outcome } = await turn(crypto.randomUUID(), 'Look it up');
    expect(outcome).toMatchObject({ status: 'incomplete', errorCode: 'pause_turn' });
  });

  it('retries a 529 twice and counts the step once', async () => {
    anthropic.enqueue(
      { error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } },
      { error: { status: 529, type: 'overloaded_error', message: 'Overloaded' } },
      answerStep(),
    );
    const { outcome } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome.status).toBe('completed');
    expect(anthropic.requests).toHaveLength(3);
    expect(api.ofPath('/report')).toHaveLength(1);
  }, 30_000);

  it.each([
    [529, 'overloaded_error'],
    [429, 'rate_limit_error'],
  ])(
    'ends as model_unavailable when %s keeps coming',
    async (status, type) => {
      for (let i = 0; i < 3; i++) anthropic.enqueue({ error: { status, type, message: 'busy' } });
      const { outcome } = await turn(crypto.randomUUID(), 'Hello');
      expect(outcome.status).toBe('model_unavailable');
      expect(anthropic.requests).toHaveLength(3);
      expect(api.ofPath('/report')).toHaveLength(0);
    },
    30_000,
  );

  it('never resends a response that has started to stream', async () => {
    anthropic.enqueue({ ...answerStep(), dropAfterEvents: 3 }, answerStep());
    const { outcome, chunks } = await turn(crypto.randomUUID(), 'Hello');
    console.log(
      'DBG',
      anthropic.requests.length,
      JSON.stringify(outcome),
      JSON.stringify(chunks).slice(0, 1500),
    );
    expect(anthropic.requests).toHaveLength(1);
    expect(outcome.status).not.toBe('completed');
  });

  it('waits for a slow report and sends no further request on stop', async () => {
    api.reportAnswer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { action: 'stop', reason: 'limit_reached' };
    };
    anthropic.enqueue(toolStep, answerStep());
    const { outcome } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome.status).toBe('limit_reached');
    expect(anthropic.requests).toHaveLength(1);
  });

  it('keeps a finished answer on the last allowed step', async () => {
    api.reportAnswer = () => ({ action: 'stop', reason: 'limit_reached' });
    anthropic.enqueue(answerStep());
    const { outcome } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome.status).toBe('completed');
  });

  it('ends the turn when a report cannot be made', async () => {
    api.reportStatus = 500;
    anthropic.enqueue(toolStep, answerStep());
    const { outcome } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'report_failed' });
    expect(anthropic.requests).toHaveLength(1);
  });

  it('aborts a silent model request when the poll sees a cancel', async () => {
    anthropic.enqueue({ ...answerStep(), delayMs: 5_000 });
    setTimeout(() => {
      api.turnState = { status: 'cancelled', current: true };
    }, 200);
    const started = Date.now();
    const { outcome } = await turn(crypto.randomUUID(), 'Hello', { pollIntervalMs: 100 });
    expect(outcome.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(api.ofPath('/close')[0]!.body).toMatchObject({ status: 'cancelled' });
  });

  it('ends the turn on turn_cancelled from a tool call; Mastra goes no further', async () => {
    api.toolAnswer = () => 'fenced';
    anthropic.enqueue(toolStep, answerStep());
    const { outcome } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome.status).toBe('cancelled');
    expect(anthropic.requests).toHaveLength(1);
  });

  it('lets no tool call past the cap run, parallel calls included', async () => {
    api.limits = { ...api.limits, maxToolCalls: 1 };
    anthropic.enqueue(
      {
        blocks: [
          thinking(1),
          { type: 'tool_use', id: 'toolu_a', name: 'search', input: { query: 'a' } },
          { type: 'tool_use', id: 'toolu_b', name: 'search', input: { query: 'b' } },
        ],
        stopReason: 'tool_use',
      },
      answerStep(),
    );
    await turn(crypto.randomUUID(), 'Hello');
    expect(api.ofPath('/tools/search')).toHaveLength(1);
  });

  it('asks again while an extension tool call is pending, with the same toolCallId', async () => {
    let calls = 0;
    api.toolAnswer = () => (++calls < 3 ? { pending: true } : { ok: true, output: { found: 1 } });
    anthropic.enqueue(toolStep, answerStep());
    const { outcome } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome.status).toBe('completed');
    const toolCalls = api.ofPath('/tools/search');
    expect(toolCalls).toHaveLength(3);
    expect(new Set(toolCalls.map((c) => (c.body as { toolCallId: string }).toolCallId)).size).toBe(
      1,
    );
    expect(JSON.stringify(anthropic.requests[1]!.body.messages)).toContain('found');
  });

  it('turns a tool error result into a result for the model', async () => {
    api.toolAnswer = () => ({
      ok: false,
      error: { code: 'elevation_required', message: 'Run retainer elevate.' },
    });
    anthropic.enqueue(toolStep, answerStep());
    const { outcome } = await turn(crypto.randomUUID(), 'Hello');
    expect(outcome.status).toBe('completed');
    const second = JSON.stringify(anthropic.requests[1]!.body.messages);
    expect(second).toContain('elevation_required');
  });

  it('counts the full web allowance only when a step that searched has no counts', async () => {
    anthropic.enqueue({
      blocks: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'acme' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
        { type: 'text', text: 'Nothing found.' },
      ],
      stopReason: 'end_turn',
    });
    await turn(crypto.randomUUID(), 'Search the web');
    const [report] = api.ofPath('/report').map((c) => c.body as Record<string, unknown>);
    expect(report).toMatchObject({ webSearches: null, webFetches: 0 });
  });

  it('uses the web counts Anthropic sends, zeros included', async () => {
    anthropic.enqueue({
      ...answerStep(),
      usage: { server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 } },
    });
    await turn(crypto.randomUUID(), 'Search the web');
    const [report] = api.ofPath('/report').map((c) => c.body as Record<string, unknown>);
    expect(report).toMatchObject({ webSearches: 3, webFetches: 0 });
  });

  it('refuses nothing when the API refuses the claim, and starts no model request', async () => {
    api.claimError = { status: 409, code: 'turn_running' };
    await expect(client.claim(crypto.randomUUID(), { streamToken: 's' })).rejects.toMatchObject({
      status: 409,
      code: 'turn_running',
    });
    expect(anthropic.requests).toHaveLength(0);
  });

  it('keeps no token, key or password in Mastra tables or logs', async () => {
    anthropic.enqueue(toolStep, answerStep());
    await turn(crypto.randomUUID(), 'Hello sentinel-content-7f3a');
    const password = new URL(db.mastraUrl).password;
    const { rows } = await db.query(
      `select string_agg(t::text, ' ') as dump from (
         select row_to_json(m)::text as t from mastra.mastra_messages m
         union all select row_to_json(t)::text from mastra.mastra_threads t
         union all select row_to_json(r)::text from mastra.mastra_resources r
         union all select row_to_json(w)::text from mastra.mastra_workflow_snapshot w
       ) x`,
    );
    const dump = String(rows[0]?.dump ?? '');
    for (const secret of [api.turnToken, FAKE_KEY, password, RUNTIME_SECRET, 'stream-token']) {
      expect(dump).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
    expect(logs.join('\n')).not.toContain('sentinel-content-7f3a');
  });

  it('logs no content from a normal provider failure', async () => {
    anthropic.enqueue({
      error: { status: 400, type: 'invalid_request_error', message: 'bad sentinel-error-9c1d' },
    });
    await turn(crypto.randomUUID(), 'Hello sentinel-content-55aa');
    expect(logs.join('\n')).not.toContain('sentinel-error-9c1d');
    expect(logs.join('\n')).not.toContain('sentinel-content-55aa');
  });
});
