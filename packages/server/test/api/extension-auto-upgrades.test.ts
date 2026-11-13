import { randomUUID } from 'node:crypto';
import { RetainerClient } from '@retainer/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { Extensions } from '../../src/extensions/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const enabled = {
  type: 'boolean' as const,
  label: 'Enabled',
  required: true,
  secret: false,
  reconnect: false,
};
/** A standalone release is active as soon as it is approved and always runnable. */
const release = (universalId: string, version: string, overrides = {}) =>
  extensionFixture({
    universalId,
    version,
    execution: 'standalone',
    requestedActor: 'agent',
    settings: { enabled },
    ...overrides,
  });

// One registration per scenario, so each test reads its own newest release.
const same = randomUUID(),
  wider = randomUUID(),
  setting = randomUUID(),
  disabled = randomUUID(),
  racing = randomUUID(),
  hosted = randomUUID();
const releases = [
  release(same, '1.0.0'),
  // Only the version differs: the build bumps it on every commit to main.
  release(same, '1.0.10'),
  release(wider, '1.0.0'),
  release(wider, '1.0.1', { scopes: ['read', 'write'] }),
  release(setting, '1.0.0'),
  release(setting, '1.0.1', {
    settings: {
      enabled,
      region: { type: 'string', label: 'Region', required: false, secret: false, reconnect: false },
    },
  }),
  release(disabled, '1.0.0'),
  release(disabled, '1.0.1'),
  release(racing, '1.0.0'),
  release(racing, '1.0.1'),
  release(hosted, '1.0.0', { execution: 'hosted' }),
  release(hosted, '1.0.1', { execution: 'hosted' }),
];
const catalog = new ExtensionCatalog(
  releases.map((manifest) => ({ manifest, actorCeiling: 'agent', runtimeEnabled: true })),
);

let t: TestApp;
let extensions: Extensions;
let executorSql: ReturnType<typeof db.connect>;
const discovery = () => executorSql;
beforeAll(() => {
  t = startTestApp(db, { extensionCatalog: catalog });
  executorSql = db.connect({ role: 'retainer_executor', max: 1 });
  // No hosted executable is deployed: hosted releases are never a target.
  extensions = new Extensions(
    db.connect({ role: RUNTIME_ROLE, max: 4 }),
    catalog,
    undefined,
    new Set(),
  );
});

async function install(registrationId: string) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Auto upgrade ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const sdk = new RetainerClient({
    baseUrl: 'http://retainer.test/',
    apiKey: keys.admin,
    fetch: t.inProcessFetch,
  });
  const input = { registrationId, version: '1.0.0', settings: { enabled: true } };
  const plan = await sdk.previewExtension(input);
  const installed = await sdk.installExtension(
    { ...input, planDigest: plan.planDigest },
    'install',
  );
  return { sdk, installed, workspaceId: workspace.id };
}
const row = async (id: string) => {
  const [found] = await db.owner<
    { version: string; state: string; generation: number; upgrade_held_digest: string | null }[]
  >`select version, state, generation, upgrade_held_digest from extension_installations where id = ${id}`;
  if (!found) throw new Error('installation missing');
  return found;
};

describe('automatic extension upgrades', () => {
  it('upgrades on its own when only the version changes, once', async () => {
    const { installed } = await install(same);
    expect(installed).toMatchObject({ version: '1.0.0', state: 'active' });
    const before = await row(installed.id);
    const first = await extensions.upgradeDue(discovery());
    expect(first.upgraded).toBeGreaterThanOrEqual(1);
    const after = await row(installed.id);
    expect(after).toMatchObject({ version: '1.0.10', state: 'active', upgrade_held_digest: null });
    expect(after.generation).toBe(before.generation + 1);
    // Recorded as the server's own work, not a person's approval.
    const [receipt] = await db.owner<{ key: string }[]>`
      select key from extension_receipts where installation_id = ${installed.id} and key like 'auto-upgrade:%'`;
    expect(receipt).toBeDefined();
    // Already on the newest release: the next pass does not touch it.
    await extensions.upgradeDue(discovery());
    expect((await row(installed.id)).generation).toBe(after.generation);
  });

  it('holds an upgrade that asks for more access, and does not check it again', async () => {
    const { installed, workspaceId } = await install(wider);
    await extensions.upgradeDue(discovery());
    const held = await row(installed.id);
    expect(held).toMatchObject({ version: '1.0.0', state: 'active' });
    expect(held.upgrade_held_digest).toBe(catalog.get(wider, '1.0.1').digest);
    // Held for this release: a direct retry skips it rather than planning again.
    expect(await extensions.autoUpgrade(workspaceId, installed.id)).toBe('skipped');
  });

  it('holds an upgrade that adds a setting and leaves the installed release running', async () => {
    const { installed } = await install(setting);
    await extensions.upgradeDue(discovery());
    const held = await row(installed.id);
    expect(held).toMatchObject({ version: '1.0.0', state: 'active' });
    expect(held.upgrade_held_digest).toBe(catalog.get(setting, '1.0.1').digest);
    const [due] = await discovery()<{ count: number }[]>`
      select count(*)::int as count from retainer_extension_upgrades_due(1000,
        ${[setting]}::uuid[], ${[catalog.get(setting, '1.0.1').digest]}::text[])
      where installation_id = ${installed.id}`;
    expect(due?.count).toBe(0);
  });

  it('leaves a disabled installation alone', async () => {
    const { sdk, installed } = await install(disabled);
    await sdk.disableExtension(installed.id);
    await extensions.upgradeDue(discovery());
    expect(await row(installed.id)).toMatchObject({ version: '1.0.0', state: 'disabled' });
  });

  it('upgrades exactly once when two passes race', async () => {
    const { installed, workspaceId } = await install(racing);
    const before = await row(installed.id);
    const outcomes = await Promise.all([
      extensions.autoUpgrade(workspaceId, installed.id),
      extensions.autoUpgrade(workspaceId, installed.id),
    ]);
    expect(outcomes.sort()).toEqual(['skipped', 'upgraded']);
    const after = await row(installed.id);
    expect(after).toMatchObject({ version: '1.0.1', state: 'active' });
    expect(after.generation).toBe(before.generation + 1);
  });

  it('never targets a release that is not deployed', () => {
    expect(extensions.upgradeTargets().map((target) => target.registrationId)).not.toContain(
      hosted,
    );
  });
});
