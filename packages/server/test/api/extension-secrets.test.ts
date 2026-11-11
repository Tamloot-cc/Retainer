import { randomBytes, randomUUID } from 'node:crypto';
import { RetainerClient } from '@retainer/sdk';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { inWorkspace } from '../../src/db/tx.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase(),
  functionId = randomUUID();
const manifest = extensionFixture({
  settings: {
    apiKey: { type: 'string', label: 'API key', secret: true, required: true, reconnect: true },
    signingSecret: {
      type: 'string',
      label: 'Signing secret',
      secret: true,
      generated: true,
      required: false,
      reconnect: false,
    },
    enabled: { type: 'boolean', label: 'Enabled', secret: false, required: true, reconnect: false },
  },
  functions: [
    {
      universalId: functionId,
      name: 'sync',
      description: 'Fixture sync',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'job' },
      timeoutSeconds: 120,
      inputSchema: { type: 'object', additionalProperties: false },
    },
  ],
});
const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
const oldKey = randomBytes(32),
  newKey = randomBytes(32),
  cipher = new SecretCipher('old', new Map([['old', oldKey]]));
let t: TestApp, broker: SecretBroker, tokens: RunTokens;
beforeAll(async () => {
  broker = new SecretBroker(db.connect({ role: 'retainer_secret_broker' }), cipher);
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  t = startTestApp(db, { extensionCatalog: catalog, extensionSecrets: broker, runTokens: tokens });
});
async function setup() {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Secret ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['admin'] },
    },
  );
  const input = {
    registrationId: manifest.universalId,
    version: manifest.version,
    settings: { enabled: true },
  };
  const stage = await t.request('/v1/extensions/secrets', {
    key: keys.admin,
    body: {
      registrationId: manifest.universalId,
      version: manifest.version,
      name: 'apiKey',
      value: 'fixture-provider-secret',
    },
  });
  expect(stage.status).toBe(201);
  const request = { ...input, secretRefs: { apiKey: stage.body.pendingSecretId } };
  return {
    workspace: workspace.id,
    keys,
    input,
    request,
    stage: stage.body as { pendingSecretId: string; installationId: string },
  };
}
async function install(key: string, input: unknown) {
  const p = await t.request('/v1/extensions/preview', { key, body: input });
  expect(p.status).toBe(200);
  return t.request('/v1/extensions', {
    key,
    headers: { 'Idempotency-Key': 'install' },
    body: { ...(input as object), planDigest: p.body.planDigest },
  });
}
describe('broker-only secret storage and opaque approval references', () => {
  it('reviews and atomically adopts a reconnected credential without exposing it, rejecting stale plans and non-human approval', async () => {
    const h = await setup(),
      initial = await install(h.keys.admin, h.request),
      id = initial.body.id as string;
    const staged = await t.request('/v1/extensions/secrets', {
      key: h.keys.admin,
      body: {
        registrationId: manifest.universalId,
        version: manifest.version,
        installationId: id,
        name: 'apiKey',
        value: 'replacement-provider-secret',
      },
    });
    expect(staged.status).toBe(201);
    const input = {
      ...h.input,
      installationId: id,
      reconnect: true,
      secretRefs: { apiKey: staged.body.pendingSecretId },
    };
    const preview = await t.request('/v1/extensions/preview', { key: h.keys.admin, body: input });
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.body)).not.toContain('replacement-provider-secret');
    const commit = (key: string, receipt = 'reconnect') =>
      t.request(`/v1/extensions/${id}/reconnect`, {
        key,
        body: { ...input, planDigest: preview.body.planDigest },
        headers: { 'Idempotency-Key': receipt },
      });
    expect((await commit(h.keys.agent)).status).toBe(403);
    const identity = {
      workspaceId: h.workspace,
      installationId: id,
      registrationId: manifest.universalId,
      name: 'apiKey',
    };
    expect((await broker.read(identity)).value).toBe('fixture-provider-secret');
    const results = await Promise.all([commit(h.keys.admin), commit(h.keys.admin)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(results[0]?.body).toEqual(results[1]?.body);
    expect(results[0]?.body.generation).toBe(initial.body.generation + 1);
    expect((await broker.read(identity)).value).toBe('replacement-provider-secret');
    expect((await commit(h.keys.admin, 'new-stale-request')).status).toBe(409);
    expect(
      JSON.stringify(await t.request(`/v1/extensions/${id}`, { key: h.keys.admin })),
    ).not.toContain('replacement-provider-secret');
  });

  it('stages encrypted secrets, keeps them out of plans/settings/receipts, and denies ordinary SQL reads', async () => {
    const { workspace, keys, input, request, stage } = await setup();
    expect(
      (await t.request('/v1/extensions/preview', { key: keys.admin, body: input })).body.error.code,
    ).toBe('connection_required');
    const preview = await t.request('/v1/extensions/preview', { key: keys.agent, body: request });
    expect(preview.status).toBe(200);
    expect(JSON.stringify(preview.body)).not.toContain('fixture-provider-secret');
    const installed = await install(keys.admin, request);
    expect(installed.status).toBe(201);
    expect(installed.body.id).toBe(stage.installationId);
    expect(installed.body.secrets).toEqual({ apiKey: true });
    const detail = await t.request(`/v1/extensions/${installed.body.id}`, { key: keys.admin });
    expect(detail.body.settings).toEqual({ enabled: true });
    expect(detail.body.secrets).toEqual({ apiKey: true });
    await expect(t.sql`select * from extension_secrets`).rejects.toMatchObject({ code: '42501' });
    await expect(t.sql`select * from extension_pending_secrets`).rejects.toMatchObject({
      code: '42501',
    });
    const stored =
      await db.owner`select envelope from extension_secrets where installation_id=${installed.body.id}`;
    expect(JSON.stringify(stored)).not.toContain('fixture-provider-secret');
    const receipts =
      await db.owner`select response from extension_receipts where workspace_id=${workspace}`;
    expect(JSON.stringify(receipts)).not.toContain('fixture-provider-secret');
    const settings = await t.request(`/v1/extensions/${installed.body.id}/settings`, {
      key: keys.admin,
      method: 'PATCH',
      body: { expectedRevision: 1, settings: { enabled: false } },
    });
    expect(settings.status).toBe(200);
  });
  it('binds pending references to workspace/registration/name and refuses expired or reused references', async () => {
    const a = await setup(),
      b = await setup();
    expect(
      (await t.request('/v1/extensions/preview', { key: b.keys.admin, body: a.request })).body.error
        .code,
    ).toBe('connection_required');
    expect(
      (
        await t.request('/v1/extensions/secrets', {
          key: a.keys.agent,
          body: {
            registrationId: manifest.universalId,
            version: manifest.version,
            name: 'apiKey',
            value: 'fixture',
          },
        })
      ).status,
    ).toBe(403);
    await db.owner`update extension_pending_secrets set expires_at=clock_timestamp()-interval '1 second' where id=${a.stage.pendingSecretId}`;
    expect(
      (await t.request('/v1/extensions/preview', { key: a.keys.admin, body: a.request })).body.error
        .code,
    ).toBe('connection_required');
    const installed = await install(b.keys.admin, b.request);
    expect(installed.status).toBe(201);
    expect(
      (
        await t.request('/v1/extensions/preview', {
          key: b.keys.admin,
          body: { ...b.request, installationId: installed.body.id },
        })
      ).body.error.code,
    ).toBe('connection_required');
  });
  it('releases only the requested own secret to a live run, rotates with CAS and makes uninstall inaccessible before physical cleanup', async () => {
    const { workspace, keys, request } = await setup();
    const installed = await install(keys.admin, request);
    expect(installed.status).toBe(201);
    const id = installed.body.id as string;
    await db.owner`update extension_installations set state='active' where id=${id}`;
    const queue = new ExtensionQueue(t.sql, (id, version) => catalog.get(id, version).manifest);
    const { id: jobId } = await queue.enqueue(workspace, id, {
      functionId,
      input: {},
      dedupeKey: 'secret-run',
    });
    const lease = await queue.claim(workspace, jobId, 'worker');
    if (!lease) throw new Error('missing lease');
    const token = await tokens.issue(t.sql, lease, manifest.universalId, ['read']);
    expect(
      (await t.request(`/v1/extensions/${id}/runtime/secrets/apiKey`, { key: keys.admin })).status,
    ).toBe(403);
    const secret = await t.request(`/v1/extensions/${id}/runtime/secrets/apiKey`, { key: token });
    expect(secret.body).toEqual({ value: 'fixture-provider-secret', revision: 1 });
    expect(secret.headers.get('cache-control')).toBe('no-store');
    expect(
      (await t.request(`/v1/extensions/${id}/runtime/secrets/unknown`, { key: token })).status,
    ).toBe(404);
    const identity = {
      workspaceId: workspace,
      installationId: id,
      registrationId: manifest.universalId,
      name: 'apiKey',
    };
    const rotated = new SecretBroker(
      db.connect({ role: 'retainer_secret_broker' }),
      new SecretCipher(
        'new',
        new Map([
          ['old', oldKey],
          ['new', newKey],
        ]),
      ),
    );
    expect((await rotated.rotate(identity, 1))?.revision).toBe(2);
    await expect(rotated.rotate(identity, 1)).rejects.toMatchObject({ code: 'revision_conflict' });
    expect((await rotated.read(identity)).value).toBe('fixture-provider-secret');
    await expect(broker.read(identity)).rejects.toMatchObject({ code: 'connection_required' });
    expect(
      (await t.request(`/v1/extensions/${id}/uninstall`, { key: keys.admin, method: 'POST' }))
        .status,
    ).toBe(200);
    expect(
      (await t.request(`/v1/extensions/${id}/runtime/secrets/apiKey`, { key: token })).body.error
        .code,
    ).toBe('installation_disabled');
    const [retained] =
      await db.owner`select delete_after from extension_secrets where installation_id=${id}`;
    expect(retained?.delete_after).toBeTruthy();
    await db.owner`update extension_secrets set delete_after=clock_timestamp()-interval '1 second' where installation_id=${id}`;
    await rotated.collectExpired(workspace);
    const rows = await db.owner`select * from extension_secrets where installation_id=${id}`;
    expect(rows).toHaveLength(0);
  });
  it('stores generated provider secrets with competing CAS, keeps human credentials immutable and refuses fenced broker calls', async () => {
    const { workspace, keys, request } = await setup();
    expect(
      (
        await t.request('/v1/extensions/secrets', {
          key: keys.admin,
          body: {
            registrationId: manifest.universalId,
            version: manifest.version,
            name: 'signingSecret',
            value: 'cannot-stage',
          },
        })
      ).status,
    ).toBe(422);
    const installed = await install(keys.admin, request),
      id = installed.body.id as string;
    await db.owner`update extension_installations set state='active' where id=${id}`;
    const queue = new ExtensionQueue(t.sql, (id, version) => catalog.get(id, version).manifest);
    const queued = await queue.enqueue(workspace, id, {
      functionId,
      input: {},
      dedupeKey: 'generated-secret',
    });
    const run = await queue.claim(workspace, queued.id, 'secret-writer');
    if (!run) throw new Error('run missing');
    const token = await tokens.issue(t.sql, run, manifest.universalId, ['read']);
    const client = new RetainerClient({
      baseUrl: 'http://retainer.test',
      apiKey: token,
      fetch: t.inProcessFetch,
    });
    const put = (name: string, expectedRevision: number | null, value: string) =>
      t.request(`/v1/extensions/${id}/runtime/secrets/${name}`, {
        key: token,
        method: 'PUT',
        body: { expectedRevision, value },
      });
    expect((await put('apiKey', 1, 'forbidden')).status).toBe(403);
    expect((await put('signingSecret', 2147483648, 'out-of-range')).status).toBe(400);
    expect(
      await client.setExtensionSecret(id, 'signingSecret', {
        expectedRevision: null,
        value: 'generated-one',
      }),
    ).toEqual({ revision: 1 });
    const results = await Promise.all([
      put('signingSecret', 1, 'refresh-A'),
      put('signingSecret', 1, 'refresh-B'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const stored = await client.extensionSecret(id, 'signingSecret');
    expect(stored.revision).toBe(2);
    expect(['refresh-A', 'refresh-B']).toContain(stored.value);
    const detail = await t.request(`/v1/extensions/${id}`, { key: keys.admin });
    expect(detail.body.secrets).toEqual({ apiKey: true, signingSecret: true });
    expect(JSON.stringify(detail.body)).not.toContain('refresh-');
    expect(
      JSON.stringify(
        await db.owner`select envelope from extension_secrets where installation_id=${id}`,
      ),
    ).not.toContain('refresh-');
    await db.owner`update extension_jobs set lease_until=clock_timestamp()-interval '1 second' where id=${run.jobId}`;
    const replacement = await queue.claim(workspace, queued.id, 'replacement-writer');
    if (!replacement) throw new Error('replacement lease missing');
    expect(replacement.fence).not.toBe(run.fence);
    const identity = {
      workspaceId: workspace,
      installationId: id,
      registrationId: manifest.universalId,
      name: 'signingSecret',
    };
    await expect(broker.writeRuntime(identity, run, 2, 'fenced-write')).rejects.toMatchObject({
      code: 'installation_disabled',
    });
    expect((await broker.readRuntime(identity, replacement)).value).toBe(stored.value);
    await queue.complete(replacement, { status: 'succeeded' });
    await expect(
      broker.writeRuntime(
        {
          workspaceId: workspace,
          installationId: id,
          registrationId: manifest.universalId,
          name: 'signingSecret',
        },
        run,
        2,
        'late-write',
      ),
    ).rejects.toMatchObject({ code: 'installation_disabled' });
    await expect(
      broker.readRuntime(
        {
          workspaceId: workspace,
          installationId: id,
          registrationId: manifest.universalId,
          name: 'signingSecret',
        },
        run,
      ),
    ).rejects.toMatchObject({ code: 'installation_disabled' });
  });
  it('holds broker admission through its transaction so concurrent revocation drains it without nested connection locks', async () => {
    const { workspace, keys, request } = await setup();
    const installed = await install(keys.admin, request),
      id = installed.body.id as string;
    await db.owner`update extension_installations set state='active' where id=${id}`;
    const queue = new ExtensionQueue(t.sql, (id, version) => catalog.get(id, version).manifest);
    const queued = await queue.enqueue(workspace, id, {
      functionId,
      input: {},
      dedupeKey: 'broker-drain',
    });
    const run = await queue.claim(workspace, queued.id, 'broker-reader');
    if (!run) throw new Error('run missing');
    const brokerSql = db.connect({ role: 'retainer_secret_broker' });
    let entered = () => {},
      release = () => {};
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      paused = new Promise<void>((resolve) => {
        release = resolve;
      });
    const read = inWorkspace(brokerSql, workspace, async (tx) => {
      const [admission] =
        await tx`select retainer_admit_secret_run(${manifest.universalId}::uuid,${id}::uuid,${run.generation},${run.jobId}::uuid,${run.owner},${run.fence}::bigint,${run.releaseDigest},false) as admitted`;
      expect(admission?.admitted).toBe(true);
      entered();
      await paused;
      return tx`select envelope from extension_secrets where installation_id=${id}`;
    });
    await started;
    let disable: ReturnType<typeof t.request> | undefined;
    try {
      const [probe] =
        await db.owner`select pg_try_advisory_xact_lock(21061::int4,hashtext(${`${workspace}:${manifest.universalId}`})) as exclusive`;
      expect(probe?.exclusive).toBe(false);
      disable = t.request(`/v1/extensions/${id}/disable`, { key: keys.admin, method: 'POST' });
    } finally {
      release();
    }
    expect(await read).toHaveLength(1);
    expect((await disable)?.status).toBe(200);
    await expect(
      broker.readRuntime(
        {
          workspaceId: workspace,
          installationId: id,
          registrationId: manifest.universalId,
          name: 'apiKey',
        },
        run,
      ),
    ).rejects.toMatchObject({ code: 'installation_disabled' });
    await expect(
      t.sql`select retainer_admit_secret_run(${manifest.universalId}::uuid,${id}::uuid,${run.generation},${run.jobId}::uuid,${run.owner},${run.fence}::bigint,${run.releaseDigest},false)`,
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('requires fresh human credentials on reinstall and replaces retired generated material under the new grant', async () => {
    const h = await setup();
    const installed = await install(h.keys.admin, h.request),
      id = installed.body.id as string;
    await db.owner`update extension_installations set state='active' where id=${id}`;
    const queue = new ExtensionQueue(t.sql, (id, version) => catalog.get(id, version).manifest);
    const initial = await queue.enqueue(h.workspace, id, {
      functionId,
      input: {},
      dedupeKey: 'before-reinstall',
    });
    const old = await queue.claim(h.workspace, initial.id, 'old-grant');
    if (!old) throw new Error('initial lease missing');
    const identity = {
      workspaceId: h.workspace,
      installationId: id,
      registrationId: manifest.universalId,
      name: 'signingSecret',
    };
    await broker.writeRuntime(identity, old, null, 'old-signing-material');
    await queue.complete(old, { status: 'succeeded' });
    expect(
      (await t.request(`/v1/extensions/${id}/uninstall`, { key: h.keys.admin, method: 'POST' }))
        .status,
    ).toBe(200);
    expect(
      (await t.request('/v1/extensions/preview', { key: h.keys.admin, body: h.input })).body.error
        .code,
    ).toBe('connection_required');
    const stage = await t.request('/v1/extensions/secrets', {
      key: h.keys.admin,
      body: {
        registrationId: manifest.universalId,
        version: manifest.version,
        installationId: id,
        name: 'apiKey',
        value: 'fresh-provider-credential',
      },
    });
    expect(stage.status).toBe(201);
    const input = { ...h.input, secretRefs: { apiKey: stage.body.pendingSecretId } };
    const plan = await t.request('/v1/extensions/preview', { key: h.keys.admin, body: input });
    expect(plan.status).toBe(200);
    expect(
      (
        await t.request('/v1/extensions', {
          key: h.keys.admin,
          headers: { 'Idempotency-Key': randomUUID() },
          body: { ...input, planDigest: plan.body.planDigest },
        })
      ).status,
    ).toBe(201);
    await db.owner`update extension_installations set state='active' where id=${id}`;
    const next = await queue.enqueue(h.workspace, id, {
      functionId,
      input: {},
      dedupeKey: 'after-reinstall',
    });
    const run = await queue.claim(h.workspace, next.id, 'new-grant');
    if (!run) throw new Error('new lease missing');
    expect(run.generation).not.toBe(old.generation);
    expect(await broker.writeRuntime(identity, run, null, 'fresh-signing-material')).toEqual({
      revision: 2,
    });
    await expect(
      broker.writeRuntime(identity, run, null, 'cannot-replace-live-material'),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    await broker.collectExpired(h.workspace);
    expect((await broker.readRuntime(identity, run)).value).toBe('fresh-signing-material');
    await expect(broker.writeRuntime(identity, old, 2, 'old-grant-write')).rejects.toMatchObject({
      code: 'installation_disabled',
    });
  });
});
