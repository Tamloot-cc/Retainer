import { randomUUID } from 'node:crypto';
import { RetainerClient } from '@retainer/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { Extensions } from '../../src/extensions/service.js';
import { ChangeMaintenance } from '../../src/worker/changes.js';
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
  downgrade = randomUUID(),
  standalone = randomUUID(),
  stuck = randomUUID(),
  behind = randomUUID(),
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
  release(downgrade, '1.0.0'),
  release(downgrade, '1.0.1'),
  release(stuck, '1.0.0'),
  release(stuck, '1.0.1'),
  release(behind, '1.0.0'),
  release(behind, '1.0.1'),
  release(standalone, '1.0.0'),
  release(standalone, '1.0.1'),
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

  it("keeps a person's move back to an older release", async () => {
    const { sdk, installed } = await install(downgrade);
    await extensions.upgradeDue(discovery());
    expect((await row(installed.id)).version).toBe('1.0.1');
    // 1.0.1 is broken: an admin moves back to 1.0.0.
    const back = { registrationId: downgrade, version: '1.0.0', settings: { enabled: true } };
    const plan = await sdk.previewExtension({ ...back, installationId: installed.id });
    await sdk.upgradeExtension(
      installed.id,
      { ...back, installationId: installed.id, planDigest: plan.planDigest },
      'back',
    );
    const moved = await row(installed.id);
    expect(moved).toMatchObject({
      version: '1.0.0',
      upgrade_held_digest: catalog.get(downgrade, '1.0.1').digest,
    });
    // The next pass neither undoes the choice nor fails on the earlier receipt.
    expect((await extensions.upgradeDue(discovery())).failed).toBe(0);
    expect(await row(installed.id)).toMatchObject({
      version: '1.0.0',
      generation: moved.generation,
    });
  });

  it('runs from change maintenance where no executor does', async () => {
    const { installed } = await install(standalone);
    const maintenance = new ChangeMaintenance(
      db.connect({ role: RUNTIME_ROLE, max: 2 }),
      discovery(),
      undefined,
      extensions,
    );
    await maintenance.tick();
    expect((await row(installed.id)).version).toBe('1.0.1');
  });

  it('moves a failing installation behind the others', async () => {
    const failing = await install(stuck);
    const waiting = await install(behind);
    // Only these two are due; the failing one is older, so it comes first.
    const only = extensions
      .upgradeTargets()
      .filter((t) => ([stuck, behind] as string[]).includes(t.registrationId));
    class Failing extends Extensions {
      override upgradeTargets() {
        return only;
      }
      override async autoUpgrade(workspaceId: string, installationId: string) {
        if (installationId === failing.installed.id) throw new Error('provider exploded');
        return super.autoUpgrade(workspaceId, installationId, only);
      }
    }
    const flaky = new Failing(
      db.connect({ role: RUNTIME_ROLE, max: 2 }),
      catalog,
      undefined,
      new Set(),
    );
    expect(await flaky.upgradeDue(discovery(), 1)).toMatchObject({ failed: 1, upgraded: 0 });
    expect(await flaky.upgradeDue(discovery(), 1)).toMatchObject({ failed: 0, upgraded: 1 });
    expect((await row(waiting.installed.id)).version).toBe('1.0.1');
    expect((await row(failing.installed.id)).version).toBe('1.0.0');
  });

  it('never targets a release that is not deployed', () => {
    expect(extensions.upgradeTargets().map((target) => target.registrationId)).not.toContain(
      hosted,
    );
  });
});
