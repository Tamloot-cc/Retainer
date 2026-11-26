import { RETAINER_TOOL_NAMES } from '@retainer/agent';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  mastraRows,
  RUNTIME_SECRET,
  saveChatHistory,
  seedMastra,
  total,
} from '../helpers/agent.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: { writer: string; reader: string; other: string; second: string; admin: string };
let workspaceId: string;

beforeAll(async () => {
  t = startTestApp(db, {
    agent: { runtimeSecret: RUNTIME_SECRET, readStoreUrl: db.url, personDailySteps: 2000 },
  });
  const sales = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      writer: { actor: { type: 'agent', id: 'desk', name: 'Desk' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'agent', id: 'reader' }, scopes: ['read'] },
      second: { actor: { type: 'agent', id: 'second' }, scopes: ['read', 'write'] },
      admin: { actor: { type: 'user', id: 'ada', name: 'Ada' }, scopes: ['admin'] },
    },
  );
  const other = await t.setupWorkspace(
    { name: 'Other' },
    { other: { actor: { type: 'agent', id: 'other' }, scopes: ['read', 'write'] } },
  );
  workspaceId = sales.workspace.id;
  keys = { ...sales.keys, other: other.keys.other };
});

const runtimeBase = (id: string) => `/v1/agent/runtime/sessions/${id}`;

async function newChat(key = keys.writer) {
  const created = await t.request<{ id: string }>('/v1/agent/chats', { key, method: 'POST' });
  expect(created.status).toBe(201);
  return created.body.id;
}
async function streamToken(id: string, key = keys.writer) {
  const res = await t.request<{ token: string; streamUrl: string }>(`/v1/agent/chats/${id}/token`, {
    key,
    method: 'POST',
  });
  expect(res.status).toBe(200);
  return res.body;
}
function claim(id: string, token: string, body: Record<string, unknown> = {}) {
  return t.request(`${runtimeBase(id)}/claim`, {
    key: RUNTIME_SECRET,
    body: { streamToken: token, ...body },
  });
}
async function claimed(id: string, key = keys.writer, body: Record<string, unknown> = {}) {
  const { token } = await streamToken(id, key);
  const res = await claim(id, token, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as {
    turnToken: string;
    turnId: string;
    generation: number;
    runId: string;
    deadline: string;
    session: {
      firstTurn: boolean;
      tools: { kind: string; name: string }[];
      systemBlocks: string[];
    };
    addedParts: string[];
    limits: Record<string, number>;
  };
}
const runtime = (id: string, turnToken: string, path: string, body?: unknown) =>
  t.request(`${runtimeBase(id)}${path}`, {
    key: turnToken,
    ...(body === undefined ? {} : { body }),
  });
const report = (
  id: string,
  turnToken: string,
  stepId: string,
  extra: Record<string, unknown> = {},
) =>
  runtime(id, turnToken, '/report', {
    stepId,
    usage: { input: 40, cacheRead: 500, cacheWrite: 20, output: 7 },
    webSearches: 0,
    toolCalls: 1,
    finishReason: 'tool-calls',
    ...extra,
  });
const close = (id: string, turnToken: string, status = 'completed') =>
  runtime(id, turnToken, '/close', { status, errorCode: null, durationMs: 1000 });

describe('chats', () => {
  it('pins the Retainer tools, web search and the base prompt on a new chat', async () => {
    const id = await newChat();
    const [row] = await db.owner<
      { tools: { kind: string; name: string }[]; system_blocks: string[]; owner: string }[]
    >`select tools, system_blocks, owner from agent_sessions where id = ${id}`;
    expect(row?.owner).toBe('key:desk');
    expect(row?.tools.map((tool) => tool.name)).toEqual([...RETAINER_TOOL_NAMES, 'web_search']);
    expect(row?.tools.some((tool) => tool.kind === 'extension')).toBe(false);
    expect(row?.system_blocks).toHaveLength(1);

    const list = await t.request('/v1/agent/chats', { key: keys.writer });
    expect(list.body.chats.map((chat: { id: string }) => chat.id)).toContain(id);
    expect(list.body.chats[0]).toMatchObject({ status: 'idle', title: '' });
  });

  it('keeps chats to their owner', async () => {
    const id = await newChat();
    for (const key of [keys.second, keys.other]) {
      expect((await t.request(`/v1/agent/chats/${id}`, { key })).status).toBe(404);
      expect((await t.request(`/v1/agent/chats/${id}/token`, { key, method: 'POST' })).status).toBe(
        404,
      );
      expect((await t.request(`/v1/agent/chats/${id}`, { key, method: 'DELETE' })).status).toBe(
        404,
      );
    }
    const list = await t.request('/v1/agent/chats', { key: keys.second });
    expect(list.body.chats.map((chat: { id: string }) => chat.id)).not.toContain(id);
  });

  it('reads a chat without the parts the server added', async () => {
    const id = await newChat();
    await saveChatHistory(db.url, id, 'Who is Dana?');
    const res = await t.request(`/v1/agent/chats/${id}`, { key: keys.writer });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.messages)).toContain('Who is Dana?');
    expect(JSON.stringify(res.body.messages)).not.toContain('Today is');
    expect(res.body).toMatchObject({ id, running: false });
  });

  it('deletes a chat and erases every Mastra table for it, leaving another chat whole', async () => {
    const gone = await newChat();
    const kept = await newChat();
    const goneTurn = await claimed(gone);
    const keptTurn = await claimed(kept);
    await seedMastra(db.owner, gone, goneTurn.runId);
    await seedMastra(db.owner, kept, keptTurn.runId);
    const before = await mastraRows(db.owner, [gone], [goneTurn.runId]);
    expect(Object.values(before).every((count) => count > 0)).toBe(true);

    const goneToken = await streamToken(gone);
    const deleted = await t.request(`/v1/agent/chats/${gone}`, {
      key: keys.writer,
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    expect(total(await mastraRows(db.owner, [gone], [goneTurn.runId]))).toBe(0);
    const keptRows = await mastraRows(db.owner, [kept], [keptTurn.runId]);
    expect(Object.values(keptRows).every((count) => count > 0)).toBe(true);
    // The running turn stays fenced as cancelled until its runtime stops
    // (spec §6.5): the poll sees the cancel, and a step under way still counts.
    const state = await runtime(gone, goneTurn.turnToken, '/turn');
    expect(state.body).toMatchObject({ status: 'cancelled' });
    const late = await report(gone, goneTurn.turnToken, 'late-step');
    expect(late.body).toEqual({ action: 'stop', reason: 'cancelled' });
    const [usage] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from ai_usage where agent_session_id = ${gone}`;
    expect(usage?.n).toBe(1);
    // The chat itself is gone for its person.
    expect((await t.request(`/v1/agent/chats/${gone}`, { key: keys.writer })).status).toBe(404);
    const list = await t.request('/v1/agent/chats', { key: keys.writer });
    expect(list.body.chats.map((chat: { id: string }) => chat.id)).not.toContain(gone);
    const [row] = await db.owner<{ status: string; title: string }[]>`
      select status, title from agent_sessions where id = ${gone}`;
    expect(row).toEqual({ status: 'deleted', title: '' });
    // A stream token minted before the delete can't start another turn.
    expect((await claim(gone, goneToken.token)).status).toBe(404);
  });

  it('keeps a chat stopped and then deleted while its runtime may still report', async () => {
    const id = await newChat();
    const turn = await claimed(id);
    const stopped = await t.request(`/v1/agent/chats/${id}/cancel`, {
      key: keys.writer,
      method: 'POST',
    });
    expect(stopped.body).toEqual({ cancelled: true });
    const deleted = await t.request(`/v1/agent/chats/${id}`, {
      key: keys.writer,
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    const [row] = await db.owner<{ status: string }[]>`
      select status from agent_sessions where id = ${id}`;
    expect(row?.status).toBe('deleted');
    // The runtime's step under way still counts, and its close still lands.
    expect((await report(id, turn.turnToken, 'after-stop')).body).toMatchObject({
      action: 'stop',
    });
    const [usage] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from ai_usage where agent_session_id = ${id}`;
    expect(usage?.n).toBe(1);
    expect((await close(id, turn.turnToken, 'cancelled')).status).toBe(200);
  });

  it('deletes a chat with no running turn outright', async () => {
    const id = await newChat();
    const turn = await claimed(id);
    expect((await close(id, turn.turnToken)).status).toBe(200);
    const deleted = await t.request(`/v1/agent/chats/${id}`, {
      key: keys.writer,
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    expect(await db.owner`select 1 from agent_sessions where id = ${id}`).toHaveLength(0);
  });

  it('refuses machine credentials other than keys in key mode', async () => {
    // A stream or turn token is no API key: /v1 refuses it.
    const id = await newChat();
    const { token } = await streamToken(id);
    const turn = await claimed(await newChat());
    for (const bearer of [token, turn.turnToken]) {
      expect((await t.request('/v1/schema', { key: bearer })).status).toBe(401);
      expect((await t.request('/v1/agent/chats', { key: bearer })).status).toBe(401);
    }
  });
});

describe('claims', () => {
  it('needs the runtime credential and a stream token for this chat', async () => {
    const id = await newChat();
    const otherChat = await newChat();
    const { token } = await streamToken(id);
    const noSecret = await t.request(`${runtimeBase(id)}/claim`, {
      key: token,
      body: { streamToken: token },
    });
    expect(noSecret.status).toBe(401);
    expect((await claim(otherChat, token)).status).toBe(401);
    const forged = `${token.slice(0, -4)}AAAA`;
    expect((await claim(id, forged)).status).toBe(401);
    expect((await claim(id, token)).status).toBe(200);
  });

  it('refuses the stream token on every runtime route', async () => {
    const id = await newChat();
    const { token } = await streamToken(id);
    await claim(id, token);
    for (const [path, body] of [
      ['/tools/describe_schema', { toolCallId: 'a', input: {} }],
      ['/report', { stepId: 's' }],
      ['/turn', undefined],
      ['/close', { status: 'completed', durationMs: 1 }],
    ] as const) {
      const res = await runtime(id, token, path, body);
      expect(res.status, path).toBe(401);
    }
  });

  it('adds the chat context on the first turn and nothing more that day', async () => {
    const id = await newChat();
    const first = await claimed(id, keys.writer, {
      title: '  Who   is Dana Levi at Acme, and what did we promise her last week?',
    });
    expect(first.session.firstTurn).toBe(true);
    expect(first.addedParts).toHaveLength(1);
    expect(first.addedParts[0]).toMatch(/Workspace: Acme Sales\./);
    expect(first.addedParts[0]).toMatch(/Today is /);
    expect(first.limits).toEqual({
      maxSteps: 50,
      maxOutputTokens: 32000,
      maxToolCalls: 200,
      webMaxUses: 10,
    });
    await close(id, first.turnToken);
    const second = await claimed(id);
    expect(second.session.firstTurn).toBe(false);
    expect(second.addedParts).toEqual([]);
    expect(second.session.tools).toEqual(first.session.tools);
    expect(second.session.systemBlocks).toEqual(first.session.systemBlocks);
    const [row] = await db.owner<
      { title: string }[]
    >`select title from agent_sessions where id = ${id}`;
    expect(row?.title).toBe(
      'Who is Dana Levi at Acme, and what did we promise her last week?'.slice(0, 80),
    );
    await close(id, second.turnToken);
    // A new day adds "Today is …" once.
    await db.owner`update agent_sessions set last_date = '2000-01-01' where id = ${id}`;
    const third = await claimed(id);
    expect(third.addedParts).toHaveLength(1);
    expect(third.addedParts[0]).toMatch(/^Today is /);
  });

  it('runs one turn per chat when two messages arrive at once (concurrent)', async () => {
    const id = await newChat();
    const [a, b] = await Promise.all([streamToken(id), streamToken(id)]);
    const results = await Promise.all([claim(id, a.token), claim(id, b.token)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(results.find((res) => res.status === 409)?.body).toMatchObject({ code: 'turn_running' });
  });

  it('caps the deadline at the invocation bound', async () => {
    const id = await newChat();
    const notAfter = new Date(Date.now() + 90_000);
    const turn = await claimed(id, keys.writer, { notAfter: notAfter.toISOString() });
    expect(new Date(turn.deadline).getTime()).toBeLessThanOrEqual(notAfter.getTime());
    const tooLate = await newChat();
    const { token } = await streamToken(tooLate);
    const refused = await claim(tooLate, token, {
      notAfter: new Date(Date.now() - 1000).toISOString(),
    });
    expect(refused.status).toBe(409);
  });

  it('times out a turn whose runtime died and refuses its late writes', async () => {
    const id = await newChat();
    const old = await claimed(id);
    // Still inside its deadline: a second claim is refused.
    const { token } = await streamToken(id);
    expect((await claim(id, token)).status).toBe(409);
    // Past the deadline but within the grace: the old token may still close, not write.
    await db.owner`update agent_turns set deadline = now() - interval '10 seconds' where id = ${old.turnId}`;
    const late = await runtime(id, old.turnToken, '/tools/upsert_record', {
      toolCallId: 'late',
      input: { object: 'person', values: { name: { first: 'Late', last: 'Write' } } },
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'turn_cancelled' });
    expect((await claim(id, (await streamToken(id)).token)).status).toBe(409);
    // Past the grace: the next claim closes it as timed_out.
    await db.owner`update agent_turns set deadline = now() - interval '2 minutes' where id = ${old.turnId}`;
    const fresh = await claimed(id);
    const [row] = await db.owner<
      { status: string }[]
    >`select status from agent_turns where id = ${old.turnId}`;
    expect(row?.status).toBe('timed_out');
    expect((await runtime(id, old.turnToken, '/turn')).status).toBe(401);
    expect(fresh.generation).toBeGreaterThan(old.generation);
  });
});

describe('cancel', () => {
  it('fences the turn at once and holds the next claim until the runtime stops', async () => {
    const id = await newChat();
    const turn = await claimed(id);
    expect((await runtime(id, turn.turnToken, '/turn')).body).toMatchObject({ status: 'running' });
    const cancelled = await t.request(`/v1/agent/chats/${id}/cancel`, {
      key: keys.writer,
      method: 'POST',
    });
    expect(cancelled.body).toEqual({ cancelled: true });
    expect((await runtime(id, turn.turnToken, '/turn')).body).toMatchObject({
      status: 'cancelled',
    });
    const tool = await runtime(id, turn.turnToken, '/tools/describe_schema', {
      toolCallId: 'x',
      input: {},
    });
    expect(tool.status).toBe(409);
    expect(tool.body).toMatchObject({ code: 'turn_cancelled' });
    // A late report still counts, and answers stop.
    const late = await report(id, turn.turnToken, 'after-cancel');
    expect(late.body).toEqual({ action: 'stop', reason: 'cancelled' });
    // An immediate new message waits for the old runtime to stop.
    const { token } = await streamToken(id);
    const early = await claim(id, token);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: 'turn_stopping' });
    // The old runtime's close only records that it stopped.
    expect((await close(id, turn.turnToken)).body).toEqual({ status: 'cancelled' });
    const next = await claimed(id);
    // The old turn's late report again counts once, and leaves the new turn alone.
    expect((await report(id, turn.turnToken, 'after-cancel')).body).toMatchObject({
      action: 'stop',
    });
    const rows = await db.owner<{ id: string; steps: number }[]>`
      select id, steps from agent_turns where session_id = ${id} order by generation`;
    expect(rows.map((row) => row.steps)).toEqual([1, 0]);
    expect(rows[1]?.id).toBe(next.turnId);
  });
});

describe('tools', () => {
  it('runs Retainer tools as the agent, within the key’s access', async () => {
    const id = await newChat();
    const turn = await claimed(id);
    const schema = await runtime(id, turn.turnToken, '/tools/describe_schema', {
      toolCallId: 'a',
      input: {},
    });
    expect(schema.status).toBe(200);
    expect(schema.body.ok).toBe(true);
    const written = await runtime(id, turn.turnToken, '/tools/upsert_record', {
      toolCallId: 'b',
      input: {
        object: 'person',
        values: { name: { first: 'Dana', last: 'Agent' }, emails: 'dana.agent@acme.test' },
      },
    });
    expect(written.body.ok, JSON.stringify(written.body)).toBe(true);
    const [assertion] = await db.owner<{ actor: { type: string; id: string } }[]>`
      select actor from field_assertions where record_id = ${written.body.output.id} limit 1`;
    expect(assertion?.actor).toMatchObject({ type: 'agent', id: 'retainer-agent:key:desk' });

    const invalid = await runtime(id, turn.turnToken, '/tools/upsert_record', {
      toolCallId: 'c',
      input: { object: 'nope', values: {} },
    });
    expect(invalid.status).toBe(200);
    expect(invalid.body.ok).toBe(false);
    const unknown = await runtime(id, turn.turnToken, '/tools/forget', {
      toolCallId: 'd',
      input: {},
    });
    expect(unknown.body).toMatchObject({ ok: false, error: { code: 'tool_not_available' } });
    const web = await runtime(id, turn.turnToken, '/tools/web_search', {
      toolCallId: 'e',
      input: {},
    });
    expect(web.body).toMatchObject({ ok: false, error: { code: 'tool_not_available' } });
  });

  it('refuses writes to a read-only key and stops a revoked key at once', async () => {
    const id = await newChat(keys.reader);
    const turn = await claimed(id, keys.reader);
    const write = await runtime(id, turn.turnToken, '/tools/upsert_record', {
      toolCallId: 'a',
      input: { object: 'person', values: { name: { first: 'No', last: 'Write' } } },
    });
    expect(write.body.ok).toBe(false);
    await db.owner`update api_keys set revoked_at = now() where workspace_id = ${workspaceId} and actor->>'id' = 'reader'`;
    const read = await runtime(id, turn.turnToken, '/tools/describe_schema', {
      toolCallId: 'b',
      input: {},
    });
    expect(read.body).toMatchObject({ ok: false, error: { code: 'role' } });
    expect(
      (await t.request(`/v1/agent/chats/${id}/token`, { key: keys.reader, method: 'POST' })).status,
    ).toBe(401);
  });

  it('can’t reach another session with a turn token', async () => {
    const mine = await newChat();
    const other = await newChat(keys.second);
    const turn = await claimed(mine);
    await claimed(other, keys.second);
    for (const path of ['/turn', '/report', '/tools/describe_schema', '/close']) {
      const res = await runtime(
        other,
        turn.turnToken,
        path,
        path === '/turn'
          ? undefined
          : {
              toolCallId: 'x',
              stepId: 'x',
              input: {},
              usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
              webSearches: 0,
              toolCalls: 0,
              status: 'completed',
              durationMs: 0,
            },
      );
      expect([400, 401], path).toContain(res.status);
    }
  });
});

describe('reports', () => {
  it('maps usage to its columns and counts a step once (concurrent)', async () => {
    const id = await newChat();
    const turn = await claimed(id);
    const results = await Promise.all([
      report(id, turn.turnToken, 'step-1'),
      report(id, turn.turnToken, 'step-1'),
    ]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    const usage = await db.owner<
      {
        input_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        output_tokens: number;
        usage: Record<string, unknown>;
      }[]
    >`select input_tokens::int, cache_read_tokens::int, cache_write_tokens::int, output_tokens::int, usage from ai_usage
      where agent_session_id = ${id}`;
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      input_tokens: 40,
      cache_read_tokens: 500,
      cache_write_tokens: 20,
      output_tokens: 7,
    });
    expect(usage[0]?.usage).toMatchObject({
      server_tool_use: { web_search_requests: 0 },
    });
    const [row] = await db.owner<
      { steps: number }[]
    >`select steps from agent_turns where id = ${turn.turnId}`;
    expect(row?.steps).toBe(1);
  });

  it('charges the full web allowance when counts are missing, and stops at the cap', async () => {
    const id = await newChat();
    const turn = await claimed(id);
    const first = await report(id, turn.turnToken, 'w1', { webSearches: null });
    expect(first.body).toEqual({ action: 'continue' });
    const [row] = await db.owner<{ web_searches: number }[]>`
      select web_searches from agent_turns where id = ${turn.turnId}`;
    expect(row).toMatchObject({ web_searches: 10 });
    await report(id, turn.turnToken, 'w2', { webSearches: 10 });
    const capped = await report(id, turn.turnToken, 'w3', { webSearches: 10 });
    expect(capped.body).toEqual({ action: 'stop', reason: 'limit_reached' });
  });

  it('stops at the step limit', async () => {
    const id = await newChat();
    const turn = await claimed(id);
    await db.owner`update agent_turns set steps = 48 where id = ${turn.turnId}`;
    expect((await report(id, turn.turnToken, 's49')).body).toEqual({ action: 'continue' });
    expect((await report(id, turn.turnToken, 's50')).body).toEqual({
      action: 'stop',
      reason: 'limit_reached',
    });
  });
});

describe('daily limits', () => {
  it('passes the day’s limit by at most one step per turn (concurrent)', async () => {
    const limited = startTestApp(db, {
      agent: { runtimeSecret: RUNTIME_SECRET, personDailySteps: 3, workspaceDailySteps: 100 },
    });
    const { keys: own } = await limited.setupWorkspace(
      { name: 'Limited' },
      { person: { actor: { type: 'agent', id: 'limited' }, scopes: ['read', 'write'] } },
    );
    const chats: { id: string; token: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const id = (await limited.request('/v1/agent/chats', { key: own.person, method: 'POST' }))
        .body.id;
      const { token } = (
        await limited.request(`/v1/agent/chats/${id}/token`, { key: own.person, method: 'POST' })
      ).body;
      const res = await limited.request(`${runtimeBase(id)}/claim`, {
        key: RUNTIME_SECRET,
        body: { streamToken: token },
      });
      expect(res.status).toBe(200);
      chats.push({ id, token: res.body.turnToken });
    }
    const answers = await Promise.all(
      chats.map(({ id, token }) =>
        limited.request(`${runtimeBase(id)}/report`, {
          key: token,
          body: {
            stepId: 'one',
            usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
            webSearches: 0,
            toolCalls: 0,
          },
        }),
      ),
    );
    const actions = answers.map((res) => res.body.action).sort();
    expect(actions).toEqual(['continue', 'continue', 'stop', 'stop', 'stop']);
    const [day] = await db.owner<{ steps: number }[]>`
      select steps from agent_days where subject = 'key:limited'`;
    expect(day?.steps).toBe(5);
    const id = (await limited.request('/v1/agent/chats', { key: own.person, method: 'POST' })).body
      .id;
    const { token } = (
      await limited.request(`/v1/agent/chats/${id}/token`, { key: own.person, method: 'POST' })
    ).body;
    const refused = await limited.request(`${runtimeBase(id)}/claim`, {
      key: RUNTIME_SECRET,
      body: { streamToken: token },
    });
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ code: 'limit_reached' });
  });
});

describe('without the agent', () => {
  it('answers 503 on the chat routes and opens no runtime route', async () => {
    const off = startTestApp(db);
    const { keys: own } = await off.setupWorkspace(
      { name: 'Off' },
      { k: { actor: { type: 'agent', id: 'off' }, scopes: ['read'] } },
    );
    expect((await off.request('/v1/agent/chats', { key: own.k })).status).toBe(503);
    expect(
      (
        await off.request(`${runtimeBase(crypto.randomUUID())}/claim`, {
          key: RUNTIME_SECRET,
          body: {},
        })
      ).status,
    ).toBe(401);
  });
});

describe('forget', () => {
  it('leaves agent sessions as they are (§5.4)', async () => {
    const id = await newChat();
    const turn = await claimed(id);
    const written = await runtime(id, turn.turnToken, '/tools/upsert_record', {
      toolCallId: 'toolu_forget',
      input: { object: 'person', values: { name: { first: 'Rina', last: 'Erased' } } },
    });
    expect(written.body.ok, JSON.stringify(written.body)).toBe(true);
    await saveChatHistory(db.url, id, 'Tell me about Rina Erased');
    expect((await close(id, turn.turnToken)).status).toBe(200);

    const forgotten = await t.request(`/v1/records/${written.body.output.id}/forget`, {
      key: keys.admin,
      method: 'POST',
    });
    expect(forgotten.status, JSON.stringify(forgotten.body)).toBe(200);

    const [session] = await db.owner`select id from agent_sessions where id = ${id}`;
    expect(session).toBeDefined();
    const [thread] = await db.owner`select id from mastra.mastra_threads where id = ${id}`;
    expect(thread).toBeDefined();
    const chat = await t.request(`/v1/agent/chats/${id}`, { key: keys.writer });
    expect(JSON.stringify(chat.body.messages)).toContain('Rina Erased');
  });
});
