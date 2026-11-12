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
  requestedActor: 'agent',
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
const grant = extensionFixture({
  ...next,
  requestedActor: 'integration',
  version: '3.0.0',
  scopes: ['read', 'write'],
});
const renamed = extensionFixture({
  ...base,
  version: '4.0.0',
  schema: [{ kind: 'field', objectId, definition: { ...status, label: 'Publisher status' } }],
});
const reviewed = extensionFixture({
  ...base,
  version: '5.0.0',
  views: [
    {
      universalId: viewId,
      objectId,
      name: 'Publisher items',
      kind: 'table',
      fieldIds: [fieldId, titleId],
    },
  ],
});
const moved = extensionFixture({
  ...base,
  version: '6.0.0',
  views: [
    { universalId: viewId, objectId: randomUUID(), name: 'Moved', kind: 'table', fieldIds: [] },
  ],
});
let t: TestApp;
beforeAll(() => {
  t = startTestApp(db, {
    extensionCatalog: new ExtensionCatalog(
      [base, next, bad, grant, renamed, reviewed, moved].map((manifest) => ({
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
  it('rejects structural and grant changes before applying anything', async () => {
    const { sdk, installed, input } = await setup();
    await expect(
      sdk.previewExtension({ ...input, installationId: installed.id, version: '2.0.0' }),
    ).rejects.toMatchObject({ code: 'upgrade_conflict', details: { properties: ['type'] } });
    await expect(
      sdk.previewExtension({ ...input, installationId: installed.id, version: '3.0.0' }),
    ).rejects.toMatchObject({ code: 'grant_required' });
    // A view cannot move to another object: that needs a new view identity.
    await expect(
      sdk.previewExtension({ ...input, installationId: installed.id, version: '6.0.0' }),
    ).rejects.toMatchObject({ code: 'upgrade_conflict' });
    expect((await sdk.extension(installed.id)).version).toBe('1.0.0');
  });
  it('keeps a workspace label over a publisher label change and updates only the base', async () => {
    const { sdk, installed, input } = await setup();
    await sdk.proposeSchemaChange([
      { op: 'update_field', object: 'fixtureItem', field: 'status', label: 'Our status' },
    ]);
    const upgrade = { ...input, installationId: installed.id, version: '4.0.0' };
    const plan = await sdk.previewExtension(upgrade);
    expect(plan.operations).toEqual([]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('keeps the label set in this workspace')]),
    );
    await sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'keep');
    const object = (await sdk.schema()).objects.find((o) => o.nameSingular === 'fixtureItem');
    expect(object?.fields.find((f) => f.name === 'status')?.label).toBe('Our status');
    const [base] = await db.owner<{ definition: { label: string } }[]>`
      select definition from extension_contributions
      where installation_id = ${installed.id} and universal_id = ${fieldId}`;
    expect(base?.definition.label).toBe('Publisher status');
    expect((await sdk.extension(installed.id)).version).toBe('4.0.0');
  });
  it('applies a publisher view change to an unedited view', async () => {
    const { sdk, installed, input } = await setup();
    const view = (await sdk.extension(installed.id)).contributions.find((c) => c.kind === 'view');
    if (!view) throw new Error('missing view');
    const upgrade = { ...input, installationId: installed.id, version: '5.0.0' };
    const plan = await sdk.previewExtension(upgrade);
    expect(plan.views).toEqual([
      { universalId: viewId, name: 'Publisher items', action: 'update' },
    ]);
    await sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'view');
    const saved = await sdk.view(view.elementId);
    expect(saved.name).toBe('Publisher items');
    expect(saved.columns?.order).toEqual(['status', 'name']);
  });
  it('keeps a workspace-edited view and reports it without blocking the upgrade', async () => {
    const { sdk, installed, input } = await setup();
    const view = (await sdk.extension(installed.id)).contributions.find((c) => c.kind === 'view');
    if (!view) throw new Error('missing view');
    await sdk.updateView(view.elementId, { name: 'Our view' });
    const upgrade = { ...input, installationId: installed.id, version: '5.0.0' };
    const plan = await sdk.previewExtension(upgrade);
    expect(plan.views).toEqual([
      { universalId: viewId, name: 'Publisher items', action: 'keep_workspace' },
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('keeps the version edited in this workspace'),
      ]),
    );
    await sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'keep');
    const saved = await sdk.view(view.elementId);
    expect(saved.name).toBe('Our view');
    expect(saved.columns?.order).toEqual(['name', 'status']);
    expect((await sdk.extension(installed.id)).version).toBe('5.0.0');
  });
  it('does not recreate or rebase a view the workspace deleted', async () => {
    const { sdk, installed, input } = await setup();
    const view = (await sdk.extension(installed.id)).contributions.find((c) => c.kind === 'view');
    if (!view) throw new Error('missing view');
    await sdk.deleteView(view.elementId);
    const upgrade = { ...input, installationId: installed.id, version: '5.0.0' };
    const plan = await sdk.previewExtension(upgrade);
    expect(plan.views).toEqual([
      { universalId: viewId, name: 'Publisher items', action: 'deleted_workspace' },
    ]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('deleted in this workspace; it is not recreated'),
      ]),
    );
    await sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'gone');
    const [row] = await db.owner<{ definition: { name: string } }[]>`
      select definition from extension_contributions
      where installation_id = ${installed.id} and universal_id = ${viewId}`;
    expect(row?.definition.name).toBe('Fixture items');
    const [count] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from views
      where workspace_id = (select workspace_id from extension_installations where id = ${installed.id})
        and name = 'Publisher items'`;
    expect(count?.n).toBe(0);
  });
  it('refuses a stale view decision: an edit after preview invalidates the plan', async () => {
    const { sdk, installed, input } = await setup();
    const view = (await sdk.extension(installed.id)).contributions.find((c) => c.kind === 'view');
    if (!view) throw new Error('missing view');
    const upgrade = { ...input, installationId: installed.id, version: '5.0.0' };
    const plan = await sdk.previewExtension(upgrade);
    await sdk.updateView(view.elementId, { name: 'Late edit' });
    await expect(
      sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'late'),
    ).rejects.toMatchObject({ code: 'stale_plan' });
    expect((await sdk.view(view.elementId)).name).toBe('Late edit');
  });
  it('never overwrites a view edit that races the upgrade', async () => {
    const { sdk, installed, input } = await setup();
    const view = (await sdk.extension(installed.id)).contributions.find((c) => c.kind === 'view');
    if (!view) throw new Error('missing view');
    const upgrade = { ...input, installationId: installed.id, version: '5.0.0' };
    const plan = await sdk.previewExtension(upgrade);
    const [upgraded] = await Promise.allSettled([
      sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'race'),
      sdk.updateView(view.elementId, { name: 'Racing edit' }),
    ]);
    if (upgraded.status === 'rejected')
      expect(upgraded.reason).toMatchObject({ code: 'stale_plan' });
    // Whichever committed first, the workspace's edit is the view's final name.
    expect((await sdk.view(view.elementId)).name).toBe('Racing edit');
  });
  it('requires a distinct human approval plan for scope and actor increases and atomically replaces the grant', async () => {
    expect(() => new ExtensionCatalog([{ manifest: grant, actorCeiling: 'agent' }])).toThrow(
      'does not permit requested actor',
    );
    expect(
      () =>
        new ExtensionCatalog([
          { manifest: base, actorCeiling: 'agent' },
          { manifest: grant, actorCeiling: 'integration' },
        ]),
    ).toThrow('ceiling cannot change');
    const { sdk, installed, input, keys } = await setup();
    const upgrade = { ...input, installationId: installed.id, version: '3.0.0', grantChange: true };
    const plan = await sdk.previewExtension(upgrade);
    expect(plan.previousGrants).toEqual({ actor: 'agent', scopes: ['read'] });
    expect(plan.grants).toEqual({ actor: 'integration', scopes: ['read', 'write'] });
    const agent = new RetainerClient({
      baseUrl: 'http://retainer.test/',
      apiKey: keys.agent,
      fetch: t.inProcessFetch,
    });
    await expect(
      agent.upgradeExtension(
        installed.id,
        { ...upgrade, planDigest: plan.planDigest },
        'agent-grant',
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      sdk.upgradeExtension(
        installed.id,
        { ...upgrade, grantChange: false, planDigest: plan.planDigest },
        'ordinary-upgrade',
      ),
    ).rejects.toMatchObject({ code: 'grant_required' });
    expect((await sdk.extension(installed.id)).grantedActor).toBe('agent');
    const results = await Promise.all([
      sdk.upgradeExtension(
        installed.id,
        { ...upgrade, planDigest: plan.planDigest },
        'approve-grant',
      ),
      sdk.upgradeExtension(
        installed.id,
        { ...upgrade, planDigest: plan.planDigest },
        'approve-grant',
      ),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      grantedActor: 'integration',
      grantedScopes: ['read', 'write'],
      generation: 2,
    });
    await expect(
      sdk.upgradeExtension(
        installed.id,
        { ...upgrade, planDigest: plan.planDigest },
        'stale-grant',
      ),
    ).rejects.toMatchObject({ code: 'stale_plan' });
  });
  it('updates publisher labels when unmodified, retains omitted schema and deprecated fields', async () => {
    const { sdk, installed, input } = await setup();
    const upgrade = { ...input, installationId: installed.id, version: '4.0.0' };
    const plan = await sdk.previewExtension(upgrade);
    await sdk.upgradeExtension(installed.id, { ...upgrade, planDigest: plan.planDigest }, 'label');
    const object = (await sdk.schema()).objects.find((o) => o.nameSingular === 'fixtureItem');
    expect(object?.fields.find((f) => f.name === 'status')?.label).toBe('Publisher status');
    expect(object?.fields.find((f) => f.name === 'name')).toBeDefined();
    // An installed extension's field can't be deleted through the schema engine.
    await expect(
      sdk.proposeSchemaChange([{ op: 'delete_field', object: 'fixtureItem', field: 'status' }]),
    ).rejects.toMatchObject({ code: 'schema_invalid' });
    // A field deleted before that rule (simulated here) stays deprecated; a
    // same-release preview never reactivates it.
    await db.owner`update fields set status='deprecated' where universal_id=${fieldId}
      and workspace_id=(select workspace_id from extension_installations where id=${installed.id})`;
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
