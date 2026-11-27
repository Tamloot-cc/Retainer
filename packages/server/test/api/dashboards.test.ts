import { EXAMPLE_DASHBOARD, type SavedDashboard } from '@retainer/shared';
import { beforeAll, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { RUNTIME_SECRET } from '../helpers/agent.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const database = useTestDatabase();
let app: TestApp;
let keys: Record<'owner' | 'editor' | 'viewer' | 'outside', string>;

beforeAll(async () => {
  app = startTestApp(database, {
    agent: {
      runtimeSecret: RUNTIME_SECRET,
      readStoreUrl: database.url,
      upstream: 'http://agent.invalid',
    },
  });
  const workspace = await app.setupWorkspace(
    { name: 'Sales', template: 'sales' },
    {
      owner: { actor: { type: 'user', id: 'owner' }, scopes: ['admin'] },
      editor: { actor: { type: 'user', id: 'editor' }, scopes: ['read', 'write'] },
      viewer: { actor: { type: 'user', id: 'viewer' }, scopes: ['read'] },
    },
  );
  const outside = await app.setupWorkspace(
    { name: 'Outside', template: 'sales' },
    {
      outside: { actor: { type: 'user', id: 'outside' }, scopes: ['admin'] },
    },
  );
  keys = { ...workspace.keys, ...outside.keys };
  expect(
    (
      await app.request('/v1/objects/deal/records', {
        key: keys.owner,
        body: { values: { name: 'Acme renewal', stage: 'won' } },
      })
    ).status,
  ).toBe(201);
});

const dashboards = '/v1/dashboards';
const create = (key: string, body: Partial<SavedDashboard> = {}) =>
  app.request<SavedDashboard>(dashboards, {
    key,
    body: { name: 'Deals', program: EXAMPLE_DASHBOARD, ...body },
  });
const get = (key: string, id: string) =>
  app.request<SavedDashboard>(`${dashboards}/${id}`, { key });
const patch = (key: string, id: string, body: object) =>
  app.request<SavedDashboard>(`${dashboards}/${id}`, { key, method: 'PATCH', body });

async function chat(key: string, client: 'web' | 'cli' = 'web') {
  const result = await app.request<{ id: string }>('/v1/agent/chats', { key, body: { client } });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.id;
}

it('keeps dashboard and chat visibility separate and clears deleted chat pointers', async () => {
  const ownerChat = await chat(keys.owner);
  const editorChat = await chat(keys.editor);
  expect((await create(keys.owner, { chatId: editorChat })).status).toBe(422);
  expect((await create(keys.viewer)).status).toBe(403);
  const created = await create(keys.owner, { chatId: ownerChat });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const { id, updatedAt } = created.body;
  expect(created.body).toMatchObject({ visibility: 'private', chatId: ownerChat, issues: [] });
  expect((await get(keys.editor, id)).status).toBe(404);
  const share = await patch(keys.owner, id, {
    expectedUpdatedAt: updatedAt,
    visibility: 'workspace',
  });
  expect(share.status).toBe(200);
  expect((await get(keys.viewer, id)).body.chatId).toBeNull();
  expect((await get(keys.outside, id)).status).toBe(404);
  const foreignChat = await chat(keys.outside);
  await expect(
    database.owner`update dashboards set chat_id = ${foreignChat} where id = ${id}`,
  ).rejects.toMatchObject({ code: '23503', constraint_name: 'dashboards_chat_fk' });

  const filtered = await app.request(`${dashboards}?chatId=${ownerChat}`, { key: keys.owner });
  expect(filtered.body.dashboards).toMatchObject([{ id, chatId: ownerChat }]);
  expect(filtered.body.dashboards[0]).not.toHaveProperty('program');
  expect(
    (await app.request(`${dashboards}?chatId=${ownerChat}`, { key: keys.editor })).status,
  ).toBe(404);
  expect(
    (
      await patch(keys.editor, id, {
        visibility: 'private',
        expectedUpdatedAt: share.body.updatedAt,
      })
    ).status,
  ).toBe(403);

  const changed = await patch(keys.editor, id, {
    name: 'Renewals',
    chatId: editorChat,
    expectedUpdatedAt: share.body.updatedAt,
  });
  expect(changed.status).toBe(200);
  expect((await get(keys.owner, id)).body.chatId).toBeNull();
  expect(
    (await app.request(`/v1/agent/chats/${editorChat}`, { key: keys.editor, method: 'DELETE' }))
      .status,
  ).toBe(204);
  expect((await get(keys.editor, id)).body.chatId).toBeNull();
  expect(await database.owner`select chat_id from dashboards where id = ${id}`).toMatchObject([
    { chat_id: null },
  ]);
  expect(
    (await app.request(`${dashboards}/${id}`, { key: keys.editor, method: 'DELETE' })).status,
  ).toBe(204);
  expect((await get(keys.owner, id)).status).toBe(404);
});

it('allows only one concurrent update for a revision', async () => {
  const { body } = await create(keys.owner, { visibility: 'workspace' });
  const { id, updatedAt } = body;
  const attempts = await Promise.all([
    patch(keys.owner, id, { name: 'First', expectedUpdatedAt: updatedAt }),
    patch(keys.editor, id, { name: 'Second', expectedUpdatedAt: updatedAt }),
  ]);
  expect(attempts.map(({ status }) => status).sort()).toEqual([200, 409]);
});

it('exposes the read tools over MCP and keeps the dashboard guide hint in web chat context', async () => {
  const mcp = await app.mcpClient(keys.viewer);
  try {
    const listed = await mcp.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['aggregate_records', 'check_dashboard']),
    );
    const guide = await mcp.call('get_guide', { name: 'dashboards' });
    expect(guide.isError).toBe(false);
    expect(guide.body).toContain('check_dashboard');
    expect(guide.body).not.toContain('Mutation(');
    expect(
      (await mcp.call('aggregate_records', { object: 'deal', groupBy: 'stage' })).body,
    ).toMatchObject({ total: 1, groups: [{ value: 'won', label: 'Won' }] });
    expect((await mcp.call('check_dashboard', { program: EXAMPLE_DASHBOARD })).body).toEqual({
      ok: true,
      problems: [],
      queries: [
        { statement: 'byStage', rows: 1 },
        { statement: 'recent', rows: 1 },
      ],
    });
    const empty = EXAMPLE_DASHBOARD.replace(
      'object: "deal", limit: 10',
      'object: "deal", search: "not-a-match", limit: 10',
    );
    expect((await mcp.call('check_dashboard', { program: empty })).body).toMatchObject({
      ok: false,
      problems: [{ statement: 'recent', message: expect.stringContaining('no records') }],
    });
  } finally {
    await mcp.close();
  }
  for (const client of ['web', 'cli'] as const) {
    const id = await chat(keys.viewer, client);
    const token = await app.request(`/v1/agent/chats/${id}/token`, {
      key: keys.viewer,
      method: 'POST',
    });
    const claim = await app.request(`/v1/agent/runtime/sessions/${id}/claim`, {
      key: RUNTIME_SECRET,
      body: { streamToken: token.body.token, title: 'Test' },
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.addedParts.join('\n').includes('get_guide("dashboards")')).toBe(
      client === 'web',
    );
    const call = (name: string, input: object) =>
      app.request(`/v1/agent/runtime/sessions/${id}/tools/${name}`, {
        key: claim.body.turnToken,
        body: { toolCallId: name, input },
      });
    expect((await call('aggregate_records', { object: 'deal' })).body).toMatchObject({
      ok: true,
      output: { total: 1 },
    });
    expect((await call('check_dashboard', { program: EXAMPLE_DASHBOARD })).body).toMatchObject({
      ok: true,
      output: { ok: true },
    });
  }
});

it('keeps saved queries through renames and reports removed fields', async () => {
  const query = `root = Dashboard("Todos", [table, count])
rows = Query("query_records", {object: "task", fields: {due: "reminder", created: "createdAt"}, filter: {not: {reminder: {isNull: true}}}, sort: [{field: "reminder", direction: "asc"}]}, {records: []})
totals = Query("aggregate_records", {object: "task", groupBy: "updatedAt"}, {total: 0})
table = Table("Todos", rows.records, [TableColumn("Reminder", "due"), TableColumn("Created", "created")])
count = Metric("Count", totals.total)`;
  const schemaChange = (operations: object[]) =>
    app.request('/v1/schema/changes', {
      key: keys.owner,
      body: { operations },
    });
  expect(
    (
      await schemaChange([
        {
          op: 'create_field',
          object: 'task',
          field: { name: 'reminder', label: 'Reminder', type: 'date', isFilterable: true },
        },
      ])
    ).body.status,
  ).toBe('applied');
  const created = await create(keys.owner, { program: query });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.issues).toEqual([]);
  const stored = await database.owner<
    { program: string }[]
  >`select program from dashboards where id = ${created.body.id}`;
  expect(stored[0]?.program).not.toContain('"task"');
  expect(stored[0]?.program).toContain('"createdAt"');
  const change = await schemaChange([
    { op: 'rename_object', object: 'task', nameSingular: 'todo', namePlural: 'todos' },
    { op: 'rename_field', object: 'todo', field: 'reminder', name: 'followUpDate' },
  ]);
  expect(change.status, JSON.stringify(change.body)).toBe(200);
  expect(change.body.status).toBe('applied');
  const renamed = await get(keys.owner, created.body.id);
  expect(renamed.body.program).toContain('"todo"');
  expect(renamed.body.program).toContain('"due":"followUpDate"');
  expect(renamed.body.program).toContain('TableColumn("Reminder", "due")');
  expect(renamed.body.issues).toEqual([]);
  expect(
    await database.owner`select program from dashboards where id = ${created.body.id}`,
  ).toEqual(stored);
  expect(
    (await schemaChange([{ op: 'delete_field', object: 'todo', field: 'followUpDate' }])).body
      .status,
  ).toBe('applied');
  const removed = await get(keys.owner, created.body.id);
  expect(removed.status).toBe(200);
  expect(removed.body.issues).toContainEqual({
    statement: 'rows',
    message: expect.stringContaining('field that was removed'),
  });
});

it('admits dashboard reads in restricted mode while pausing writes', async () => {
  const created = await create(keys.owner);
  expect(created.status).toBe(201);
  const restricted = createApp({
    sql: database.connect({ role: RUNTIME_ROLE, readOnly: true }),
    restricted: { rateLimit: async (_context, next) => next() },
  });
  const headers = { authorization: `Bearer ${keys.owner}` };
  const listed = await restricted.request(dashboards, { headers });
  expect(listed.status).toBe(200);
  const result = await restricted.request(`${dashboards}/${created.body.id}`, { headers });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ name: created.body.name });
  const write = await restricted.request(dashboards, { headers, method: 'POST' });
  expect(write.status).toBe(503);
});
