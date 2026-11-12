import { randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { extensionReleaseStatus } from '../../src/operator/extension-releases.js';
import {
  type ExecutionDriver,
  ExecutionRegistry,
  ExtensionExecutor,
} from '../../src/worker/extensions.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase(),
  functionId = randomUUID(),
  slowId = randomUUID();
const manifest = extensionFixture({
  scopes: ['read', 'write'],
  functions: [
    {
      universalId: functionId,
      name: 'sync',
      description: 'Deterministic fixture',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 120,
      trigger: { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
    },
    {
      universalId: slowId,
      name: 'slow',
      description: 'Exceeds its one-second budget',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 1,
      trigger: { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
    },
  ],
});
const catalog = new ExtensionCatalog([
    { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  ]),
  release = catalog.get(manifest.universalId, manifest.version);
const executable = {
  registrationId: manifest.universalId,
  releaseDigest: release.digest,
  functionId,
  handlerDigest: 'b'.repeat(64),
  packageDigest: manifest.packageDigest,
  runtimeVersion: 'node24' as const,
  driverTarget: 'fixture:immutable-bundle',
};
const executables = [executable, { ...executable, functionId: slowId }];
/** Never settles until the executor aborts it. */
const hang = (_target: unknown, _invocation: unknown, signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
  );
let t: TestApp, tokens: RunTokens;
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  t = startTestApp(db, { extensionCatalog: catalog, runTokens: tokens });
});
async function setup(fn = functionId) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Executor ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const install = await t.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': 'install' },
  });
  expect(install.status).toBe(201);
  const id = install.body.id as string;
  await db.owner`update extension_installations set state='active' where id=${id}`;
  const queue = new ExtensionQueue(t.sql, catalog.runtime);
  const { id: jobId } = await queue.enqueue(workspace.id, id, {
    functionId: fn,
    input: {},
    dedupeKey: 'fixture',
  });
  const executor = (driver: ExecutionDriver, registry = new ExecutionRegistry(executables)) =>
    new ExtensionExecutor({
      sql: t.sql,
      discoverySql: db.connect({ role: 'retainer_executor' }),
      catalog,
      registry,
      tokens,
      driver,
      apiOrigin: 'https://retainer.test',
      owner: randomUUID(),
    });
  return { workspace: workspace.id, id, jobId, queue, executor };
}
describe('trusted executor protocol with an explicitly in-process test driver', () => {
  it('keeps a late coordinator claim visible to deployment until its lease expires', async () => {
    const h = await setup();
    const lease = await h.queue.claim(h.workspace, h.jobId, 'late-coordinator');
    expect(lease).toBeTruthy();
    if (!lease) throw new Error('missing lease');
    const [inventory] = await Promise.all([
      extensionReleaseStatus(db.owner, [release.digest]),
      h.queue.renew(lease),
    ]);
    expect(inventory.activeLeases).toBe(1);
    expect(JSON.stringify(inventory)).not.toContain(h.workspace);
    await db.owner`update extension_jobs set lease_until=clock_timestamp()-interval '1 second' where id=${h.jobId}`;
    expect((await extensionReleaseStatus(db.owner, [release.digest])).activeLeases).toBe(0);
    await db.owner`update extension_jobs set status='cancelled',lease_until=null where id=${h.jobId}`;
  });
  it('bounds a scheduled coordinator pass while leaving unclaimed work durable', async () => {
    const installations = await Promise.all([setup(), setup(), setup()]);
    const h = installations[0];
    if (!h) throw new Error('missing fixture');
    const executor = h.executor({ invoke: async () => ({ status: 'succeeded' }) });
    await expect(executor.tick(2)).resolves.toMatchObject({ executed: 2 });
    expect(
      (
        await db.owner`select count(*)::int as count from extension_jobs where installation_id=any(${installations.map((h) => h.id)}::uuid[]) and status='queued'`
      )[0]?.count,
    ).toBe(1);
    await expect(executor.tick(1)).resolves.toMatchObject({ executed: 1 });
    for (const limit of [0, 1.5, 1001])
      await expect(executor.tick(limit)).rejects.toThrow('pass limit');
  });
  it('claims once across two coordinators and runs the deterministic adapter with only its scoped API credential', async () => {
    const { id, jobId, executor } = await setup();
    let calls = 0;
    const driver: ExecutionDriver = {
      invoke: async (target, invocation) => {
        calls++;
        expect(target.driverTarget).toBe(executable.driverTarget);
        expect(invocation).not.toHaveProperty('databaseUrl');
        const response = await t.request('/v1/objects/company/records', {
          key: invocation.runToken,
          body: { values: { name: 'Deterministic fixture' } },
        });
        expect(response.status).toBe(201);
        return { status: 'succeeded' };
      },
    };
    const results = await Promise.all([executor(driver).tick(), executor(driver).tick()]);
    expect(results.reduce((sum, r) => sum + r.executed, 0)).toBe(1);
    expect(calls).toBe(1);
    const [job] = await db.owner`select status from extension_jobs where id=${jobId}`;
    expect(job?.status).toBe('succeeded');
    const [assertion] =
      await db.owner`select actor from field_assertions where actor->>'id'=${id} limit 1`;
    expect(assertion?.actor).toEqual({ type: 'integration', id });
  });
  it('keeps provider exceptions out of stored diagnostics and does not execute an unregistered artifact', async () => {
    const { jobId, executor } = await setup();
    const result = await executor({
      invoke: async () => {
        throw new Error('sensitive provider response');
      },
    }).tick();
    expect(result.executed).toBe(1);
    const [job] = await db.owner`select status,code from extension_jobs where id=${jobId}`;
    expect(job).toEqual({ status: 'queued', code: 'execution_unavailable' });
    const next = await setup();
    let calls = 0;
    await next
      .executor(
        {
          invoke: async () => {
            calls++;
            return { status: 'succeeded' };
          },
        },
        new ExecutionRegistry([]),
      )
      .tick();
    expect(calls).toBe(0);
    const [failed] = await db.owner`select status,code from extension_jobs where id=${next.jobId}`;
    expect(failed).toEqual({ status: 'failed', code: 'incompatible_runtime' });
  });
  it('records a run that exceeds its timeout as execution_timeout and backs off', async () => {
    const h = await setup(slowId);
    const result = await h.executor({ invoke: hang }).tick();
    expect(result).toEqual({ executed: 1, fenced: 0 });
    const [job] = await db.owner`select status,code,cycle_attempt,
      available_at>clock_timestamp()+interval '10 seconds' as backed_off from extension_jobs where id=${h.jobId}`;
    expect(job).toEqual({
      status: 'queued',
      code: 'execution_timeout',
      cycle_attempt: 1,
      backed_off: true,
    });
    const [attempt] =
      await db.owner`select status,code from extension_attempts where job_id=${h.jobId}`;
    expect(attempt).toEqual({ status: 'retry', code: 'execution_timeout' });
    // Not reclaimable until the backoff elapses, so it does not hold the installation's slot.
    expect(await h.queue.claim(h.workspace, h.jobId, 'other')).toBeNull();
  });
  it('gives the handler only its own timeout and the run credential no grace', async () => {
    const h = await setup(slowId);
    const lease = await h.queue.claim(h.workspace, h.jobId, 'coordinator');
    if (!lease) throw new Error('missing lease');
    const [row] = await db.owner`select extract(epoch from run_until)*1000 as run_until
      from extension_jobs where id=${h.jobId}`;
    const runUntil = Number(row?.run_until);
    // Handler budget is the one-second timeout; the lease keeps a grace to record the outcome.
    expect(runUntil - lease.deadline.getTime()).toBeGreaterThanOrEqual(10000);
    await db.owner`update extension_jobs set status='cancelled',lease_until=null where id=${h.jobId}`;
  });
  it('returns a job to the queue without consuming an attempt when the executor stops', async () => {
    const h = await setup();
    const executor = h.executor({
      invoke: (target, invocation, signal) => {
        setTimeout(() => executor.stop(), 50);
        return hang(target, invocation, signal);
      },
    });
    await executor.tick();
    const [job] = await db.owner`select status,code,cycle_attempt,attempt,
      available_at<=clock_timestamp() as available from extension_jobs where id=${h.jobId}`;
    expect(job).toEqual({
      status: 'queued',
      code: 'executor_stopped',
      cycle_attempt: 0,
      attempt: 1,
      available: true,
    });
    const [attempt] =
      await db.owner`select status,code from extension_attempts where job_id=${h.jobId}`;
    expect(attempt).toEqual({ status: 'cancelled', code: 'executor_stopped' });
  });
});
