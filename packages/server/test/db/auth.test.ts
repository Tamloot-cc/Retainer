import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApiKey, listApiKeys, revokeApiKey } from '../../src/auth/keys.js';
import { authenticate, requireScope } from '../../src/auth/middleware.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import type { AppEnv } from '../../src/http/response.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Hono<AppEnv>;
let workspaceId: string;
let readKey: string;
let adminKey: string;

beforeAll(async () => {
  const sql = db.connect({ role: RUNTIME_ROLE });
  workspaceId = (await createWorkspace(db.owner, { name: 'Auth' })).id;
  readKey = (
    await createApiKey(db.owner, {
      workspace: 'auth',
      name: 'Reader',
      actor: { type: 'agent', id: 'reader' },
      scopes: ['read'],
    })
  ).key;
  adminKey = (
    await createApiKey(db.owner, {
      workspace: workspaceId,
      name: 'Admin',
      actor: { type: 'user', id: 'admin' },
      scopes: ['admin'],
    })
  ).key;

  app = new Hono<AppEnv>();
  app.use('/v1/*', authenticate(sql));
  app.get('/v1/whoami', async (c) => {
    const caller = c.get('caller');
    // The per-transaction setting RLS keys on.
    const [row] = await inWorkspace(
      sql,
      caller.workspaceId,
      (tx) => tx`select current_setting('app.workspace_id') as ws, current_user as role`,
    );
    return c.json({ caller, transaction: row });
  });
  app.post('/v1/write', requireScope('write'), (c) => c.json({ ok: true }));
});

const call = (path: string, key?: string, method = 'GET') =>
  app.request(path, { method, headers: key ? { authorization: `Bearer ${key}` } : {} });

describe('authentication', () => {
  it('takes workspace, scopes and actor from the key', async () => {
    const res = await call('/v1/whoami', readKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      caller: {
        workspaceId,
        scopes: ['read'],
        actor: { type: 'agent', id: 'reader' },
        // Which key, by its stored hash: a chat opened with it follows it (agent spec §6.7).
        apiKey: { hash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
      transaction: { ws: workspaceId, role: RUNTIME_ROLE },
    });
  });

  it('rejects missing, malformed and unknown keys with 401', async () => {
    for (const res of [
      await call('/v1/whoami'),
      await app.request('/v1/whoami', { headers: { authorization: `Basic ${readKey}` } }),
      await call('/v1/whoami', 'rtn_doesnotexist'),
    ]) {
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    }
  });

  it('stops accepting a key once revoked', async () => {
    const key = await createApiKey(db.owner, {
      workspace: workspaceId,
      name: 'Temp',
      actor: { type: 'agent', id: 'temp' },
      scopes: ['read'],
    });
    expect((await call('/v1/whoami', key.key)).status).toBe(200);
    await revokeApiKey(db.owner, key.id);
    expect((await call('/v1/whoami', key.key)).status).toBe(401);
    const listing = await listApiKeys(db.owner, workspaceId);
    expect(listing.find((k) => k.id === key.id)?.revokedAt).not.toBeNull();
    expect(JSON.stringify(listing)).not.toContain(key.key);
  });

  it('stores only the hash', async () => {
    const rows = await db.owner`select hash, prefix from api_keys`;
    for (const row of rows) {
      expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
      expect([readKey, adminKey].some((k) => row.hash === k)).toBe(false);
    }
  });
});

describe('scopes', () => {
  it('returns 403 naming the missing scope', async () => {
    const res = await call('/v1/write', readKey, 'POST');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'this API key needs the "write" scope',
        details: { required: 'write', scopes: ['read'] },
      },
    });
  });

  it('lets admin do everything', async () => {
    expect((await call('/v1/write', adminKey, 'POST')).status).toBe(200);
  });
});
