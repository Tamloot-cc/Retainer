import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { createApiKey } from '../../src/auth/keys.js';
import { CONTROL_ROLE, loadConfig } from '../../src/config.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { createApiHandler } from '../../src/lambda/api.js';
import { createConsolidateHandler } from '../../src/lambda/consolidate.js';
import { createControlHandler } from '../../src/lambda/control.js';
import { DEPLOY_LOCK, withPassLock } from '../../src/lambda/deploy-lock.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { databaseUrl, useTestDatabase } from '../helpers/db.js';
import { bodyOf, context, httpEvent } from '../helpers/lambda.js';

const db = useTestDatabase();
const config = () => loadConfig({ DATABASE_URL: db.url, LOG_LEVEL: 'error' });
const NOTHING_UPGRADED = { upgraded: [], conflicts: [], failed: [], aboutEventLinks: [] };

describe('control function', () => {
  it('serves /account behind API Gateway, and only to a signed-in person', async () => {
    const handler = createControlHandler(
      loadConfig({
        DATABASE_URL: db.url,
        RETAINER_AUTH_SECRET: 'lambda-auth-secret-0123456789abcdef0123',
        RETAINER_GOOGLE_CLIENT_ID: 'lambda-client',
        RETAINER_GOOGLE_CLIENT_SECRET: 'lambda-secret',
        RETAINER_PUBLIC_ORIGIN: 'https://retainer.example',
        LOG_LEVEL: 'error',
      }),
      db.connect({ role: CONTROL_ROLE, max: 1 }),
      db.connect({ role: CONTROL_ROLE, max: 1 }),
    );
    const ok = await handler(httpEvent('GET', '/account/auth/ok'), context);
    expect(ok.statusCode).toBe(200);
    const res = await handler(httpEvent('GET', '/account'), context);
    expect(res.statusCode).toBe(401);
  });

  it("behind CloudFront, refuses requests without its secret and limits sign-in by the viewer's address", async () => {
    const secret = 'lambda-edge-secret-0123456789abcdef0123';
    const handler = createControlHandler(
      loadConfig({
        DATABASE_URL: db.url,
        RETAINER_AUTH_SECRET: 'lambda-auth-secret-0123456789abcdef0123',
        RETAINER_GOOGLE_CLIENT_ID: 'lambda-client',
        RETAINER_GOOGLE_CLIENT_SECRET: 'lambda-secret',
        RETAINER_PUBLIC_ORIGIN: 'https://retainer.example',
        RETAINER_EDGE_SECRET: secret,
        LOG_LEVEL: 'error',
      }),
      db.connect({ role: CONTROL_ROLE, max: 1 }),
      db.connect({ role: CONTROL_ROLE, max: 1 }),
    );
    const direct = await handler(httpEvent('GET', '/account/auth/ok'), context);
    expect(direct.statusCode).toBe(403);

    // Better Auth allows 3 sign-in attempts per 10 seconds from one address.
    // Every request reaches API Gateway from the same CloudFront address
    // (192.0.2.1 in httpEvent), so only the viewer's tells them apart.
    const signIn = (viewer: string) =>
      handler(
        httpEvent('POST', '/account/auth/sign-in/social', {
          headers: {
            'x-retainer-edge-secret': secret,
            'cloudfront-viewer-address': `${viewer}:443`,
            'content-type': 'application/json',
            origin: 'https://retainer.example',
          },
          body: '{}',
        }),
        context,
      );
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await signIn('203.0.113.7')).statusCode);
    expect(statuses.slice(0, 3)).not.toContain(429);
    expect(statuses[3]).toBe(429);
    expect((await signIn('203.0.113.8')).statusCode).not.toBe(429);
  });
});

const SCRIPT = `console.log(${JSON.stringify('Retainer '.repeat(200))});`;

describe('API function', () => {
  let webDir: string;
  let handler: ReturnType<typeof createApiHandler>;
  let key: string;

  beforeAll(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'retainer-web-'));
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Retainer</title>');
    await mkdir(join(webDir, 'assets'));
    await writeFile(join(webDir, 'assets', 'main-abc123.js'), SCRIPT);
    await writeFile(join(webDir, 'assets', 'main-abc123.js.br'), brotliCompressSync(SCRIPT));
    handler = createApiHandler(
      { ...config(), RETAINER_WEB_DIR: webDir },
      db.connect({ role: RUNTIME_ROLE, max: 2 }),
    );
    const workspace = await createWorkspace(db.owner, { name: 'Lambda', template: 'sales' });
    key = (
      await createApiKey(db.owner, {
        workspace: workspace.id,
        name: 'Lambda agent',
        actor: { type: 'agent', id: 'lambda' },
        scopes: ['read', 'write'],
      })
    ).key;
  });

  afterAll(async () => {
    await rm(webDir, { recursive: true, force: true });
  });

  it('serves the health check', async () => {
    const res = await handler(httpEvent('GET', '/health'), context);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(bodyOf(res))).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('authenticates REST calls with the API key', async () => {
    const denied = await handler(httpEvent('GET', '/v1/me'), context);
    expect(denied.statusCode).toBe(401);

    const res = await handler(
      httpEvent('GET', '/v1/me', { headers: { authorization: `Bearer ${key}` } }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(bodyOf(res))).toMatchObject({ actor: { type: 'agent', id: 'lambda' } });
  });

  it('answers MCP requests statelessly', async () => {
    const res = await handler(
      httpEvent('POST', '/mcp', {
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '0' },
          },
        }),
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toContain('"serverInfo"');
  });

  it('serves the web app, falling back to index.html for client routes', async () => {
    const res = await handler(httpEvent('GET', '/app/records/person'), context);
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toContain('<title>Retainer</title>');
    expect(res.headers?.['cache-control']).toBe('no-cache');
    const root = await handler(httpEvent('GET', '/app/'), context);
    expect(root.statusCode).toBe(200);
    expect(root.headers?.['cache-control']).toBe('no-cache');
  });

  it('serves hashed assets compressed, cached for good', async () => {
    const res = await handler(
      httpEvent('GET', '/app/assets/main-abc123.js', {
        headers: { 'accept-encoding': 'gzip, deflate, br, zstd' },
      }),
      context,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      'content-encoding': 'br',
      vary: 'Accept-Encoding',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    expect(res.isBase64Encoded).toBe(true);
    expect(brotliDecompressSync(Buffer.from(res.body ?? '', 'base64')).toString()).toBe(SCRIPT);

    const plain = await handler(httpEvent('GET', '/app/assets/main-abc123.js'), context);
    expect(plain.headers?.['content-encoding']).toBeUndefined();
    expect(plain.headers?.vary).toBe('Accept-Encoding');
    expect(bodyOf(plain)).toBe(SCRIPT);

    const missing = await handler(httpEvent('GET', '/app/assets/gone-123.js'), context);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers?.['cache-control']).toBeUndefined();
  });
});

describe('consolidate function', () => {
  it('consolidates each due workspace once, even when runs overlap', async () => {
    const workspace = await createWorkspace(db.owner, { name: 'Due', template: 'sales' });
    const run = (n: number) =>
      Promise.all(
        Array.from({ length: n }, () =>
          createConsolidateHandler(config(), db.connect({ role: RUNTIME_ROLE, max: 1 }))(),
        ),
      );

    const passes = await run(3);
    expect(passes.every((pass) => pass.failed === 0)).toBe(true);
    const [runs] = await db.owner<{ count: number }[]>`
      select count(*)::int as count from consolidator_runs where workspace_id = ${workspace.id}`;
    expect(runs?.count).toBe(1);

    // Within the interval the workspace is not due again.
    const [again] = await run(1);
    expect(again).toEqual({ consolidated: 0, failed: 0 });
  });
});

describe('ops function', () => {
  it('rejects an event it does not know', async () => {
    await expect(createOpsHandler(config())({ command: 'drop' })).rejects.toThrow(
      /Expected \{"command":"migrate"\}/,
    );
  });

  it('runs the operator CLI and returns the key without logging it', async () => {
    const logged = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
    ];
    const ops = createOpsHandler(config());
    try {
      const created = await ops({
        command: 'cli',
        args: ['workspace', 'create', '--name', 'Ops Clinic', '--template', 'clinic'],
      });
      expect(created).toMatchObject({ command: 'cli', exitCode: 0 });

      const key = await ops({
        command: 'cli',
        args: [
          'key',
          'create',
          '--workspace',
          'ops-clinic',
          '--name',
          'Front desk',
          '--actor',
          'agent:front-desk',
          '--scopes',
          'read,write',
          '--json',
        ],
      });
      if (key.command !== 'cli') throw new Error('expected a cli result');
      expect(key.exitCode).toBe(0);
      const secret = JSON.parse(key.stdout).key as string;
      expect(secret).toMatch(/^rtn_/);
      for (const spy of logged) {
        expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
      }

      const unknown = await ops({ command: 'cli', args: ['workspace', 'drop'] });
      expect(unknown).toMatchObject({ exitCode: 2, stderr: expect.stringContaining('Unknown') });
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
  });

  it('migrates an empty database, and a second run changes nothing', async () => {
    const adminUrl = inject('adminDatabaseUrl');
    const name = `retainer_test_empty_${Math.random().toString(16).slice(2, 10)}`;
    const admin = postgres(adminUrl, { max: 1, onnotice: false });
    await admin.unsafe(`create database "${name}"`);
    try {
      const url = databaseUrl(adminUrl, name);
      const ops = createOpsHandler(loadConfig({ DATABASE_URL: url, LOG_LEVEL: 'error' }));
      expect(await ops({ command: 'migrate' })).toEqual({
        command: 'migrate',
        logins: { runtime: false, control: false },
        rebuiltSearchText: 0,
        workspaceUpgrade: NOTHING_UPGRADED,
      });
      expect(await ops({ command: 'migrate' })).toEqual({
        command: 'migrate',
        logins: { runtime: false, control: false },
        rebuiltSearchText: 0,
        workspaceUpgrade: NOTHING_UPGRADED,
      });

      const check = postgres(url, { max: 1, onnotice: false });
      try {
        const [tables] = await check<{ count: number }[]>`
          select count(*)::int as count from information_schema.tables
          where table_schema = 'public' and table_name in ('workspaces', 'records', 'api_keys')`;
        expect(tables?.count).toBe(3);
      } finally {
        await check.end();
      }
    } finally {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    }
  });
});

describe('deploy lock: one version at a time', () => {
  const settled = (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);

  it('makes a migration wait for a consolidator pass in flight', async () => {
    // A pass on the old version, still running.
    const pass = db.connect({ max: 1 });
    await pass`select pg_advisory_lock_shared(${DEPLOY_LOCK})`;

    const ops = createOpsHandler(config());
    await expect(ops({ command: 'migrate', waitSeconds: 1 })).rejects.toThrow(
      /consolidator pass was still running after 1 seconds; nothing was migrated/,
    );

    const migration = ops({ command: 'migrate', waitSeconds: 30 });
    expect(await settled(migration)).toBe(false);
    await pass`select pg_advisory_unlock_shared(${DEPLOY_LOCK})`;
    await expect(migration).resolves.toEqual({
      command: 'migrate',
      logins: { runtime: false, control: false },
      rebuiltSearchText: 0,
      workspaceUpgrade: NOTHING_UPGRADED,
    });
  });

  it('makes a consolidator pass wait for a migration', async () => {
    // A migration holding the lock.
    const migration = db.connect({ max: 1 });
    await migration`select pg_advisory_lock(${DEPLOY_LOCK})`;

    const run = createConsolidateHandler(config(), db.connect({ role: RUNTIME_ROLE, max: 1 }))();
    expect(await settled(run)).toBe(false);
    await migration`select pg_advisory_unlock(${DEPLOY_LOCK})`;
    await expect(run).resolves.toMatchObject({ failed: 0 });
  });

  it('rejects a wait of zero, which would wait forever', async () => {
    await expect(
      createOpsHandler(config())({ command: 'migrate', waitSeconds: 0 }),
    ).rejects.toThrow(/Expected \{"command":"migrate"\}/);
  });

  it('keeps the lock connection instead of retiring it', () => {
    const kept = db.connect({ max: 1, keepConnections: true });
    expect(kept.options.max_lifetime).toBeNull();
    expect(db.connect({ max: 1 }).options.max_lifetime).not.toBeNull();
  });

  it('fails a pass whose connection, and so its lock, was replaced partway', async () => {
    const sql = db.connect({ max: 1, keepConnections: true });
    const pass = withPassLock(sql, async () => {
      const [{ pid } = { pid: 0 }] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await db.owner`select pg_terminate_backend(${pid})`;
      // The pool reconnects; the rest of the pass runs without the lock.
      for (let attempt = 0; ; attempt++) {
        try {
          await sql`select 1`;
          break;
        } catch (error) {
          if (attempt >= 5) throw error;
        }
      }
      return 'done';
    });
    await expect(pass).rejects.toThrow(/Lost the deploy lock partway through/);
  });
});
