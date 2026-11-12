import { randomBytes, randomUUID } from 'node:crypto';
import { BASE_OBJECT_IDS } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { inWorkspace, lockSchemaShared } from '../../src/db/tx.js';
import { admitRun } from '../../src/extension-runtime/admission.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();

// A hosted extension with lifecycle hooks, a managed object and a view.
const objectId = randomUUID(),
  titleId = randomUUID(),
  statusId = randomUUID(),
  extraId = randomUUID(),
  viewId = randomUUID(),
  extraViewId = randomUUID();
const title = { universalId: titleId, name: 'name', label: 'Name', type: 'text' as const };
const status = { universalId: statusId, name: 'status', label: 'Status', type: 'text' as const };
const object = {
  universalId: objectId,
  nameSingular: 'ticket',
  namePlural: 'tickets',
  labelSingular: 'Ticket',
  labelPlural: 'Tickets',
  labelField: 'name',
  fields: [title, status],
};
const hooks = (
  [
    [randomUUID(), 'setup', 'install'],
    [randomUUID(), 'cleanup', 'uninstall'],
  ] as const
).map(([id, name, kind]) => ({
  universalId: id,
  name,
  description: 'Lifecycle fixture',
  handlerDigest: 'b'.repeat(64),
  timeoutSeconds: 120,
  trigger: { kind: kind as 'install' | 'uninstall' },
  inputSchema: { type: 'object' as const, additionalProperties: false as const },
}));
const managed = extensionFixture({
  scopes: ['read', 'write'],
  settings: {
    enabled: { type: 'boolean', label: 'Enabled', required: true, secret: false, reconnect: false },
  },
  schema: [{ kind: 'object', definition: object }],
  views: [{ universalId: viewId, objectId, name: 'Tickets', kind: 'table', fieldIds: [titleId] }],
  functions: hooks,
});
const managedNext = extensionFixture({
  ...managed,
  version: '1.1.0',
  schema: [
    {
      kind: 'object',
      definition: {
        ...object,
        fields: [
          ...object.fields,
          { universalId: extraId, name: 'extra', label: 'Extra', type: 'text' },
        ],
      },
    },
  ],
  views: [
    ...managed.views,
    { universalId: extraViewId, objectId, name: 'Extra', kind: 'table', fieldIds: [extraId] },
  ],
});

// An extension whose upgrade adds a required secret.
const secretSetting = {
  type: 'string' as const,
  label: 'API key',
  secret: true,
  required: true,
  reconnect: true,
};
const secretV1 = extensionFixture({ settings: { apiKey: secretSetting } });
const secretV2 = extensionFixture({
  ...secretV1,
  version: '2.0.0',
  settings: {
    apiKey: secretSetting,
    signingKey: { ...secretSetting, label: 'Signing key', reconnect: false },
  },
});

// An extension whose installed release disappears after a server upgrade.
const reFieldId = randomUUID();
const reV1 = extensionFixture({
  schema: [
    {
      kind: 'field',
      objectId: BASE_OBJECT_IDS.company,
      definition: { universalId: randomUUID(), name: 'reTier', label: 'Tier', type: 'text' },
    },
  ],
});
const reV2 = extensionFixture({
  ...reV1,
  version: '2.0.0',
  schema: [
    ...reV1.schema,
    {
      kind: 'field',
      objectId: BASE_OBJECT_IDS.company,
      definition: { universalId: reFieldId, name: 'reScore', label: 'Score', type: 'number' },
    },
  ],
});

const releases = [managed, managedNext, secretV1, secretV2, reV1, reV2];
const catalog = new ExtensionCatalog(
  releases.map((manifest) => ({ manifest, actorCeiling: 'integration', runtimeEnabled: true })),
);
const activation = new Set(
  catalog
    .list()
    .filter((r) => r.manifest.universalId === managed.universalId)
    .map((r) => r.digest),
);
let t: TestApp, tokens: RunTokens, broker: SecretBroker;
const queue = () => new ExtensionQueue(t.sql, catalog.runtime);

beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  broker = new SecretBroker(
    db.connect({ role: 'retainer_secret_broker' }),
    new SecretCipher('v1', new Map([['v1', randomBytes(32)]])),
  );
  t = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: activation,
    extensionSecrets: broker,
    runTokens: tokens,
  });
});

async function workspace() {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Control ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['read', 'write', 'schema:write'] },
    },
  );
  return { workspace: workspace.id, keys };
}
async function commit(
  key: string,
  input: Record<string, unknown>,
  receipt: string,
  path = '/v1/extensions',
) {
  const preview = await t.request('/v1/extensions/preview', { key, body: input });
  if (preview.status !== 200) return preview;
  return t.request(path, {
    key,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': receipt },
  });
}
async function installManaged() {
  const w = await workspace();
  const input = {
    registrationId: managed.universalId,
    version: managed.version,
    settings: { enabled: true },
  };
  const installed = await commit(w.keys.admin, input, 'install');
  expect(installed.status).toBe(201);
  return { ...w, input, id: installed.body.id as string };
}
async function claim(workspace: string, id: string, kind: string) {
  const [job] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind=${kind} and status='queued' order by id limit 1`;
  const claimed = await queue().claim(workspace, job?.id, randomUUID());
  if (!claimed) throw new Error(`no ${kind} job to claim`);
  return claimed;
}
const row = async (id: string) =>
  (
    await db.owner`select state,generation,version,settings_revision from extension_installations where id=${id}`
  )[0];
const deleteSchema = (key: string, operations: unknown[]) =>
  t.request('/v1/schema/changes', { key, body: { operations } });

describe('settings while uninstalling (R5)', () => {
  it('refuses a settings change during uninstall and never reverses it under concurrency', async () => {
    const h = await installManaged();
    await queue().complete(await claim(h.workspace, h.id, 'install'), { status: 'succeeded' });
    const settings = (expectedRevision: number) =>
      t.request(`/v1/extensions/${h.id}/settings`, {
        key: h.keys.admin,
        method: 'PATCH',
        body: { expectedRevision, settings: { enabled: false } },
      });
    const [uninstall, change] = await Promise.all([
      t.request(`/v1/extensions/${h.id}/uninstall`, { key: h.keys.admin, method: 'POST' }),
      settings(1),
    ]);
    expect(uninstall?.status).toBe(200);
    expect([200, 409]).toContain(change?.status);
    if (change?.status === 409) expect(change.body.error.code).toBe('installation_disabled');
    const current = await row(h.id);
    expect(current?.state).toBe('uninstalling');
    const refused = await settings(current?.settings_revision as number);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('installation_disabled');
    expect(await row(h.id)).toEqual(current);
    // Cleanup is still queued and completes the uninstall.
    await queue().complete(await claim(h.workspace, h.id, 'uninstall'), { status: 'succeeded' });
    expect((await row(h.id))?.state).toBe('uninstalled');
  });
});

describe('contributed schema (R6a)', () => {
  it('refuses deleting a contributed field or object until the extension is uninstalled', async () => {
    const h = await installManaged();
    await t.request(`/v1/extensions/${h.id}/disable`, { key: h.keys.admin, method: 'POST' });
    for (const operation of [
      { op: 'delete_field', object: 'ticket', field: 'status' },
      { op: 'delete_object', object: 'ticket' },
    ]) {
      const refused = await deleteSchema(h.keys.admin, [operation]);
      expect(refused.status).toBe(422);
      expect(refused.body.error.details.issues[0].message).toContain('uninstall the extension');
    }
    // Renaming stays workspace-local.
    expect(
      (
        await deleteSchema(h.keys.admin, [
          { op: 'rename_field', object: 'ticket', field: 'status', name: 'stage' },
        ])
      ).status,
    ).toBe(200);
    // An agent's proposal is checked again when a person approves it.
    const proposed = await deleteSchema(h.keys.agent, [
      { op: 'delete_field', object: 'ticket', field: 'stage' },
    ]);
    expect(proposed.status).toBe(422);
    await t.request(`/v1/extensions/${h.id}/uninstall`, { key: h.keys.admin, method: 'POST' });
    expect((await row(h.id))?.state).toBe('uninstalling');
    expect(
      (await deleteSchema(h.keys.admin, [{ op: 'delete_field', object: 'ticket', field: 'stage' }]))
        .status,
    ).toBe(422);
    await queue().complete(await claim(h.workspace, h.id, 'uninstall'), { status: 'succeeded' });
    expect((await row(h.id))?.state).toBe('uninstalled');
    expect(
      (await deleteSchema(h.keys.admin, [{ op: 'delete_field', object: 'ticket', field: 'stage' }]))
        .status,
    ).toBe(200);
  });
  it('rechecks a proposed delete at approval time', async () => {
    const w = await installManaged();
    const [object] =
      await db.owner`select id from object_types where universal_id=${objectId} and workspace_id=${w.workspace}`;
    expect(object).toBeDefined();
    // A proposal left before the extension was installed is decided afterward.
    const [change] = await db.owner`insert into schema_changes
      (workspace_id,status,request,operations,is_destructive,requested_by)
      values (${w.workspace},'proposed',${db.owner.json([{ op: 'delete_object', object: 'ticket' }])},
        '[]'::jsonb,true,${db.owner.json({ type: 'agent', id: 'agent' })}) returning id`;
    const decided = await t.request(`/v1/schema/changes/${change?.id}/approve`, {
      key: w.keys.admin,
      method: 'POST',
    });
    expect(decided.body.status ?? decided.body.change?.status).toBe('failed');
    expect(
      (await db.owner`select status from object_types where id=${object?.id}`)[0]?.status,
    ).toBe('active');
  });
  it('treats a contribution deleted before the rule as absent: upgrade and enable still work', async () => {
    const h = await installManaged();
    // Simulate a deletion that happened before the schema engine refused it.
    await db.owner`update object_types set status='deprecated' where universal_id=${objectId} and workspace_id=${h.workspace}`;
    await db.owner`update fields set status='deprecated' where workspace_id=${h.workspace}
      and object_type_id=(select id from object_types where universal_id=${objectId} and workspace_id=${h.workspace})`;
    const upgrade = { ...h.input, installationId: h.id, version: managedNext.version };
    const preview = await t.request('/v1/extensions/preview', { key: h.keys.admin, body: upgrade });
    expect(preview.status).toBe(200);
    expect(preview.body.operations).toEqual([]);
    expect(preview.body.views.map((v: { universalId: string }) => v.universalId)).toEqual([viewId]);
    expect(preview.body.warnings.join(' ')).toContain('View Extra is skipped');
    const upgraded = await t.request(`/v1/extensions/${h.id}/upgrade`, {
      key: h.keys.admin,
      body: { ...upgrade, planDigest: preview.body.planDigest },
      headers: { 'Idempotency-Key': 'legacy-upgrade' },
    });
    expect(upgraded.status).toBe(200);
    expect(upgraded.body.version).toBe('1.1.0');
    expect(
      await db.owner`select 1 from fields where universal_id=${extraId} and workspace_id=${h.workspace}`,
    ).toHaveLength(0);
    await t.request(`/v1/extensions/${h.id}/disable`, { key: h.keys.admin, method: 'POST' });
    const enabled = await t.request(`/v1/extensions/${h.id}/enable`, {
      key: h.keys.admin,
      method: 'POST',
    });
    expect(enabled.status).toBe(200);
    expect(enabled.body.state).toBe('installing');
  });
});

describe('secrets added by an upgrade (R6b)', () => {
  async function stage(key: string, name: string, version: string, installationId?: string) {
    const staged = await t.request('/v1/extensions/secrets', {
      key,
      body: {
        registrationId: secretV1.universalId,
        version,
        name,
        value: `${name}-value`,
        ...(installationId ? { installationId } : {}),
      },
    });
    expect(staged.status).toBe(201);
    return staged.body.pendingSecretId as string;
  }
  it('accepts a new required secret on upgrade, but existing secrets still need reconnect', async () => {
    const w = await workspace();
    const base = { registrationId: secretV1.universalId, settings: {} };
    const installed = await commit(
      w.keys.admin,
      {
        ...base,
        version: '1.0.0',
        secretRefs: { apiKey: await stage(w.keys.admin, 'apiKey', '1.0.0') },
      },
      'install',
    );
    expect(installed.status).toBe(201);
    const id = installed.body.id as string;
    const upgrade = { ...base, installationId: id, version: '2.0.0' };
    const missing = await t.request('/v1/extensions/preview', { key: w.keys.admin, body: upgrade });
    expect(missing.body.error.code).toBe('connection_required');
    // Replacing the existing credential through an upgrade is still refused.
    const replace = await t.request('/v1/extensions/preview', {
      key: w.keys.admin,
      body: {
        ...upgrade,
        secretRefs: {
          apiKey: await stage(w.keys.admin, 'apiKey', '2.0.0', id),
          signingKey: await stage(w.keys.admin, 'signingKey', '2.0.0', id),
        },
      },
    });
    expect(replace.body.error.code).toBe('connection_required');
    const upgraded = await commit(
      w.keys.admin,
      {
        ...upgrade,
        secretRefs: { signingKey: await stage(w.keys.admin, 'signingKey', '2.0.0', id) },
      },
      'upgrade',
      `/v1/extensions/${id}/upgrade`,
    );
    expect(upgraded.status).toBe(200);
    expect(upgraded.body).toMatchObject({
      version: '2.0.0',
      secrets: { apiKey: true, signingKey: true },
    });
    const identity = {
      workspaceId: w.workspace,
      installationId: id,
      registrationId: secretV1.universalId,
    };
    expect((await broker.read({ ...identity, name: 'signingKey' })).value).toBe('signingKey-value');
    expect((await broker.read({ ...identity, name: 'apiKey' })).value).toBe('apiKey-value');
  });
});

describe('reinstall after the installed release is gone (R6c)', () => {
  it('reinstalls to another compatible release through the additive plan', async () => {
    const w = await workspace();
    const base = { registrationId: reV1.universalId, settings: {} };
    const installed = await commit(w.keys.admin, { ...base, version: '1.0.0' }, 'install');
    expect(installed.status).toBe(201);
    const id = installed.body.id as string;
    const bindings = async () =>
      db.owner`select kind,universal_id,element_id from extension_contributions where installation_id=${id} order by universal_id`;
    const before = await bindings();
    await t.request(`/v1/extensions/${id}/uninstall`, { key: w.keys.admin, method: 'POST' });
    expect((await row(id))?.state).toBe('uninstalled');
    // After a server upgrade the catalog no longer carries 1.0.0.
    const bumped = startTestApp(db, {
      extensionCatalog: new ExtensionCatalog([
        { manifest: reV2, actorCeiling: 'integration', runtimeEnabled: true },
      ]),
    });
    const input = { ...base, version: '2.0.0' };
    expect(
      (
        await bumped.request('/v1/extensions/preview', {
          key: w.keys.admin,
          body: { ...input, version: '1.0.0' },
        })
      ).status,
    ).toBe(404);
    const preview = await bumped.request('/v1/extensions/preview', {
      key: w.keys.admin,
      body: input,
    });
    expect(preview.status).toBe(200);
    expect(preview.body.operations).toHaveLength(1);
    const reinstalled = await bumped.request('/v1/extensions', {
      key: w.keys.admin,
      body: { ...input, planDigest: preview.body.planDigest },
      headers: { 'Idempotency-Key': 'reinstall' },
    });
    expect(reinstalled.status).toBe(201);
    expect(reinstalled.body).toMatchObject({ id, version: '2.0.0' });
    const after = await bindings();
    for (const binding of before) expect(after).toContainEqual(binding);
    expect(after.map((b) => b.universal_id)).toContain(reFieldId);
    // Upgrading an uninstalled installation is still refused.
    await bumped.request(`/v1/extensions/${id}/uninstall`, { key: w.keys.admin, method: 'POST' });
    const upgrade = await bumped.request('/v1/extensions/preview', {
      key: w.keys.admin,
      body: { ...input, installationId: id },
    });
    expect(upgrade.body.error.code).toBe('upgrade_conflict');
  });
});

describe('run admission (R12)', () => {
  it('requires write scope for writes and refuses a workspace scheduled for deletion', async () => {
    const h = await installManaged();
    const run = await claim(h.workspace, h.id, 'install');
    const token = await tokens.issue(t.sql, run, managed.universalId, ['read']);
    const caller = await tokens.authenticate(t.sql, token);
    const admit = (write: boolean) =>
      inWorkspace(t.sql, h.workspace, async (tx) => {
        await lockSchemaShared(tx, h.workspace);
        if (!caller.run) throw new Error('missing run');
        return admitRun(tx, h.workspace, caller.run, write, 'runtime');
      });
    await expect(admit(false)).resolves.toMatchObject({ scopes: ['read'] });
    await expect(admit(true)).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await db.owner`update workspaces set deletion_scheduled_at=now() where id=${h.workspace}`;
    await expect(admit(false)).rejects.toMatchObject({ code: 'installation_disabled' });
    await expect(tokens.authenticate(t.sql, token)).rejects.toMatchObject({
      code: 'installation_disabled',
    });
  });
});
