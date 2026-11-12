import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lookupInstallationKey } from '../../src/extension-runtime/credentials.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { createFileServer, LocalFileStorage } from '../../src/file-storage/local.js';
import { createRecord, requireObject, withWrite } from '../../src/records/service.js';
import { prepareValues } from '../../src/records/values.js';
import { insertRecord, writeFields } from '../../src/records/write.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const configured = extensionFixture({
  execution: 'standalone',
  scopes: ['read', 'write'],
  settings: {
    label: { type: 'string', label: 'Label', required: false, secret: false, reconnect: false },
    account: { type: 'string', label: 'Account', required: false, secret: false, reconnect: true },
  },
});
const manifests = [
  extensionFixture({ execution: 'standalone', scopes: ['read', 'write'] }),
  extensionFixture({ execution: 'standalone', scopes: ['read', 'write'] }),
  extensionFixture({ scopes: ['read', 'write'] }),
  extensionFixture({ execution: 'standalone', requestedActor: 'agent', scopes: ['read', 'write'] }),
  configured,
  // A plain release upgrade, then one that narrows the grant.
  extensionFixture({ ...configured, version: '1.1.0' }),
  extensionFixture({ ...configured, version: '1.2.0', scopes: ['read'] }),
];
const catalog = new ExtensionCatalog(
  manifests.map((manifest) => ({ manifest, actorCeiling: 'integration' as const })),
);
let app: TestApp,
  storage: LocalFileStorage,
  byteServer: ReturnType<typeof createFileServer>,
  directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'retainer-installation-keys-'));
  const key = randomBytes(32);
  byteServer = createFileServer({ directory, key });
  await new Promise<void>((r) => byteServer.listen(0, '127.0.0.1', r));
  const address = byteServer.address();
  if (!address || typeof address === 'string') throw new Error('missing byte address');
  storage = new LocalFileStorage(`http://127.0.0.1:${address.port}`, key);
  app = startTestApp(db, { extensionCatalog: catalog, fileStorage: storage });
});
afterAll(async () => {
  await new Promise<void>((r) => byteServer.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Standalone ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['admin'] },
    },
  );
  async function install(index = 0) {
    const manifest = manifests[index];
    if (!manifest) throw new Error('missing fixture');
    const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
    const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
    expect(preview.status).toBe(200);
    if (index < 2) expect(preview.body.warnings).toEqual([]);
    const installed = await app.request('/v1/extensions', {
      key: keys.admin,
      body: { ...input, planDigest: preview.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(installed.status).toBe(201);
    return installed.body;
  }
  const installation = await install(),
    base = `/v1/extensions/${installation.id}`;
  expect(installation.state).toBe('active');
  async function issue(scopes: ('read' | 'write')[] = ['read', 'write']) {
    const current = await app.request(base, { key: keys.admin });
    const response = await app.request(`${base}/keys`, {
      key: keys.admin,
      body: { expectedGeneration: current.body.generation, scopes },
    });
    expect(response.status).toBe(201);
    return response.body as { id: string; key: string; generation: number };
  }
  return { workspace, keys, installation, base, issue, install };
}
describe('standalone installation keys with real RLS Postgres', () => {
  it('issues human-approved generation-bound credentials once, stores only their hashes and derives the app actor', async () => {
    const h = await setup(),
      credential = await h.issue();
    expect(credential.key).toMatch(/^rti_[A-Za-z0-9_-]{43}$/);
    expect(
      (
        await db.owner`select count(*)::int as count from extension_jobs where installation_id=${h.installation.id}`
      )[0]?.count,
    ).toBe(0);
    const [stored] =
      await db.owner`select key_hash,prefix,scopes,created_by from extension_credentials where id=${credential.id}`;
    expect(stored?.key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(credential.key);
    const listing = await app.request(`${h.base}/credentials`, { key: h.keys.admin });
    expect(listing.body.credentials[0]).toMatchObject({
      id: credential.id,
      active: true,
      kind: 'key',
      scopes: ['read', 'write'],
    });
    expect(JSON.stringify(listing.body)).not.toContain(credential.key);
    expect(JSON.stringify(listing.body)).not.toContain(stored?.key_hash);
    const me = await app.request('/v1/me', { key: credential.key });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      person: false,
      actor: { type: 'integration', id: h.installation.id },
      scopes: ['read', 'write'],
    });
    expect((await app.request('/v1/records/me/context', { key: credential.key })).status).toBe(422);
    const created = await app.request('/v1/objects/company/records', {
      key: credential.key,
      body: { values: { name: 'Connected app' } },
    });
    expect(created.status).toBe(201);
    const [assertion] =
      await db.owner`select actor from field_assertions where record_id=${created.body.record.id}`;
    expect(assertion?.actor).toMatchObject({ type: 'integration', id: h.installation.id });
    const [change] =
      await db.owner`select origin_installation_id,cause from record_changes where record_id=${created.body.record.id}`;
    expect(change).toMatchObject({
      origin_installation_id: h.installation.id,
      cause: [h.installation.id],
    });
    expect(
      (
        await app.request(`${h.base}/keys`, {
          key: h.keys.agent,
          body: { expectedGeneration: 1, scopes: ['read'] },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`${h.base}/keys`, {
          key: h.keys.admin,
          body: { expectedGeneration: 1, scopes: ['read'], actor: { type: 'user', id: 'forged' } },
        })
      ).status,
    ).toBe(400);
  });
  it('inherits an approved agent rank rather than escalating a standalone app to integration', async () => {
    const h = await setup(),
      installed = await h.install(3);
    const credential = await app.request(`/v1/extensions/${installed.id}/keys`, {
      key: h.keys.admin,
      body: { expectedGeneration: installed.generation, scopes: ['read', 'write'] },
    });
    expect(credential.status).toBe(201);
    expect((await app.request('/v1/me', { key: credential.body.key })).body.actor).toMatchObject({
      type: 'agent',
      id: installed.id,
    });
    const record = await app.request('/v1/objects/company/records', {
      key: credential.body.key,
      body: { values: { name: 'Agent app write' } },
    });
    expect(record.status).toBe(201);
    expect(
      (
        await db.owner`select actor from field_assertions where record_id=${record.body.record.id}`
      )[0]?.actor,
    ).toMatchObject({ type: 'agent', id: installed.id });
  });
  it('serializes competing key issuance at the credential quota and allows replacement after explicit revocation', async () => {
    const h = await setup(),
      issued = await Promise.all(Array.from({ length: 19 }, () => h.issue()));
    const results = await Promise.all(
      [0, 1].map(() =>
        app.request(`${h.base}/keys`, {
          key: h.keys.admin,
          body: { expectedGeneration: h.installation.generation, scopes: ['read'] },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
    expect(
      (
        await db.owner`select count(*)::int as count from extension_credentials where installation_id=${h.installation.id} and revoked_at is null`
      )[0]?.count,
    ).toBe(20);
    expect(
      (
        await app.request(`${h.base}/credentials/${issued[0]?.id}`, {
          key: h.keys.admin,
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect((await h.issue()).key).toMatch(/^rti_/);
  });
  it('does not widen scopes, reach another installation/workspace, enter MCP or become a web session', async () => {
    const h = await setup(),
      credential = await h.issue(['read']),
      other = await h.install(1),
      elsewhere = await setup();
    expect(
      (
        await app.request('/v1/objects/company/records', {
          key: credential.key,
          body: { values: { name: 'Denied' } },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request('/v1/schema/changes', { key: credential.key, body: { operations: [] } }))
        .status,
    ).toBe(403);
    expect(
      (
        await app.request(`${h.base}/keys`, {
          key: credential.key,
          body: { expectedGeneration: 1, scopes: ['read'] },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request('/v1/extensions', { key: credential.key })).body.installations.map(
        (i: any) => i.id,
      ),
    ).toEqual([h.installation.id]);
    expect((await app.request(`/v1/extensions/${other.id}`, { key: credential.key })).status).toBe(
      404,
    );
    expect(
      (
        await app.request('/v1/me', {
          key: credential.key,
          headers: { 'X-Retainer-Workspace': elsewhere.workspace.id },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/mcp', {
          key: credential.key,
          body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        })
      ).status,
    ).toBe(401);
    expect(
      (await app.request('/v1/me', { headers: { cookie: `retainer_session=${credential.key}` } }))
        .status,
    ).toBe(401);
    const hosted = await h.install(2);
    expect(
      (
        await app.request(`/v1/extensions/${hosted.id}/keys`, {
          key: h.keys.admin,
          body: { expectedGeneration: hosted.generation, scopes: ['read'] },
        })
      ).status,
    ).toBe(409);
    const accounts = startTestApp(db, {
      extensionCatalog: catalog,
      accountsSecret: 'accounts-secret-for-standalone-fixture-123456',
    });
    expect((await accounts.request('/v1/me', { key: credential.key })).status).toBe(401);
    expect(
      (
        await accounts.request(`${h.base}/keys`, {
          key: h.keys.admin,
          body: { expectedGeneration: 1, scopes: ['read'] },
        })
      ).status,
    ).toBe(403);
  });
  it('binds unclaimed uploads and attachment writes to the installation while preserving shared downloads', async () => {
    const h = await setup(),
      credential = await h.issue(),
      other = await h.install(1);
    const otherKey = await app.request(`/v1/extensions/${other.id}/keys`, {
      key: h.keys.admin,
      body: { expectedGeneration: other.generation, scopes: ['read', 'write'] },
    });
    expect(otherKey.status).toBe(201);
    expect(
      (
        await app.request('/v1/schema/changes', {
          key: h.keys.admin,
          body: {
            operations: [
              {
                op: 'create_field',
                object: 'company',
                field: { name: 'attachments', label: 'Attachments', type: 'files' },
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    const bytes = Buffer.from('Standalone attachment');
    const intent = await app.request('/v1/files/intents', {
      key: credential.key,
      body: {
        name: 'app.txt',
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(intent.status).toBe(201);
    expect(
      (await db.owner`select installation_id from files where id=${intent.body.id}`)[0]
        ?.installation_id,
    ).toBe(h.installation.id);
    expect(
      (
        await fetch(intent.body.upload.url, {
          method: 'PUT',
          headers: intent.body.upload.headers,
          body: bytes,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(`/v1/files/${intent.body.id}/finalize`, {
          key: credential.key,
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request('/v1/objects/company/records', {
          key: otherKey.body.key,
          body: { values: { name: 'Other app', attachments: [intent.body.id] } },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/v1/objects/company/records', {
          key: credential.key,
          body: { values: { name: 'Owning app', attachments: [intent.body.id] } },
        })
      ).status,
    ).toBe(201);
    const download = await app.request(`/v1/files/${intent.body.id}/download`, {
      key: otherKey.body.key,
      method: 'POST',
    });
    expect(download.status).toBe(200);
    expect(await (await fetch(download.body.url)).text()).toBe(bytes.toString());
    expect(
      (
        await app.request(`${h.base}/credentials/${credential.id}`, {
          key: h.keys.admin,
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/v1/files/${intent.body.id}/finalize`, {
          key: credential.key,
          method: 'POST',
        })
      ).status,
    ).toBe(401);
  });
  it.each(['revoke', 'disable'] as const)(
    'drains admitted writes before %s and checks stale credentials before idempotency replay',
    async (action) => {
      const h = await setup(),
        credential = await h.issue(),
        caller = await lookupInstallationKey(app.sql, credential.key);
      const original = await createRecord(
        app.sql,
        caller,
        'company',
        { name: 'Idempotent app write' },
        { idempotencyKey: 'installation-write' },
      );
      let entered: () => void = () => {},
        release: () => void = () => {};
      const ready = new Promise<void>((r) => {
          entered = r;
        }),
        barrier = new Promise<void>((r) => {
          release = r;
        });
      const writing = withWrite(app.sql, caller, async (tx, context) => {
        const object = requireObject(context.schema, 'company'),
          record = await insertRecord(tx, context, object);
        await writeFields(
          tx,
          context,
          object,
          record,
          prepareValues(object, { name: 'Finishing app write' }, 'create'),
        );
        entered();
        await barrier;
        return record.id;
      });
      await ready;
      let ended = false;
      const stopping = app
        .request(
          action === 'revoke' ? `${h.base}/credentials/${credential.id}` : `${h.base}/disable`,
          { key: h.keys.admin, method: action === 'revoke' ? 'DELETE' : 'POST' },
        )
        .then((r) => {
          ended = true;
          return r;
        });
      try {
        let waiting = false;
        for (let n = 0; n < 100; n++) {
          const [row] =
            await db.owner`select count(*)::int as count from pg_locks where locktype='advisory' and classid=21061 and not granted`;
          if (Number(row?.count) > 0) {
            waiting = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 5));
        }
        expect(waiting).toBe(true);
        expect(ended).toBe(false);
      } finally {
        release();
      }
      const [id, stopped] = await Promise.all([writing, stopping]);
      expect(stopped.status).toBe(200);
      expect(await db.owner`select id from records where id=${id}`).toHaveLength(1);
      await expect(
        createRecord(
          app.sql,
          caller,
          'company',
          { name: 'Idempotent app write' },
          { idempotencyKey: 'installation-write' },
        ),
      ).rejects.toMatchObject({
        code: action === 'revoke' ? 'unauthorized' : 'installation_disabled',
      });
      expect(
        (await app.request(`/v1/records/${original.id}`, { key: credential.key })).status,
      ).toBe(401);
      if (action === 'disable') {
        expect(
          (await app.request(`${h.base}/enable`, { key: h.keys.admin, method: 'POST' })).status,
        ).toBe(200);
        expect((await app.request('/v1/me', { key: credential.key })).status).toBe(401);
        const fresh = await h.issue();
        expect(fresh.generation).toBeGreaterThan(credential.generation);
        expect((await app.request('/v1/me', { key: fresh.key })).status).toBe(200);
      }
    },
  );
  it('shares the atomic installation write budget across competing standalone keys', async () => {
    const h = await setup(),
      keys = await Promise.all([h.issue(), h.issue()]);
    const callers = await Promise.all(keys.map((key) => lookupInstallationKey(app.sql, key.key)));
    const outcomes = await Promise.allSettled(
      Array.from({ length: 64 }, (_, n) => {
        const caller = callers[n % 2];
        if (!caller) throw new Error('missing caller');
        return withWrite(app.sql, caller, async (tx) => {
          const [counter] = await tx<
            { window: string; count: number }[]
          >`select window_start::text as window,count from extension_write_budgets where installation_id=${h.installation.id}`;
          if (!counter) throw new Error('missing budget');
          return counter;
        });
      }),
    );
    const windows = new Map<string, number[]>();
    for (const result of outcomes)
      if (result.status === 'fulfilled') {
        const counts = windows.get(result.value.window) ?? [];
        counts.push(result.value.count);
        windows.set(result.value.window, counts);
      }
    for (const counts of windows.values()) {
      expect(counts.length).toBeLessThanOrEqual(60);
      expect(counts.sort((a, b) => a - b)).toEqual(
        Array.from({ length: counts.length }, (_, n) => n + 1),
      );
    }
    if (windows.size === 1)
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(60);
    for (const result of outcomes)
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ code: 'quota_exceeded' });
  });
});

describe('standalone credentials bind to the grant, not the release (grant_generation)', () => {
  async function configuredApp() {
    const h = await setup(),
      installed = await h.install(4),
      base = `/v1/extensions/${installed.id}`;
    const issue = async () => {
      const current = await app.request(base, { key: h.keys.admin });
      const response = await app.request(`${base}/keys`, {
        key: h.keys.admin,
        body: { expectedGeneration: current.body.generation, scopes: ['read', 'write'] },
      });
      expect(response.status).toBe(201);
      return response.body as { id: string; key: string; generation: number };
    };
    const commit = async (path: string, input: Record<string, unknown>) => {
      const preview = await app.request('/v1/extensions/preview', {
        key: h.keys.admin,
        body: input,
      });
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      return app.request(path, {
        key: h.keys.admin,
        body: { ...input, planDigest: preview.body.planDigest },
        headers: { 'Idempotency-Key': randomUUID() },
      });
    };
    const upgrade = (version: string) =>
      commit(`${base}/upgrade`, {
        installationId: installed.id,
        registrationId: configured.universalId,
        version,
        settings: {},
      });
    const write = (key: string) =>
      app.request('/v1/objects/company/records', {
        key,
        body: { values: { name: `App write ${randomUUID()}` } },
      });
    return { ...h, installed, base, issue, commit, upgrade, write };
  }
  it('keeps a key working across a release upgrade without a grant change', async () => {
    const h = await configuredApp(),
      credential = await h.issue();
    const upgraded = await h.upgrade('1.1.0');
    expect(upgraded.status, JSON.stringify(upgraded.body)).toBe(200);
    expect(upgraded.body).toMatchObject({ state: 'active', version: '1.1.0' });
    expect(upgraded.body.generation).toBeGreaterThan(h.installed.generation);
    expect(upgraded.body.grantGeneration).toBe(h.installed.grantGeneration);
    expect((await h.write(credential.key)).status).toBe(201);
    const listing = await app.request(`${h.base}/credentials`, { key: h.keys.admin });
    expect(listing.body.credentials[0]).toMatchObject({ id: credential.id, active: true });
  });
  it('revokes keys when an upgrade narrows the grant', async () => {
    const h = await configuredApp(),
      credential = await h.issue();
    const narrowed = await h.upgrade('1.2.0');
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(narrowed.body.grantGeneration).toBeGreaterThan(h.installed.grantGeneration);
    expect((await app.request('/v1/me', { key: credential.key })).status).toBe(401);
  });
  it('updates ordinary settings in place: fences runs, keeps the installation active and its keys valid', async () => {
    const h = await configuredApp(),
      credential = await h.issue();
    const changed = await app.request(`${h.base}/settings`, {
      key: h.keys.admin,
      method: 'PATCH',
      body: { expectedRevision: h.installed.settingsRevision, settings: { label: 'Renamed' } },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ state: 'active', settings: { label: 'Renamed' } });
    expect(changed.body.generation).toBeGreaterThan(h.installed.generation);
    expect(changed.body.grantGeneration).toBe(h.installed.grantGeneration);
    expect((await h.write(credential.key)).status).toBe(201);
    // A fresh key issued after the change binds to the same grant.
    expect((await h.issue()).generation).toBe(credential.generation);
  });
  it('revokes keys on reconnect and keeps them dead through disable and enable', async () => {
    const h = await configuredApp(),
      credential = await h.issue();
    const reconnected = await h.commit(`${h.base}/reconnect`, {
      installationId: h.installed.id,
      registrationId: configured.universalId,
      version: configured.version,
      reconnect: true,
      settings: { account: 'other@example.com' },
    });
    expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);
    expect((await app.request('/v1/me', { key: credential.key })).status).toBe(401);
    const fresh = await h.issue();
    expect(fresh.generation).toBeGreaterThan(credential.generation);
    expect((await h.write(fresh.key)).status).toBe(201);
    const disabled = await app.request(`${h.base}/disable`, {
      key: h.keys.admin,
      method: 'POST',
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.grantGeneration).toBeGreaterThan(fresh.generation);
    // Repeating a disable is idempotent for the grant.
    const again = await app.request(`${h.base}/disable`, { key: h.keys.admin, method: 'POST' });
    expect(again.body.grantGeneration).toBe(disabled.body.grantGeneration);
    expect(
      (await app.request(`${h.base}/enable`, { key: h.keys.admin, method: 'POST' })).status,
    ).toBe(200);
    expect((await app.request('/v1/me', { key: fresh.key })).status).toBe(401);
  });
});
