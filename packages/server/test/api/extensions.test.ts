import { randomUUID } from 'node:crypto';
import { defineExtension } from '@retainer/extension';
import { RetainerClient } from '@retainer/sdk';
import { BASE_OBJECT_IDS } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const registrationId = randomUUID(),
  fieldId = randomUUID(),
  viewId = randomUUID();
const manifest = defineExtension({
  manifestVersion: 1,
  universalId: registrationId,
  name: 'fixture',
  version: '1.0.0',
  description: 'Test fixture',
  packageDigest: 'a'.repeat(64),
  serverVersions: ['0.1.0'],
  runtimeVersion: 'node24',
  protocolVersion: 1,
  execution: 'hosted',
  requestedActor: 'integration',
  scopes: ['read', 'write'],
  connection: 'workspace',
  createPeople: 'never',
  onSourceDelete: 'keep',
  settings: { enabled: { type: 'boolean', label: 'Enabled', required: true } },
  schema: [
    {
      kind: 'field',
      objectId: BASE_OBJECT_IDS.company,
      definition: {
        universalId: fieldId,
        name: 'fixtureStatus',
        label: 'Fixture status',
        type: 'text',
      },
    },
  ],
  views: [
    {
      universalId: viewId,
      objectId: BASE_OBJECT_IDS.company,
      name: 'Fixture companies',
      kind: 'table',
      fieldIds: [fieldId],
    },
  ],
  functions: [],
});
const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
let t: TestApp, keys: Record<'admin' | 'agent' | 'reader', string>, otherKey: string;
beforeAll(async () => {
  t = startTestApp(db, { extensionCatalog: catalog });
  ({ keys } = await t.setupWorkspace(
    { name: 'Extensions' },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['admin'] },
      reader: { actor: { type: 'user', id: 'reader' }, scopes: ['read'] },
    },
  ));
  otherKey = (
    await t.setupWorkspace(
      { name: 'Other' },
      {
        admin: { actor: { type: 'user', id: 'other' }, scopes: ['admin'] },
      },
    )
  ).keys.admin;
});
const input = { registrationId, version: '1.0.0', settings: { enabled: true } };
const preview = (key = keys.admin) => t.request('/v1/extensions/preview', { key, body: input });
const install = (planDigest: string, key = keys.admin, receipt = 'install-1') =>
  t.request('/v1/extensions', {
    key,
    body: { ...input, planDigest },
    headers: { 'Idempotency-Key': receipt },
  });
let id: string, originalDigest: string;

describe('inert extension control with real RLS Postgres', () => {
  it('previews without mutation and forbids agent approval', async () => {
    const p = await preview(keys.agent);
    expect(p.status).toBe(200);
    originalDigest = p.body.planDigest;
    expect((await install(originalDigest, keys.agent)).status).toBe(403);
    expect((await t.request('/v1/extensions', { key: keys.reader })).body.installations).toEqual(
      [],
    );
    expect((await preview(keys.reader)).status).toBe(403);
  });
  it('serializes concurrent installs into one installation/schema/view and replays durably', async () => {
    const results = await Promise.all([install(originalDigest), install(originalDigest)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0]?.body).toEqual(results[1]?.body);
    id = results[0]?.body.id;
    expect(results[0]?.body).toMatchObject({
      state: 'disabled',
      generation: 1,
      grantedActor: 'integration',
    });
    const [countRow] =
      await db.owner`select count(*)::int as count from extension_installations where id = ${id}`;
    expect(countRow?.count).toBe(1);
    expect((await install(originalDigest, keys.admin, 'competing-install')).status).toBe(409);
    const response = await t.request(`/v1/extensions/${id}`, { key: keys.reader });
    expect(response.body.contributions).toHaveLength(2);
    expect(
      (await t.request(`/v1/extensions/${id}/enable`, { key: keys.admin, method: 'POST' })).body
        .error.code,
    ).toBe('incompatible_runtime');
  });
  it('cannot read or transition another workspace installation', async () => {
    expect((await t.request(`/v1/extensions/${id}`, { key: otherKey })).status).toBe(404);
    expect(
      (await t.request(`/v1/extensions/${id}/uninstall`, { key: otherKey, method: 'POST' })).status,
    ).toBe(404);
    expect((await t.request('/v1/extensions', { key: otherKey })).body.installations).toEqual([]);
    const rows = await t.sql`select * from extension_installations`;
    expect(rows).toHaveLength(0); // no workspace context means no rows
  });
  it('exposes read/preview MCP tools without an approval tool', async () => {
    const client = await t.mcpClient(keys.agent);
    try {
      expect((await client.call('get_extension', { id })).body.id).toBe(id);
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('preview_extension');
      expect(tools).not.toContain('install_extension');
    } finally {
      await client.close();
    }
  });
  it('uninstalls while retaining schema and user-edited views, rejects old receipt replay', async () => {
    const detail = await t.request(`/v1/extensions/${id}`, { key: keys.admin });
    const view = detail.body.contributions.find((c: { kind: string }) => c.kind === 'view');
    expect(
      (
        await t.request(`/v1/views/${view.elementId}`, {
          key: keys.admin,
          method: 'PATCH',
          body: { name: 'Our name' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await t.request(`/v1/extensions/${id}/uninstall`, { key: keys.admin, method: 'POST' })).body
        .generation,
    ).toBe(2);
    expect((await install(originalDigest)).body.error.code).toBe('stale_plan');
    const p = await preview();
    expect(p.status).toBe(200);
    const reinstalled = await install(p.body.planDigest, keys.admin, 'reinstall');
    expect(reinstalled.status).toBe(201);
    expect(reinstalled.body).toMatchObject({ id, state: 'disabled', generation: 3 });
    expect((await t.request(`/v1/views/${view.elementId}`, { key: keys.admin })).body.name).toBe(
      'Our name',
    );
  });
  it('rejects stale schema previews in a separate workspace', async () => {
    const p = await preview(otherKey);
    expect(p.status).toBe(200);
    expect(
      (
        await t.request('/v1/schema/changes', {
          key: otherKey,
          body: {
            operations: [
              {
                op: 'create_field',
                object: 'company',
                field: { name: 'changed', label: 'Changed', type: 'text' },
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    expect((await install(p.body.planDigest, otherKey, 'stale')).body.error.code).toBe(
      'stale_plan',
    );
    expect((await t.request('/v1/extensions', { key: otherKey })).body.installations).toEqual([]);
  });
  it('rejects non-bundled manifests and plaintext secret settings', async () => {
    expect(
      (await t.request('/v1/extensions/preview', { key: otherKey, body: { ...input, manifest } }))
        .status,
    ).toBe(400);
    expect(
      (
        await t.request('/v1/extensions/preview', {
          key: otherKey,
          body: { ...input, settings: { apiKey: 'do-not-store' } },
        })
      ).body.error.code,
    ).toBe('invalid_settings');
  });
  it('rolls schema, views, installation and receipt back on a database failure during ownership persistence', async () => {
    const isolated = await t.setupWorkspace(
      { name: 'Fault boundary' },
      {
        admin: { actor: { type: 'user', id: 'fault-admin' }, scopes: ['admin'] },
      },
    );
    const p = await preview(isolated.keys.admin);
    expect(p.status).toBe(200);
    // A real database fault after schema application, not a mocked transaction.
    await db.owner.unsafe(`create function extension_test_fault() returns trigger language plpgsql as $$
      begin if new.workspace_id = '${isolated.workspace.id}'::uuid then
        raise exception 'test contribution persistence fault'; end if; return new; end $$`);
    await db.owner.unsafe(`create trigger extension_test_fault before insert on extension_contributions
      for each row execute function extension_test_fault()`);
    try {
      expect((await install(p.body.planDigest, isolated.keys.admin, 'fault')).status).toBe(500);
      const [row] = await db.owner`select
        (select count(*)::int from extension_installations where workspace_id = ${isolated.workspace.id}) as installs,
        (select count(*)::int from fields where workspace_id = ${isolated.workspace.id} and universal_id = ${fieldId}) as fields,
        (select count(*)::int from extension_receipts where workspace_id = ${isolated.workspace.id}) as receipts`;
      expect(row).toEqual({ installs: 0, fields: 0, receipts: 0 });
    } finally {
      await db.owner.unsafe('drop trigger extension_test_fault on extension_contributions');
      await db.owner.unsafe('drop function extension_test_fault()');
    }
    // The same plan and receipt can succeed after the fault is fixed.
    expect((await install(p.body.planDigest, isolated.keys.admin, 'fault')).status).toBe(201);
  });
  it('keeps a deprecated field deprecated on reinstall, and disable cannot undo uninstall', async () => {
    expect(
      (await t.request(`/v1/extensions/${id}/uninstall`, { key: keys.admin, method: 'POST' }))
        .status,
    ).toBe(200);
    expect(
      (await t.request(`/v1/extensions/${id}/disable`, { key: keys.admin, method: 'POST' })).body
        .state,
    ).toBe('uninstalled');
    expect(
      (
        await t.request('/v1/schema/changes', {
          key: keys.admin,
          body: { operations: [{ op: 'delete_field', object: 'company', field: 'fixtureStatus' }] },
        })
      ).status,
    ).toBe(200);
    const p = await preview();
    expect(p.status).toBe(200);
    expect((await install(p.body.planDigest, keys.admin, 'deprecated-reinstall')).status).toBe(201);
    const [field] = await db.owner`select status from fields where universal_id = ${fieldId}
      and object_type_id in (select id from object_types where workspace_id =
        (select workspace_id from extension_installations where id = ${id}))`;
    expect(field?.status).toBe('deprecated');
  });
  it('supports the SDK preview, approval receipt, read and retention flow', async () => {
    const workspace = await t.setupWorkspace(
      { name: 'SDK extensions' },
      {
        admin: { actor: { type: 'user', id: 'sdk-admin' }, scopes: ['admin'] },
      },
    );
    const sdk = new RetainerClient({
      baseUrl: 'http://retainer.test/',
      apiKey: workspace.keys.admin,
      fetch: t.inProcessFetch,
    });
    expect((await sdk.extensionCatalog()).releases).toHaveLength(1);
    const p = await sdk.previewExtension(input);
    expect(p.grants.actor).toBe('integration');
    expect(p.views[0]?.action).toBe('create');
    const installed = await sdk.installExtension(
      { ...input, planDigest: p.planDigest },
      'sdk-install',
    );
    expect(
      (await sdk.installExtension({ ...input, planDigest: p.planDigest }, 'sdk-install')).id,
    ).toBe(installed.id);
    expect((await sdk.extension(installed.id)).contributions).toHaveLength(2);
    expect((await sdk.extensions()).installations).toHaveLength(1);
    expect((await sdk.disableExtension(installed.id)).state).toBe('disabled');
    await Promise.all([
      sdk.uninstallExtension(installed.id),
      ...Array.from({ length: 6 }, () => sdk.disableExtension(installed.id)),
    ]);
    expect((await sdk.extension(installed.id)).state).toBe('uninstalled');
  });
});

describe('explicit source sharing and settings choices', () => {
  it('requires affirmative consent and rejects invalid choices before any installation can commit', async () => {
    const safe = defineExtension({
      ...manifest,
      universalId: randomUUID(),
      schema: [],
      views: [],
      settings: {
        share: {
          type: 'boolean',
          label: 'Share accessible provider notes',
          required: true,
          consent: true,
          default: false,
        },
        createPeople: {
          type: 'string',
          label: 'Create contacts',
          required: true,
          options: ['never', 'contacted_first', 'everyone'],
          default: 'never',
        },
      },
    });
    const app = startTestApp(db, {
      extensionCatalog: new ExtensionCatalog([{ manifest: safe, actorCeiling: 'integration' }]),
    });
    const { keys } = await app.setupWorkspace(
      { name: `Sharing ${randomUUID()}` },
      { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
    );
    const input = {
      registrationId: safe.universalId,
      version: safe.version,
      settings: { share: false, createPeople: 'never' },
    };
    expect(
      (await app.request('/v1/extensions/preview', { key: keys.admin, body: input })).status,
    ).toBe(422);
    expect(
      (
        await app.request('/v1/extensions/preview', {
          key: keys.admin,
          body: { ...input, settings: { share: true, createPeople: 'invalid' } },
        })
      ).status,
    ).toBe(422);
    expect(
      (await app.request('/v1/extensions', { key: keys.admin })).body.installations,
    ).toHaveLength(0);
    expect(
      (
        await app.request('/v1/extensions/preview', {
          key: keys.admin,
          body: { ...input, settings: { share: true, createPeople: 'never' } },
        })
      ).status,
    ).toBe(200);
  });
});
