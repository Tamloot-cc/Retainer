import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
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
});
