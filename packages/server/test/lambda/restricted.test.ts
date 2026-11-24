import { createHmac, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { createApiKey, revokeApiKey } from '../../src/auth/keys.js';
import { CONTROL_ROLE, loadConfig, RUNTIME_ROLE } from '../../src/config.js';
import { lockSchemaExclusive } from '../../src/db/tx.js';
import { rateLimit } from '../../src/http/rate-limit.js';
import { createApiHandler } from '../../src/lambda/api.js';
import { createControlHandler } from '../../src/lambda/control.js';
import { useTestDatabase } from '../helpers/db.js';
import { bodyOf, context, httpEvent } from '../helpers/lambda.js';
import { SESSION_SECRET, team } from '../helpers/people.js';

const db = useTestDatabase();
const config = () =>
  loadConfig({
    DATABASE_URL: db.url,
    RETAINER_AUTH_SECRET: SESSION_SECRET,
    RETAINER_GOOGLE_CLIENT_ID: 'restricted-test',
    RETAINER_GOOGLE_CLIENT_SECRET: 'restricted-secret',
    RETAINER_PUBLIC_ORIGIN: 'https://retainer.example',
    LOG_LEVEL: 'error',
  });

it('serves account, REST and MCP reads on read-only pools and blocks mutations before counting', async () => {
  const { workspaceId, otherWorkspaceId, dana } = await team(db);
  const writer = db.connect({ role: RUNTIME_ROLE });
  const reader = db.connect({ role: RUNTIME_ROLE, readOnly: true });
  const control = () => db.connect({ role: CONTROL_ROLE, readOnly: true });
  const api = createApiHandler(config(), reader, {}, false, {
    // The fixture exercises the production rate middleware on a separate pool.
    rateLimit: rateLimit(writer, { limit: 100 }),
  });
  const writeApi = createApiHandler(config(), writer);
  const account = createControlHandler(config(), control(), control(), undefined, true);
  const { id: keyId, key } = await createApiKey(db.owner, {
    workspace: workspaceId,
    name: 'Probe',
    actor: { type: 'agent', id: 'probe' },
    scopes: ['read', 'write'],
  });
  const token = randomUUID();
  await db.owner`insert into sessions (token, user_id, expires_at)
    values (${token}, ${dana.id}, now() + interval '1 day')`;
  const signature = createHmac('sha256', SESSION_SECRET).update(token).digest('base64');
  const session = {
    cookie: `__Secure-retainer.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  };
  const headers = { ...session, 'x-retainer-workspace': workspaceId, 'x-retainer-client': 'web' };
  const bearer = { authorization: `Bearer ${key}` };
  const post = (path: string, payload: unknown, auth: Record<string, string> = headers) =>
    httpEvent('POST', path, {
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const rpc = (name: string, args: object, path = '/mcp') =>
    post(
      path,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      {
        ...bearer,
        accept: 'application/json, text/event-stream',
      },
    );
  const newRecord = post(
    '/v1/objects/person/records',
    {
      values: { name: { first: 'Reader', last: 'Fixture' } },
    },
    bearer,
  );
  const created = await writeApi(newRecord, context);
  expect(created.statusCode, bodyOf(created)).toBe(201);
  const { id } = JSON.parse(bodyOf(created));

  await expect(reader`update records set data = data`).rejects.toMatchObject({ code: '25006' });
  expect(
    (await account(httpEvent('GET', '/account', { headers: session }), context)).statusCode,
  ).toBe(200);
  expect((await api(httpEvent('GET', '/v1/me', { headers }), context)).statusCode).toBe(200);

  const reads = [
    httpEvent('GET', `/v1/records/${id}`, { headers }),
    post('/v1/objects/person/query', {}),
    post('/v1/search', { query: 'Fixture' }),
    rpc('query_records', { object: 'person' }),
    rpc('search', { query: 'Fixture' }, `/mcp/w/${workspaceId}`),
    rpc('get_record', { id }),
  ];
  const createIndex =
    'CREATE INDEX "restricted_fixture" ON "public"."records" USING btree ("label");';
  await db.owner.begin(async (tx) => {
    await tx.unsafe(createIndex);
    expect(
      await tx`select mode from pg_locks where pid = pg_backend_pid()
      and relation = 'records'::regclass and granted`,
    ).toContainEqual({ mode: 'ShareLock' });
    for (const event of reads) {
      const response = await api(event, context);
      expect(response.statusCode, bodyOf(response)).toBe(200);
      expect(bodyOf(response)).toContain(id);
      expect(bodyOf(response)).not.toContain('"isError":true');
    }
  });
  const wrongWorkspace = await api(
    httpEvent('GET', `/v1/records/${id}`, {
      headers: { ...headers, 'x-retainer-workspace': otherWorkspaceId },
    }),
    context,
  );
  expect(wrongWorkspace.statusCode).toBe(404);
  expect(
    JSON.parse(bodyOf(await api(rpc('get_record', { id }, `/mcp/w/${otherWorkspaceId}`), context))),
  ).toMatchObject({ error: { code: 'wrong_workspace' } });

  const counts = () => db.owner`select * from workspace_request_counts order by workspace_id`;
  const before = await counts();
  for (const event of [
    newRecord,
    rpc('upsert_record', { object: 'person' }),
    post(
      '/mcp',
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_record' } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'upsert_record' } },
      ],
      bearer,
    ),
  ]) {
    const response = await api(event, context);
    expect(response.statusCode).toBe(503);
    expect(response.headers?.['x-retainer-maintenance']).toBe('not-executed');
  }
  expect(await counts()).toEqual(before);
  const refresh = await account(post('/account/auth/get-session', {}, session), context);
  expect(refresh.statusCode).toBe(503);
  expect(refresh.headers?.['x-retainer-paused-operation']).toBe('session-refresh');

  await revokeApiKey(db.owner, keyId);
  expect((await api(rpc('get_record', { id }), context)).statusCode).toBe(401);
  await db.owner`update sessions set expires_at = now() - interval '1 day' where token = ${token}`;
  expect((await api(httpEvent('GET', '/v1/me', { headers }), context)).statusCode).toBe(401);
  expect(
    (await account(httpEvent('GET', '/account', { headers: session }), context)).statusCode,
  ).toBe(401);
  expect(await db.owner`select token from sessions where token = ${token}`).toHaveLength(1);
});

it('keeps REST and MCP available in a second workspace during a workspace schema lock', async () => {
  const { workspaceId, otherWorkspaceId } = await team(db);
  const sql = db.connect({ role: RUNTIME_ROLE });
  const reader = db.connect({ role: RUNTIME_ROLE, readOnly: true });
  const open = await createApiKey(db.owner, {
    workspace: otherWorkspaceId,
    name: 'Open',
    actor: { type: 'agent', id: 'open' },
    scopes: ['read', 'write'],
  });
  const paused = await createApiKey(db.owner, {
    workspace: workspaceId,
    name: 'Paused',
    actor: { type: 'agent', id: 'paused' },
    scopes: ['read', 'write'],
  });
  const limited = createApp({
    sql: reader,
    restricted: { rateLimit: rateLimit(sql, { limit: 100 }) },
  });
  const api = createApp({
    sql,
    workspacePause: { workspaceId, reader: (request) => limited.fetch(request) },
  });
  const request = (key: string, path: string, body: object, workspace?: string) =>
    api.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(workspace ? { 'x-retainer-workspace': workspace } : {}),
      },
      body: JSON.stringify(body),
    });
  const path = '/v1/objects/person/records';
  const body = { values: { name: { first: 'Second', last: 'Workspace' } } };
  const tool = (key: string, workspace: string, name: string, args: object) =>
    request(key, `/mcp/w/${workspace}`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  const write = { object: 'person', ...body };
  await db.owner.begin(async (tx) => {
    await lockSchemaExclusive(tx, workspaceId);
    const [deniedRest, deniedMcp, saved, savedMcp] = await Promise.all([
      request(paused.key, path, body),
      tool(paused.key, workspaceId, 'upsert_record', write),
      request(open.key, path, body),
      tool(open.key, otherWorkspaceId, 'upsert_record', write),
    ]);
    for (const response of [deniedRest, deniedMcp]) {
      expect(response.status).toBe(503);
      expect(response.headers.get('x-retainer-maintenance')).toBe('not-executed');
    }
    expect((await request(paused.key, path, body, otherWorkspaceId)).status).toBe(400);
    expect(saved.status).toBe(201);
    expect(savedMcp.status).toBe(200);
    const mcpWrite = await savedMcp.text();
    expect(mcpWrite).toContain('"structuredContent"');
    expect(mcpWrite).not.toContain('"isError":true');
    const { id } = (await saved.json()) as { id: string };
    for (const [key, workspace, containsOpenRecord] of [
      [paused.key, workspaceId, false],
      [open.key, otherWorkspaceId, true],
    ] as const) {
      const session = await api.request('/v1/me', { headers: { authorization: `Bearer ${key}` } });
      expect(session.status).toBe(200);
      expect(await session.json()).toMatchObject({ workspace: { id: workspace } });
      const list = await request(key, '/v1/objects/person/query', {});
      expect(list.status).toBe(200);
      expect((await list.text()).includes(id)).toBe(containsOpenRecord);
      const queried = await tool(key, workspace, 'query_records', { object: 'person' });
      expect(queried.status).toBe(200);
      const response = await queried.text();
      expect(response).not.toContain('"isError":true');
      expect(response.includes(id)).toBe(containsOpenRecord);
    }
  });
});
