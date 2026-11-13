import { describe, expect, it } from 'vitest';
import { RetainerClient } from './index.js';

describe('REST transport', () => {
  it('supports cookie credentials, the CSRF header, and abort propagation', async () => {
    let init: RequestInit | undefined;
    const controller = new AbortController();
    const client = new RetainerClient({
      baseUrl: 'http://localhost',
      credentials: 'include',
      fetch: async (_url, options) => {
        init = options;
        return Response.json({ records: [], nextCursor: null });
      },
    });
    await client.queryRecords('person', {}, controller.signal);
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBe(controller.signal);
    expect(init?.headers).toMatchObject({ 'X-Retainer-Client': 'web' });
    expect(init?.headers).not.toHaveProperty('authorization');
    expect(init?.headers).not.toHaveProperty('X-Retainer-Workspace');
  });
  it('names the workspace on cookie requests, and not with a key', async () => {
    const seen: RequestInit[] = [];
    const fetch = async (_url: unknown, options?: RequestInit) => {
      if (options) seen.push(options);
      return Response.json({ records: [], nextCursor: null });
    };
    const workspace = '11111111-1111-4111-8111-111111111111';
    await new RetainerClient({ baseUrl: 'http://x', workspace, fetch }).queryRecords('company', {});
    await new RetainerClient({
      baseUrl: 'http://x',
      workspace,
      apiKey: 'rtn_k',
      fetch,
    }).queryRecords('company', {});
    expect(seen[0]?.headers).toMatchObject({ 'X-Retainer-Workspace': workspace });
    expect(seen[1]?.headers).not.toHaveProperty('X-Retainer-Workspace');
  });
  it('preserves typed API errors and bearer clients', async () => {
    let headers: RequestInit['headers'] | undefined;
    const client = new RetainerClient({
      baseUrl: 'http://localhost',
      apiKey: 'rtn_test',
      fetch: async (_url, init) => {
        headers = init?.headers;
        return Response.json(
          { error: { code: 'stale_write', message: 'Changed', details: { updatedAt: 'new' } } },
          { status: 412 },
        );
      },
    });
    await expect(client.patchRecord('id', { values: { name: 'Dana' } })).rejects.toMatchObject({
      status: 412,
      code: 'stale_write',
      details: { updatedAt: 'new' },
    });
    expect(headers).toMatchObject({ authorization: 'Bearer rtn_test' });
  });
  it('returns a failed schema change with its reason, but throws other conflicts', async () => {
    const failed = {
      status: 'failed',
      change: { id: 'c1', error: 'jobTitle has duplicate values' },
      schemaVersion: 3,
      recordIds: ['r1', 'r2'],
    };
    let reply: unknown = failed;
    const client = new RetainerClient({
      baseUrl: 'http://localhost',
      fetch: async () => Response.json(reply, { status: 409 }),
    });
    expect(await client.decideSchemaChange('c1', 'approve')).toEqual(failed);
    expect(await client.proposeSchemaChange([])).toEqual(failed);
    reply = { error: { code: 'already_decided', message: 'this change is already applied' } };
    await expect(client.decideSchemaChange('c1', 'approve')).rejects.toMatchObject({
      status: 409,
      code: 'already_decided',
    });
  });
});

it('builds the retrieval, merge and forget requests', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = new RetainerClient({
    baseUrl: 'http://localhost/',
    apiKey: 'rtn_test',
    fetch: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return Response.json({});
    },
  });
  await client.context('r 1', { tokenBudget: 4000 });
  await client.context('r1');
  await client.search({ query: 'renewal', limit: 5 });
  await client.mergeRecords('a', { recordId: 'b' }, 'merge-1');
  await client.forget('a');
  await client.dismissMergeSuggestion('s1');
  expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)).toEqual([
    'GET http://localhost/v1/records/r%201/context?tokenBudget=4000',
    'GET http://localhost/v1/records/r1/context',
    'POST http://localhost/v1/search',
    'POST http://localhost/v1/records/a/merge',
    'POST http://localhost/v1/records/a/forget',
    'POST http://localhost/v1/review/merges/s1/dismiss',
  ]);
  expect(JSON.parse(calls[2]?.init?.body as string)).toEqual({ query: 'renewal', limit: 5 });
  expect(calls[3]?.init?.headers).toMatchObject({ 'idempotency-key': 'merge-1' });
});

it('keeps the existing health response contract for database outages', async () => {
  const expected = { status: 'error', version: '0.0.0', database: 'unreachable' };
  const client = new RetainerClient({
    baseUrl: 'http://localhost',
    fetch: async () => Response.json(expected, { status: 503 }),
  });
  expect(await client.health()).toEqual(expected);
});

it('uses scoped member connection routes, staged references and reconnect generation fencing', async () => {
  const seen: { url: string; method: string; body: unknown }[] = [];
  const client = new RetainerClient({
    baseUrl: 'http://retainer.test',
    fetch: async (url, init) => {
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({});
    },
  });
  await client.extensionConnections('install/id');
  await client.stageExtensionConnectionSecret('install/id', {
    name: 'apiKey',
    value: 'credential',
  });
  await client.connectExtension('install/id', {
    settings: { days: 31 },
    secretRefs: { apiKey: 'pending' },
  });
  await client.reconnectExtension('install/id', 'member/id', {
    settings: { days: 60 },
    expectedGeneration: 2,
    secretRefs: { apiKey: 'next' },
  });
  await client.disconnectExtension('install/id', 'member/id');
  await client.extensionRuns('install/id', { connection: 'member/id' });
  expect(seen.map((r) => r.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'DELETE', 'GET']);
  expect(seen[0]?.url).toBe('http://retainer.test/v1/extensions/install%2Fid/connections');
  expect(seen[3]?.url).toContain('/connections/member%2Fid/reconnect');
  expect(seen[3]?.body).toMatchObject({ expectedGeneration: 2, secretRefs: { apiKey: 'next' } });
  expect(seen[5]?.url).toContain('connection=member%2Fid');
  expect(seen[2]?.body).not.toHaveProperty('owner');
});
