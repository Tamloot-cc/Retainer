import { randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveRelease, runnableReleases } from '../../src/extension-runtime/availability.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { ChangeMaintenance } from '../../src/worker/changes.js';
import { ExecutionRegistry, ExtensionExecutor } from '../../src/worker/extensions.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase(),
  functionId = randomUUID();
const manifest = () =>
  extensionFixture({
    functions: [
      {
        universalId: functionId,
        name: 'sync',
        description: 'Availability fixture',
        handlerDigest: 'b'.repeat(64),
        timeoutSeconds: 120,
        trigger: { kind: 'job' },
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ],
  });
const broken = manifest(),
  healthy = manifest();
const reviewed = [broken, healthy].map((manifest) => ({
  manifest,
  actorCeiling: 'integration' as const,
  runtimeEnabled: true,
}));
const full = new ExtensionCatalog(reviewed),
  partial = new ExtensionCatalog(reviewed.slice(1));
const registry = new ExecutionRegistry(
  reviewed.map(({ manifest }) => ({
    registrationId: manifest.universalId,
    releaseDigest: full.get(manifest.universalId, manifest.version).digest,
    functionId,
    handlerDigest: 'b'.repeat(64),
    packageDigest: manifest.packageDigest,
    runtimeVersion: 'node24' as const,
    driverTarget: 'fixture:immutable',
  })),
);
let app: TestApp, tokens: RunTokens;
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'availability',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  app = startTestApp(db, { extensionCatalog: full, runTokens: tokens });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.owner`delete from workspaces`;
});
async function setup(target = broken) {
  const { workspace, keys } = await app.setupWorkspace(
    { name: randomUUID() },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const input = { registrationId: target.universalId, version: target.version, settings: {} };
  const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': 'install' },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string;
  await db.owner`update extension_installations set state='active',connection_health='ok' where id=${id}`;
  const queue = new ExtensionQueue(app.sql, full.runtime);
  // No schedule maintenance is due: this specifically exercises the previously broken claim path.
  await queue.scheduleTick(workspace.id, id);
  const { id: jobId } = await queue.enqueue(workspace.id, id, {
    functionId,
    input: {},
    dedupeKey: 'sync',
  });
  return { workspace: workspace.id, id, jobId, key: keys.admin, queue };
}
function executor(
  catalog: ExtensionCatalog,
  invoke = vi.fn(async () => ({ status: 'succeeded' as const })),
) {
  return new ExtensionExecutor({
    sql: app.sql,
    discoverySql: db.connect({ role: 'retainer_executor' }),
    catalog,
    registry,
    tokens,
    driver: { invoke },
    apiOrigin: 'https://retainer.test',
    owner: randomUUID(),
    concurrency: 1,
  });
}
const discovery = () => db.connect({ role: 'retainer_executor' });

describe('catalog-scoped runtime availability', () => {
  it('resolves pins without throwing and lists only the releases this process can run', () => {
    const pin = {
      registration_id: broken.universalId,
      version: broken.version,
      release_digest: full.get(broken.universalId, broken.version).digest,
    };
    expect(resolveRelease(full.runtime, pin).available).toBe(true);
    expect(resolveRelease(full.runtime, { ...pin, release_digest: 'f'.repeat(64) })).toEqual({
      available: false,
      code: 'incompatible_runtime',
    });
    const unsupported = new ExtensionCatalog([
      { manifest: { ...broken, serverRange: '>=999.0.0 <1000.0.0' }, actorCeiling: 'integration' },
    ]);
    expect(resolveRelease(unsupported.runtime, pin)).toEqual({
      available: false,
      code: 'incompatible_runtime',
    });
    expect(resolveRelease(partial.runtime, pin)).toEqual({
      available: false,
      code: 'release_unavailable',
    });
    const digest = (m: typeof broken) => full.get(m.universalId, m.version).digest;
    expect(runnableReleases(full.runtime).digests.sort()).toEqual(
      [digest(broken), digest(healthy)].sort(),
    );
    expect(runnableReleases(partial.runtime)).toEqual({
      registrations: [healthy.universalId],
      digests: [digest(healthy)],
    });
    expect(runnableReleases(unsupported.runtime).digests).toEqual([]);
    // Hosted releases also need a deployed executable when the process knows them.
    expect(runnableReleases(full.runtime, new Set([digest(healthy)])).digests).toEqual([
      digest(healthy),
    ]);
  });

  it('keeps no persisted availability state', async () => {
    expect(
      (
        await db.owner`select to_regclass('public.extension_runtime_unavailable') as marker,
          to_regprocedure('public.retainer_extension_runtime_due(integer,text)') as probe`
      )[0],
    ).toEqual({ marker: null, probe: null });
  });

  it('executes a healthy workspace behind an unavailable queued job with one worker and preserves the blocked job', async () => {
    const bad = await setup(),
      good = await setup(healthy),
      driver = vi.fn(async () => ({ status: 'succeeded' as const }));
    await db.owner`update extension_jobs set available_at=clock_timestamp()-interval '1 hour' where id=${bad.jobId}`;
    expect(await executor(partial, driver).tick()).toMatchObject({ executed: 1 });
    expect(driver).toHaveBeenCalledOnce();
    expect(
      (await db.owner`select status,attempt from extension_jobs where id=${bad.jobId}`)[0],
    ).toEqual({ status: 'queued', attempt: 0 });
    expect(
      await db.owner`select id from extension_attempts where job_id=${bad.jobId}`,
    ).toHaveLength(0);
    expect(
      (await db.owner`select status from extension_jobs where id=${good.jobId}`)[0]?.status,
    ).toBe('succeeded');
    expect(
      (await new ExtensionQueue(app.sql, partial.runtime).discover(discovery())).some(
        (row) => row.job_id === bad.jobId,
      ),
    ).toBe(false);
    // The API's own (full) catalog can run it; another worker's catalog never leaks into its status.
    expect((await app.request(`/v1/extensions/${bad.id}`, { key: bad.key })).body).toMatchObject({
      state: 'active',
      connectionHealth: 'ok',
      runtimeAvailability: { state: 'available' },
    });
  });

  it('honors the operator execution flag for existing installations and resumes the same job when re-enabled', async () => {
    const h = await setup();
    const disabled = new ExtensionCatalog(
      reviewed.map((row) =>
        row.manifest.universalId === broken.universalId ? { ...row, runtimeEnabled: false } : row,
      ),
    );
    const invoke = vi.fn(async () => ({ status: 'succeeded' as const }));
    expect(await executor(disabled, invoke).tick()).toMatchObject({ executed: 0 });
    expect(invoke).not.toHaveBeenCalled();
    expect(
      (await db.owner`select status,attempt from extension_jobs where id=${h.jobId}`)[0],
    ).toEqual({ status: 'queued', attempt: 0 });
    const control = startTestApp(db, { extensionCatalog: disabled, runTokens: tokens });
    expect(
      (await control.request(`/v1/extensions/${h.id}`, { key: h.key })).body.runtimeAvailability,
    ).toEqual({ state: 'unavailable', code: 'incompatible_runtime' });
    expect(await executor(full, invoke).tick()).toMatchObject({ executed: 1 });
    expect(invoke).toHaveBeenCalledOnce();
    expect(
      (await db.owner`select status,attempt from extension_jobs where id=${h.jobId}`)[0],
    ).toEqual({ status: 'succeeded', attempt: 1 });
    expect(
      (await db.owner`select generation from extension_installations where id=${h.id}`)[0]
        ?.generation,
    ).toBe(1);
  });

  it('keeps unavailable work out of a small discovery window', async () => {
    const blocked = [];
    for (let i = 0; i < 6; i++) blocked.push(await setup());
    const good = await setup(healthy),
      queue = new ExtensionQueue(app.sql, partial.runtime);
    await db.owner`update extension_jobs set available_at=clock_timestamp()-interval '1 hour' where installation_id=any(${blocked.map((h) => h.id)}::uuid[])`;
    expect((await queue.discover(discovery(), 4)).map((row) => row.job_id)).toEqual([good.jobId]);
    expect(await executor(partial).tick(4)).toMatchObject({ executed: 1 });
    expect(
      (await db.owner`select status from extension_jobs where id=${good.jobId}`)[0]?.status,
    ).toBe('succeeded');
  });

  it('reports availability from the reading process catalog, separately from provider health', async () => {
    const h = await setup();
    const oldApp = startTestApp(db, { extensionCatalog: partial, runTokens: tokens });
    const info = await oldApp.request(`/v1/extensions/${h.id}`, { key: h.key });
    expect(info.body).toMatchObject({ connectionHealth: 'ok' });
    expect(info.body.runtimeAvailability).toEqual({
      state: 'unavailable',
      code: 'release_unavailable',
    });
    const listed = await oldApp.request('/v1/extensions', { key: h.key });
    expect(listed.body.installations[0].runtimeAvailability).toEqual(info.body.runtimeAvailability);
  });

  it('leaves a job an older catalog cannot resolve queued at claim, and a newer catalog runs it at once without an upgrade', async () => {
    const h = await setup();
    const older = new ExtensionQueue(app.sql, partial.runtime);
    // Defense in depth: claim re-checks even a job it was handed directly.
    expect(await older.claim(h.workspace, h.jobId, 'old')).toBeNull();
    expect(
      (
        await db.owner`select status,attempt,lease_owner from extension_jobs where id=${h.jobId}`
      )[0],
    ).toEqual({ status: 'queued', attempt: 0, lease_owner: null });
    expect(await older.discover(discovery())).toHaveLength(0);
    expect((await h.queue.discover(discovery())).map((row) => row.job_id)).toEqual([h.jobId]);
    const results = await Promise.all([executor(partial).tick(), executor(full).tick()]);
    expect(results.reduce((sum, row) => sum + row.executed, 0)).toBe(1);
    expect(
      (await db.owner`select state,generation from extension_installations where id=${h.id}`)[0],
    ).toEqual({ state: 'active', generation: 1 });
    expect((await db.owner`select status from extension_jobs where id=${h.jobId}`)[0]?.status).toBe(
      'succeeded',
    );
  });

  it('leaves a hosted job without a deployed executable queued', async () => {
    const h = await setup();
    const healthyDigest = full.get(healthy.universalId, healthy.version).digest;
    const queue = new ExtensionQueue(app.sql, full.runtime, undefined, new Set([healthyDigest]));
    expect(await queue.discover(discovery())).toHaveLength(0);
    expect(await queue.claim(h.workspace, h.jobId, 'no-executable')).toBeNull();
    expect(
      (await db.owner`select status,attempt from extension_jobs where id=${h.jobId}`)[0],
    ).toEqual({ status: 'queued', attempt: 0 });
  });

  it('filters change dispatch and schedule maintenance by the runnable releases', async () => {
    const h = await setup();
    await db.owner`insert into change_counters(workspace_id,position) values(${h.workspace},5)
      on conflict(workspace_id) do update set position=5`;
    await db.owner`insert into change_dispatch(workspace_id,installation_id,generation,position) values(${h.workspace},${h.id},1,0)`;
    await db.owner`update extension_schedules set next_due_at=clock_timestamp()-interval '1 minute' where installation_id=${h.id}`;
    const older = new ExtensionQueue(app.sql, partial.runtime);
    const maintenance = (queue: ExtensionQueue) => {
      const { registrations, digests } = queue.runnable;
      return discovery()<{ installation_id: string }[]>`
        select installation_id from retainer_extension_maintenance_due(1000,${registrations}::uuid[],${digests}::text[])`;
    };
    expect((await older.discoverChanges(discovery(), null)).map((r) => r.installation_id)).toEqual(
      [],
    );
    expect((await maintenance(older)).map((r) => r.installation_id)).toEqual([]);
    expect(
      (await h.queue.discoverChanges(discovery(), null)).map((r) => r.installation_id),
    ).toEqual([h.id]);
    expect((await maintenance(h.queue)).map((r) => r.installation_id)).toEqual([h.id]);
  });

  it('continues after an unexpected per-item claim failure and reports it after processing peers', async () => {
    const bad = await setup(),
      good = await setup(healthy),
      worker = executor(full);
    await db.owner`update extension_jobs set available_at=clock_timestamp()-interval '1 hour' where id=${bad.jobId}`;
    vi.spyOn(worker.queue, 'claim').mockRejectedValueOnce(new Error('claim persistence outage'));
    await expect(worker.tick()).rejects.toThrow('claim persistence outage');
    expect(
      (await db.owner`select status from extension_jobs where id=${good.jobId}`)[0]?.status,
    ).toBe('succeeded');
    expect(
      (await db.owner`select status from extension_jobs where id=${bad.jobId}`)[0]?.status,
    ).toBe('queued');
  });

  it.each(['missing', 'unsupported'] as const)(
    'uninstalls a %s release without loading cleanup code and retires secrets and callbacks',
    async (kind) => {
      const h = await setup(),
        digest = full.get(broken.universalId, broken.version).digest;
      await db.owner`insert into extension_secrets(workspace_id,installation_id,name,envelope) values(${h.workspace},${h.id},'fixture','{}'::jsonb)`;
      await db.owner`insert into webhook_bindings(workspace_id,installation_id,registration_id,generation,release_digest,route,secret_name)
      values(${h.workspace},${h.id},${broken.universalId},1,${digest},'fixture','fixture')`;
      const catalog =
        kind === 'missing'
          ? partial
          : new ExtensionCatalog([
              {
                manifest: { ...broken, serverRange: '>=999.0.0 <1000.0.0' },
                actorCeiling: 'integration',
              },
            ]);
      const control = startTestApp(db, {
        extensionCatalog: catalog,
        runTokens: tokens,
        extensionActivation: new Set([digest]),
      });
      const result = await control.request(`/v1/extensions/${h.id}/uninstall`, {
        key: h.key,
        method: 'POST',
      });
      expect(result.status).toBe(200);
      expect(result.body.state).toBe('uninstalled');
      expect(
        (
          await db.owner`select delete_after from extension_secrets where installation_id=${h.id}`
        )[0]?.delete_after,
      ).toBeInstanceOf(Date);
      expect(
        (await db.owner`select state from webhook_bindings where installation_id=${h.id}`)[0]
          ?.state,
      ).toBe('retired');
      expect(
        await db.owner`select id from extension_jobs where installation_id=${h.id} and trigger_kind='uninstall'`,
      ).toHaveLength(0);
      expect(
        (await db.owner`select status from extension_jobs where id=${h.jobId}`)[0]?.status,
      ).toBe('cancelled');
    },
  );

  it('honors uninstall cleanup deadlines even while the runtime is unavailable', async () => {
    const h = await setup();
    const control = startTestApp(db, {
      extensionCatalog: full,
      runTokens: tokens,
      extensionActivation: new Set(full.list().map((row) => row.digest)),
    });
    expect(
      (await control.request(`/v1/extensions/${h.id}/uninstall`, { key: h.key, method: 'POST' }))
        .status,
    ).toBe(200);
    const [cleanup] =
      await db.owner`select id from extension_jobs where installation_id=${h.id} and trigger_kind='uninstall'`;
    const older = new ExtensionQueue(app.sql, partial.runtime);
    expect(await older.claim(h.workspace, cleanup?.id, 'cleanup')).toBeNull();
    await db.owner`update extension_installations set cleanup_deadline=clock_timestamp()-interval '1 second' where id=${h.id}`;
    await older.maintain(discovery());
    expect(
      (await db.owner`select state,last_error from extension_installations where id=${h.id}`)[0],
    ).toEqual({ state: 'uninstalled', last_error: 'cleanup_deadline_expired' });
  });

  it('keeps job expiry running without catalog availability', async () => {
    const h = await setup(),
      older = new ExtensionQueue(app.sql, partial.runtime);
    await older.claim(h.workspace, h.jobId, 'old');
    await db.owner`update extension_jobs set expires_at=clock_timestamp()-interval '1 second' where id=${h.jobId}`;
    expect((await new ChangeMaintenance(app.sql, discovery()).tick()).failed).toBe(0);
    expect((await db.owner`select status,code from extension_jobs where id=${h.jobId}`)[0]).toEqual(
      { status: 'failed', code: 'job_expired' },
    );
  });
});
