import { randomUUID } from 'node:crypto';
import { RetainerClient } from '@retainer/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const registrationId = randomUUID(),
  objectId = randomUUID(),
  titleId = randomUUID(),
  fieldId = randomUUID(),
  newFieldId = randomUUID(),
  viewId = randomUUID();
const title = { universalId: titleId, name: 'name', label: 'Name', type: 'text' as const };
const status = { universalId: fieldId, name: 'status', label: 'Status', type: 'text' as const };
const base = extensionFixture({
  universalId: registrationId,
  settings: {
    enabled: { type: 'boolean', label: 'Enabled', required: true, secret: false, reconnect: false },
  },
  schema: [
    {
      kind: 'object',
      definition: {
        universalId: objectId,
        nameSingular: 'fixtureItem',
        namePlural: 'fixtureItems',
        labelSingular: 'Fixture item',
        labelPlural: 'Fixture items',
        labelField: 'name',
        fields: [title, status],
      },
    },
  ],
  views: [
    {
      universalId: viewId,
      objectId,
      name: 'Fixture items',
      kind: 'table',
      fieldIds: [titleId, fieldId],
    },
  ],
});
const next = extensionFixture({
  ...base,
  version: '1.1.0',
  schema: [
    {
      kind: 'object',
      definition: {
        ...base.schema[0]?.definition,
        universalId: objectId,
        nameSingular: 'fixtureItem',
        namePlural: 'fixtureItems',
        labelSingular: 'Fixture item',
        labelPlural: 'Fixture items',
        labelField: 'name',
        fields: [
          title,
          status,
          { universalId: newFieldId, name: 'extra', label: 'Extra', type: 'text' },
        ],
      },
    },
  ],
});
const bad = extensionFixture({
  ...base,
  version: '2.0.0',
  schema: [{ kind: 'field', objectId, definition: { ...status, type: 'number' } }],
});
const grant = extensionFixture({ ...next, version: '3.0.0', scopes: ['read', 'write'] });
const renamed = extensionFixture({
  ...base,
  version: '4.0.0',
  schema: [{ kind: 'field', objectId, definition: { ...status, label: 'Publisher status' } }],
});
let t: TestApp;
beforeAll(() => {
  t = startTestApp(db, {
    extensionCatalog: new ExtensionCatalog(
      [base, next, bad, grant, renamed].map((manifest) => ({
        manifest,
        actorCeiling: 'integration',
      })),
    ),
  });
});
async function setup() {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Upgrade test ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['admin'] },
    },
  );
  const sdk = new RetainerClient({
    baseUrl: 'http://retainer.test/',
    apiKey: keys.admin,
    fetch: t.inProcessFetch,
  });
  const input = { registrationId, version: '1.0.0', settings: { enabled: true } };
  const p = await sdk.previewExtension(input);
  const installed = await sdk.installExtension({ ...input, planDigest: p.planDigest }, 'install');
  return { workspace, keys, sdk, installed, input };
}
describe('additive extension upgrades', () => {
  it('adds fields to a managed object, preserves local renames/views, and replays concurrent upgrade receipts', async () => {
    const { sdk, installed, input } = await setup();
    await sdk.proposeSchemaChange([
      { op: 'rename_field', object: 'fixtureItem', field: 'status', name: 'localStatus' },
    ]);
    const detail = await sdk.extension(installed.id);
    const view = detail.contributions.find((c) => c.kind === 'view');
    if (!view) throw new Error('missing view');
    await sdk.updateView(view.elementId, { name: 'Our view' });
    const upgrade = { ...input, installationId: installed.id, version: '1.1.0' };
    const plan = await sdk.previewExtension(upgrade);
    const results = await Promise.all([
      sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'upgrade'),
      sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'upgrade'),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ version: '1.1.0', generation: 2, state: 'disabled' });
    const object = (await sdk.schema()).objects.find((o) => o.nameSingular === 'fixtureItem');
    expect(object?.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['localStatus', 'extra']),
    );
    expect((await sdk.view(view.elementId)).name).toBe('Our view');
  });
  it('rejects structural changes, grant escalation and conflicting publisher labels before applying anything', async () => {
    const { sdk, installed, input } = await setup();
    await expect(
      sdk.previewExtension({ ...input, installationId: installed.id, version: '2.0.0' }),
    ).rejects.toMatchObject({ code: 'upgrade_conflict', details: { properties: ['type'] } });
    await expect(
      sdk.previewExtension({ ...input, installationId: installed.id, version: '3.0.0' }),
    ).rejects.toMatchObject({ code: 'grant_required' });
    await sdk.proposeSchemaChange([
      { op: 'update_field', object: 'fixtureItem', field: 'status', label: 'Our status' },
    ]);
    await expect(
      sdk.previewExtension({ ...input, installationId: installed.id, version: '4.0.0' }),
    ).rejects.toMatchObject({ code: 'upgrade_conflict', details: { properties: ['label'] } });
    expect((await sdk.extension(installed.id)).version).toBe('1.0.0');
  });
  it('updates publisher labels when unmodified, retains omitted schema and deprecated fields', async () => {
    const { sdk, installed, input } = await setup();
    const upgrade = { ...input, installationId: installed.id, version: '4.0.0' };
    const plan = await sdk.previewExtension(upgrade);
    await sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'label');
    const object = (await sdk.schema()).objects.find((o) => o.nameSingular === 'fixtureItem');
    expect(object?.fields.find((f) => f.name === 'status')?.label).toBe('Publisher status');
    expect(object?.fields.find((f) => f.name === 'name')).toBeDefined();
    await sdk.proposeSchemaChange([{ op: 'delete_field', object: 'fixtureItem', field: 'status' }]);
    // Same release preview keeps a deprecated field; it never reactivates it.
    const again = await sdk.previewExtension(upgrade);
    await sdk.upgradeExtension(
      installed.id,
      { ...upgrade, planDigest: again.planDigest },
      'deprecated',
    );
    const [field] =
      await db.owner`select status from fields where universal_id=${fieldId} and workspace_id=(select workspace_id from extension_installations where id=${installed.id})`;
    expect(field?.status).toBe('deprecated');
  });
  it('serializes settings CAS, invalidates a preview, and forbids agent mutations', async () => {
    const { sdk, installed, input, keys } = await setup();
    const upgrade = { ...input, installationId: installed.id, version: '1.1.0' };
    const p = await sdk.previewExtension(upgrade);
    const results = await Promise.allSettled([
      sdk.updateExtensionSettings(installed.id, {
        expectedRevision: 1,
        settings: { enabled: false },
      }),
      sdk.updateExtensionSettings(installed.id, {
        expectedRevision: 1,
        settings: { enabled: false },
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(
      sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: p.planDigest }, 'stale'),
    ).rejects.toMatchObject({ code: 'stale_plan' });
    expect(
      (
        await t.request(`/v1/extensions/${installed.id}/settings`, {
          key: keys.agent,
          method: 'PATCH',
          body: { expectedRevision: 2, settings: { enabled: true } },
        })
      ).status,
    ).toBe(403);
    const current = await sdk.extension(installed.id);
    expect(current.settingsRevision).toBe(2);
    expect(
      (
        await sdk.updateExtensionSettings(installed.id, {
          expectedRevision: 2,
          settings: current.settings,
        })
      ).settingsRevision,
    ).toBe(2);
  });
});
