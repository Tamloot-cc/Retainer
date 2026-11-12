import { randomBytes, randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RunBinding } from '../../src/caller.js';
import { inWorkspace, lockSchemaShared } from '../../src/db/tx.js';
import { admitRun } from '../../src/extension-runtime/admission.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

// Spec 8: a run receives only its own function's secrets, and its scopes are the
// intersection of the release, the installed grant and the function's needs.
const db = useTestDatabase();
const reader = randomUUID(),
  writer = randomUUID(),
  setupId = randomUUID();
const fn = (universalId: string, name: string, extra: object, kind = 'job') => ({
  universalId,
  name,
  description: 'Grant fixture',
  handlerDigest: 'b'.repeat(64),
  trigger: { kind: kind as 'job' },
  timeoutSeconds: 120,
  inputSchema: { type: 'object' as const, additionalProperties: false as const },
  ...extra,
});
const manifest = (version: string) =>
  extensionFixture({
    universalId: '3c4f3c1e-6c1b-4f8e-9f53-2e0f2b0c6a11',
    version,
    scopes: ['read', 'write'],
    settings: {
      apiKey: { type: 'string', label: 'API key', secret: true, required: true, reconnect: true },
    },
    functions: [
      fn(reader, 'reader', { secrets: [], scopes: ['read'] }),
      fn(writer, 'writer', { secrets: ['apiKey'], scopes: ['read', 'write'] }),
      fn(setupId, 'setup', { secrets: [] }, 'install'),
    ],
  });
const v1 = manifest('1.0.0'),
  v2 = manifest('1.1.0');
const catalog = new ExtensionCatalog([
  { manifest: v1, actorCeiling: 'integration', runtimeEnabled: true },
  { manifest: v2, actorCeiling: 'integration', runtimeEnabled: true },
]);
const cipher = new SecretCipher('k', new Map([['k', randomBytes(32)]]));
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
  t = startTestApp(db, {
    extensionCatalog: catalog,
    extensionSecrets: broker,
    runTokens: tokens,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
  });
});
async function install(key: string, body: Record<string, unknown>, receipt: string) {
  const preview = await t.request('/v1/extensions/preview', { key, body });
  expect(preview.status).toBe(200);
  const installed = await t.request('/v1/extensions', {
    key,
    body: { ...body, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': receipt },
  });
  expect(installed.status).toBe(201);
  return installed.body as { id: string };
}
async function setup() {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Grants ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const stage = await t.request('/v1/extensions/secrets', {
    key: keys.admin,
    body: { registrationId: v1.universalId, version: v1.version, name: 'apiKey', value: 'sk-1' },
  });
  expect(stage.status).toBe(201);
  const input = {
    registrationId: v1.universalId,
    version: v1.version,
    settings: {},
    secretRefs: { apiKey: stage.body.pendingSecretId },
  };
  const { id } = await install(keys.admin, input, 'install');
  return { workspace: workspace.id, key: keys.admin, id };
}
async function run(workspace: string, id: string, functionId: string) {
  await db.owner`update extension_installations set state='active' where id=${id}`;
  const queue = new ExtensionQueue(t.sql, catalog.runtime);
  const { id: jobId } = await queue.enqueue(workspace, id, {
    functionId,
    input: {},
    dedupeKey: `run-${functionId}`,
  });
  const lease = await queue.claim(workspace, jobId, `worker-${functionId}`);
  if (!lease) throw new Error('missing lease');
  return lease;
}
async function lifecycleInput(id: string) {
  const rows = await db.owner<{ input: unknown }[]>`select input from extension_jobs
    where installation_id=${id} and trigger_kind='install' order by created_at desc, id desc`;
  return rows[0]?.input;
}

describe('function-scoped run credentials', () => {
  it('releases a secret only to a function that declares it, at the API and in broker SQL', async () => {
    const { workspace, id } = await setup();
    const secretRead = (token: string) =>
      t.request(`/v1/extensions/${id}/runtime/secrets/apiKey`, { key: token });
    const narrow = await run(workspace, id, reader);
    const narrowToken = await tokens.issue(t.sql, narrow, v1.universalId, narrow.scopes);
    expect((await secretRead(narrowToken)).status).toBe(404);
    const identity = {
      workspaceId: workspace,
      installationId: id,
      registrationId: v1.universalId,
      name: 'apiKey',
    };
    // The broker's own admission refuses too, independent of the API check.
    await expect(
      broker.readRuntime(identity, { ...narrow, functionId: reader, scopes: ['read'] }),
    ).rejects.toMatchObject({ code: 'installation_disabled' });
    await db.owner`update extension_jobs set status='succeeded',lease_until=null where id=${narrow.jobId}`;
    const wide = await run(workspace, id, writer);
    const wideToken = await tokens.issue(t.sql, wide, v1.universalId, wide.scopes);
    const secret = await secretRead(wideToken);
    expect(secret.status).toBe(200);
    expect(secret.body.value).toBe('sk-1');
  });

  it('binds the function ID so a run credential cannot act for another function', async () => {
    const { workspace, id } = await setup();
    const lease = await run(workspace, id, writer);
    // A job of function `writer`, presented as function `reader`.
    await expect(
      tokens.issue(t.sql, { ...lease, functionId: reader }, v1.universalId, ['read']),
    ).rejects.toMatchObject({ code: 'lease_expired' });
    const forged: RunBinding = {
      installationId: id,
      registrationId: v1.universalId,
      generation: lease.generation,
      jobId: lease.jobId,
      owner: lease.owner,
      fence: lease.fence,
      releaseDigest: lease.releaseDigest,
      functionId: reader,
      scopes: ['read'],
    };
    await expect(
      inWorkspace(t.sql, workspace, async (tx) => {
        await lockSchemaShared(tx, workspace);
        return admitRun(tx, workspace, forged, false, 'runtime');
      }),
    ).rejects.toMatchObject({ code: 'lease_expired' });
    await expect(
      broker.readRuntime(
        {
          workspaceId: workspace,
          installationId: id,
          registrationId: v1.universalId,
          name: 'apiKey',
        },
        forged,
      ),
    ).rejects.toMatchObject({ code: 'installation_disabled' });
  });

  it("intersects the run's scopes with the function's declared needs", async () => {
    const { workspace, id } = await setup();
    const lease = await run(workspace, id, reader);
    expect(lease.scopes).toEqual(['read']);
    await expect(
      tokens.issue(t.sql, lease, v1.universalId, ['read', 'write']),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const token = await tokens.issue(t.sql, lease, v1.universalId, lease.scopes);
    const write = await t.request('/v1/objects/company/records', {
      key: token,
      body: { values: { name: 'Read-only function' } },
    });
    expect(write.status).toBe(403);
    expect((await t.request('/v1/extensions', { key: token })).status).toBe(200);
  });

  it('passes the previously installed version to upgrade setup and null to a first install', async () => {
    const { key, id } = await setup();
    expect(await lifecycleInput(id)).toEqual({ previousVersion: null });
    await db.owner`update extension_installations set state='active' where id=${id}`;
    await db.owner`update extension_jobs set status='succeeded',lease_until=null where installation_id=${id}`;
    await install(
      key,
      { installationId: id, registrationId: v2.universalId, version: v2.version, settings: {} },
      'upgrade',
    );
    expect(await lifecycleInput(id)).toEqual({ previousVersion: '1.0.0' });
  });
});
