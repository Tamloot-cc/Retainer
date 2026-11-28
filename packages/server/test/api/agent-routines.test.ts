import { randomUUID } from 'node:crypto';
import { RETAINER_ROUTINE_TOOL_NAMES, RETAINER_TOOL_NAMES, WEB_MAX_USES } from '@retainer/agent';
import { beforeAll, describe, expect, it } from 'vitest';
import { taskTools } from '../../src/agent-sessions/tasks.js';
import { inWorkspace } from '../../src/db/tx.js';
import { agentToolHost } from '../../src/mcp/agent-tools.js';
import { RUNTIME_SECRET } from '../helpers/agent.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { testRunTokens } from '../helpers/model.js';

/**
 * The chat's routine tools (routines-in-chat spec §3.1): pinned only where
 * routines are enabled, without `propose_routine`, run with the person's
 * access; the web chat's first message names the routines guide only then.
 */
const db = useTestDatabase();
const agent = {
  runtimeSecret: RUNTIME_SECRET,
  readStoreUrl: db.url,
  upstream: 'http://agent.invalid',
};
let withRoutines: TestApp, without: TestApp;
let keys: { writer: string; reader: string };
let workspaceId: string;

beforeAll(async () => {
  const { tokens } = await testRunTokens();
  withRoutines = startTestApp(db, {
    agent,
    runTokens: tokens,
    routines: { available: true, modelAvailable: false },
  });
  without = startTestApp(db, { agent });
  const setup = await withRoutines.setupWorkspace(
    { name: `Agent routines ${randomUUID()}`, template: 'sales' },
    {
      writer: { actor: { type: 'user', id: 'dana', name: 'Dana' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'user', id: 'rey', name: 'Rey' }, scopes: ['read'] },
    },
  );
  keys = setup.keys;
  workspaceId = setup.workspace.id;
});

async function turn(app: TestApp, key: string) {
  const created = await app.request<{ id: string }>('/v1/agent/chats', {
    key,
    body: { client: 'web' },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const token = await app.request<{ token: string }>(`/v1/agent/chats/${id}/token`, {
    key,
    method: 'POST',
  });
  const claimed = await app.request(`/v1/agent/runtime/sessions/${id}/claim`, {
    key: RUNTIME_SECRET,
    body: { streamToken: token.body.token },
  });
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
  const body = claimed.body as {
    turnToken: string;
    session: { tools: { name: string }[] };
    addedParts: string[];
  };
  const call = (name: string, input: object = {}) =>
    app.request(`/v1/agent/runtime/sessions/${id}/tools/${name}`, {
      key: body.turnToken,
      body: { toolCallId: randomUUID(), input },
    });
  return { ...body, call };
}

describe('the chat’s routine tools', () => {
  it('pins the routine group without propose_routine, and names the guide on the web', async () => {
    const chat = await turn(withRoutines, keys.writer);
    const names = chat.session.tools.map((tool) => tool.name);
    expect(names).toEqual([...RETAINER_TOOL_NAMES, ...RETAINER_ROUTINE_TOOL_NAMES, 'web_search']);
    expect(names).not.toContain('propose_routine');
    expect(chat.addedParts[0]).toMatch(/get_guide\("routines"\)/);
    expect(chat.addedParts[0]).toMatch(/retainer-routine/);
    const proposed = await chat.call('propose_routine', {});
    expect(proposed.body).toMatchObject({ ok: false, error: { code: 'tool_not_available' } });
  });

  it('pins none of them, and leaves the guide out, where routines are off', async () => {
    const chat = await turn(without, keys.writer);
    const names = chat.session.tools.map((tool) => tool.name);
    expect(names).toEqual([...RETAINER_TOOL_NAMES, 'web_search']);
    expect(chat.addedParts[0]).not.toMatch(/get_guide\("routines"\)/);
  });

  it('runs them with the person’s access: a reader can check and read', async () => {
    const chat = await turn(withRoutines, keys.reader);
    const caps = await chat.call('get_routine_capabilities');
    expect(caps.body).toMatchObject({ ok: true, output: { timezone: expect.any(String) } });
    const listed = await chat.call('list_routines');
    expect(listed.body).toMatchObject({ ok: true, output: { routines: [] } });
    const checked = await chat.call('validate_routine', {
      manifest: {
        when: { kind: 'manual', object: 'nothing', label: 'Go' },
        uses: { tools: [], model: false },
      },
      code: 'export async function main() {}\n',
      wait: 0,
    });
    // A draft with problems is an error result that lists them, for the model to fix.
    expect(checked.body).toMatchObject({ ok: false });
    expect(JSON.stringify(checked.body)).toMatch(/nothing/);
  });

  it('a task never pins the routine group', async () => {
    const host = agentToolHost(withRoutines.sql, {
      routines: { catalog: undefined, modelAvailable: false, agentAvailable: false } as never,
    });
    const { tools } = await inWorkspace(withRoutines.sql, workspaceId, (tx) =>
      taskTools(
        tx,
        {
          workspaceId,
          actor: { type: 'agent', id: 'task' },
          scopes: ['read', 'write'],
        } as never,
        host,
        undefined,
        ['retainer.read', 'retainer.write', 'web.search', 'retainer.routines'],
      ),
    );
    const names = tools.map((tool) => tool.name);
    for (const name of RETAINER_ROUTINE_TOOL_NAMES) expect(names).not.toContain(name);
    expect(tools.at(-1)).toMatchObject({ name: 'web_search', maxUses: WEB_MAX_USES });
  });
});
