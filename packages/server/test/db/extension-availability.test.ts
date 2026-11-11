import { randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inWorkspace } from '../../src/db/tx.js';
import { type RuntimeCatalog, resolveRelease } from '../../src/extension-runtime/availability.js';
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
  it('has an order-independent identity and rejects unsupported versions and forged pin digests without throwing', () => {
    expect(new ExtensionCatalog([...reviewed].reverse()).runtime.identity).toBe(
      full.runtime.identity,
    );
    expect(partial.runtime.identity).not.toBe(full.runtime.identity);
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
      { manifest: { ...broken, serverVersions: ['999.0.0'] }, actorCeiling: 'integration' },
    ]);
    expect(resolveRelease(unsupported.runtime, pin)).toEqual({
      available: false,
      code: 'incompatible_runtime',
    });
    expect(resolveRelease(partial.runtime, pin)).toEqual({
      available: false,
      code: 'release_unavailable',
    });
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
      (await db.owner`select status from extension_jobs where id=${good.jobId}`)[0]?.status,
    ).toBe('succeeded');
    const [failure] =
      await db.owner`select generation,release_digest,runtime_identity,code from extension_runtime_unavailable where installation_id=${bad.id}`;
    expect(failure).toMatchObject({
      generation: 1,
      runtime_identity: partial.runtime.identity,
      code: 'release_unavailable',
    });
    expect(
      (await new ExtensionQueue(app.sql, partial.runtime).discover(discovery())).some(
        (row) => row.job_id === bad.jobId,
      ),
    ).toBe(false);
    // The API's newer/full catalog is available; an older worker's marker must not leak into its status.
    expect((await app.request(`/v1/extensions/${bad.id}`, { key: bad.key })).body).toMatchObject({
      state: 'active',
      connectionHealth: 'ok',
      runtimeAvailability: { state: 'available' },
    });
  });

  it('exposes catalog-local availability separately from provider health and enforces workspace isolation', async () => {
    const h = await setup(),
      other = await setup(healthy);
    await new ExtensionQueue(app.sql, partial.runtime).claim(h.workspace, h.jobId, 'old');
    const oldApp = startTestApp(db, { extensionCatalog: partial, runTokens: tokens });
    const info = await oldApp.request(`/v1/extensions/${h.id}`, { key: h.key });
    expect(info.body).toMatchObject({
      connectionHealth: 'ok',
      runtimeAvailability: {
        state: 'unavailable',
        code: 'release_unavailable',
        retryAt: expect.any(String),
      },
    });
    const listed = await oldApp.request('/v1/extensions', { key: h.key });
    expect(listed.body.installations[0].runtimeAvailability).toEqual(info.body.runtimeAvailability);
    expect(
      await inWorkspace(
        app.sql,
        other.workspace,
        (tx) => tx`select * from extension_runtime_unavailable`,
      ),
    ).toHaveLength(0);
    await expect(discovery()`select * from extension_runtime_unavailable`).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      inWorkspace(
        app.sql,
        other.workspace,
        (
          tx,
        ) => tx`insert into extension_runtime_unavailable(workspace_id,installation_id,runtime_identity,generation,release_digest,code,retry_at)
      values(${other.workspace},${h.id},${partial.runtime.identity},1,${'a'.repeat(64)},'release_unavailable',clock_timestamp())`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('recovers immediately on catalog restoration without upgrading or changing generation and isolates competing catalogs', async () => {
    const h = await setup();
    const older = new ExtensionQueue(app.sql, partial.runtime);
    expect(await older.claim(h.workspace, h.jobId, 'old')).toBeNull();
    const results = await Promise.all([executor(partial).tick(), executor(full).tick()]);
    expect(results.reduce((sum, row) => sum + row.executed, 0)).toBe(1);
    expect(
      (await db.owner`select state,generation from extension_installations where id=${h.id}`)[0],
    ).toEqual({ state: 'active', generation: 1 });
    expect((await db.owner`select status from extension_jobs where id=${h.jobId}`)[0]?.status).toBe(
      'succeeded',
    );
    expect(
      (
        await db.owner`select runtime_identity from extension_runtime_unavailable where installation_id=${h.id}`
      )[0]?.runtime_identity,
    ).toBe(partial.runtime.identity);
  });

  it('bounds probes for the same catalog and resumes exactly once after its retry deadline', async () => {
    const h = await setup();
    let restored = false,
      probes = 0;
    const snapshot: RuntimeCatalog = {
      identity: 'd'.repeat(64),
      resolve: (id, version) => {
        probes++;
        if (!restored) throw new Error('must not persist this sensitive exception');
        return full.runtime.resolve(id, version);
      },
    };
    const queue = new ExtensionQueue(app.sql, snapshot);
    expect(await queue.claim(h.workspace, h.jobId, 'first')).toBeNull();
    restored = true;
    expect(await queue.claim(h.workspace, h.jobId, 'too-soon')).toBeNull();
    expect(probes).toBe(1);
    await db.owner`update extension_runtime_unavailable set retry_at=clock_timestamp()-interval '1 second' where installation_id=${h.id}`;
    const runs = await Promise.all([
      queue.claim(h.workspace, h.jobId, 'one'),
      queue.claim(h.workspace, h.jobId, 'two'),
    ]);
    expect(runs.filter(Boolean)).toHaveLength(1);
    expect(probes).toBe(2);
    expect(
      await db.owner`select * from extension_runtime_unavailable where installation_id=${h.id}`,
    ).toHaveLength(0);
    const run = runs.find(Boolean);
    if (!run) throw new Error('missing recovered run');
    await queue.complete(run, { status: 'succeeded' });
  });

  it('does not apply a previous generation or digest failure to a changed installation pin', async () => {
    const h = await setup();
    await db.owner`insert into extension_runtime_unavailable(workspace_id,installation_id,runtime_identity,generation,release_digest,code,retry_at)
      values(${h.workspace},${h.id},${full.runtime.identity},1,${'f'.repeat(64)},'incompatible_runtime',clock_timestamp()+interval '1 day')`;
    const run = await h.queue.claim(h.workspace, h.jobId, 'changed-digest');
    expect(run).toBeTruthy();
    if (!run) throw new Error('stale failure blocked current pin');
    await h.queue.complete(run, { status: 'succeeded' });
    const next = await h.queue.enqueue(h.workspace, h.id, {
      functionId,
      input: {},
      dedupeKey: 'next',
    });
    await db.owner`insert into extension_runtime_unavailable(workspace_id,installation_id,runtime_identity,generation,release_digest,code,retry_at)
      values(${h.workspace},${h.id},${full.runtime.identity},2,${full.get(broken.universalId, broken.version).digest},'release_unavailable',clock_timestamp()+interval '1 day')`;
    expect(await h.queue.claim(h.workspace, next.id, 'changed-generation')).toBeTruthy();
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

  it('keeps job expiry and stale diagnostic collection running without catalog availability', async () => {
    const h = await setup(),
      older = new ExtensionQueue(app.sql, partial.runtime);
    await older.claim(h.workspace, h.jobId, 'old');
    await db.owner`update extension_jobs set expires_at=clock_timestamp()-interval '1 second' where id=${h.jobId}`;
    await db.owner`update extension_runtime_unavailable set checked_at=clock_timestamp()-interval '31 days' where installation_id=${h.id}`;
    expect((await new ChangeMaintenance(app.sql, discovery()).tick()).failed).toBe(0);
    expect((await db.owner`select status,code from extension_jobs where id=${h.jobId}`)[0]).toEqual(
      { status: 'failed', code: 'job_expired' },
    );
    expect(
      await db.owner`select * from extension_runtime_unavailable where installation_id=${h.id}`,
    ).toHaveLength(0);
  });
});
