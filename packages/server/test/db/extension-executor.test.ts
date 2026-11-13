import { randomUUID } from 'node:crypto';
import { decodeJwt, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { EXECUTOR_LEADER, runExecutorLeader } from '../../src/lambda/executor.js';
import { extensionReleaseStatus } from '../../src/operator/extension-releases.js';
import {
  type ExecutionDriver,
  ExecutionRegistry,
  ExtensionExecutor,
} from '../../src/worker/extensions.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
/** Other registrations, so one workspace can hold several installations with due jobs. */
const peers = Array.from({ length: 7 }, () =>
  extensionFixture({
    scopes: ['read', 'write'],
    functions: [
      {
        universalId: randomUUID(),
        name: 'sync',
        description: 'Deterministic fixture',
        handlerDigest: 'b'.repeat(64),
        timeoutSeconds: 120,
        trigger: { kind: 'job' },
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ],
  }),
);
const catalog = new ExtensionCatalog(
    [manifest, ...peers].map((m) => ({
      manifest: m,
      actorCeiling: 'integration' as const,
      runtimeEnabled: true,
    })),
  ),
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
const executables = [
  executable,
  { ...executable, functionId: slowId },
  ...peers.map((peer) => ({
    ...executable,
    registrationId: peer.universalId,
    releaseDigest: catalog.get(peer.universalId, peer.version).digest,
    functionId: peer.functions[0]?.universalId as string,
  })),
];
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
async function setup(
  fn: string = functionId,
  into?: { workspace: string; admin: string; manifest: typeof manifest },
) {
  const target = into?.manifest ?? manifest;
  const { workspace, keys } = into
    ? { workspace: { id: into.workspace }, keys: { admin: into.admin } }
    : await t.setupWorkspace(
        { name: `Executor ${randomUUID()}` },
        { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
      );
  const input = { registrationId: target.universalId, version: target.version, settings: {} };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const install = await t.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': `install:${target.universalId}` },
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
  const executor = (
    driver: ExecutionDriver,
    registry = new ExecutionRegistry(executables),
    concurrency = 4,
    upgrades?: ConstructorParameters<typeof ExtensionExecutor>[0]['upgrades'],
  ) =>
    new ExtensionExecutor({
      ...(upgrades ? { upgrades } : {}),
      sql: t.sql,
      discoverySql: db.connect({ role: 'retainer_executor' }),
      catalog,
      registry,
      tokens,
      driver,
      apiOrigin: 'https://retainer.test',
      owner: randomUUID(),
      concurrency,
    });
  return { workspace: workspace.id, admin: keys.admin, id, jobId, queue, executor };
}
describe('trusted executor protocol with an explicitly in-process test driver', () => {
  it('checks automatic upgrades at most once a minute, starting with the first pass', async () => {
    const { executor } = await setup();
    let passes = 0;
    const upgrades = {
      upgradeDue: async () => {
        passes++;
        return { upgraded: 0, held: 0, failed: 0 };
      },
    };
    const idle = { invoke: async () => ({ status: 'succeeded' as const }) };
    const ticking = executor(idle, undefined, 4, upgrades);
    await ticking.tick();
    await ticking.tick();
    // Within the interval a second pass of the same executor does not check again.
    expect(passes).toBe(1);
    // A short run checks once: the next check waits for the upgrade interval.
    await executor(idle, undefined, 4, upgrades).run({ idleMs: 5, idleTimeoutMs: 50 });
    expect(passes).toBe(2);
  });
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
    expect(assertion?.actor).toEqual({ type: 'integration', id, name: 'Fixture' });
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
    const token = await tokens.issue(t.sql, lease, lease.registrationId, lease.scopes);
    const { exp } = decodeJwt(token.slice('rt_run_'.length));
    expect((exp ?? Infinity) * 1000).toBeLessThanOrEqual(lease.deadline.getTime());
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
  it('keeps claiming other installations while a long run holds a slot', async () => {
    const long = await setup();
    let release = () => {};
    let runner: { executor: ExtensionExecutor; loop: Promise<void> } | undefined;
    const started = new Promise<void>((resolve) => {
      const executor = long.executor({
        invoke: (_target, invocation) => {
          if (invocation.runId === long.jobId) {
            resolve();
            return new Promise((done) => {
              release = () => done({ status: 'succeeded' });
            });
          }
          return Promise.resolve({ status: 'succeeded' });
        },
      });
      runner = { executor, loop: executor.run({ idleMs: 50, maintenanceMs: 50 }) };
    });
    await started;
    // Queued only after the long run started, so a batch-at-a-time pass would not see it.
    const other = await setup();
    const status = async (id: string) =>
      (await db.owner`select status from extension_jobs where id=${id}`)[0]?.status;
    for (let i = 0; i < 200 && (await status(other.jobId)) !== 'succeeded'; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await status(other.jobId)).toBe('succeeded');
    expect(await status(long.jobId)).toBe('running');
    release();
    for (let i = 0; i < 200 && (await status(long.jobId)) !== 'succeeded'; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await status(long.jobId)).toBe('succeeded');
    runner?.executor.stop();
    await runner?.loop;
  });
  it("counts a job's shutdown releases after the first three", async () => {
    const h = await setup();
    for (let round = 1; round <= 4; round++) {
      const lease = await h.queue.claim(h.workspace, h.jobId, `coordinator-${round}`);
      if (!lease) throw new Error('missing lease');
      await h.queue.release(lease);
      const [job] = await db.owner`select cycle_attempt from extension_jobs where id=${h.jobId}`;
      expect(job?.cycle_attempt).toBe(round <= 3 ? 0 : 1);
    }
  });
  it('lets another workspace run while a capped workspace has older due jobs', async () => {
    const a = await setup();
    const peerJobs = [];
    for (const peer of peers)
      peerJobs.push(
        await setup(peer.functions[0]?.universalId, {
          workspace: a.workspace,
          admin: a.admin,
          manifest: peer,
        }),
      );
    // Workspace A reaches its cap of four live runs held by another coordinator.
    for (const held of peerJobs.slice(0, 4))
      expect(await held.queue.claim(a.workspace, held.jobId, 'holder')).toBeTruthy();
    const b = await setup();
    const ran: string[] = [];
    const executor = b.executor(
      {
        invoke: async (_target, invocation) => {
          ran.push(invocation.runId);
          return { status: 'succeeded' };
        },
      },
      undefined,
      1,
    );
    const loop = executor.run({ idleMs: 50, maintenanceMs: 60000 });
    const status = async () =>
      (await db.owner`select status from extension_jobs where id=${b.jobId}`)[0]?.status;
    for (let i = 0; i < 100 && (await status()) !== 'succeeded'; i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    executor.stop();
    await loop;
    expect(await status()).toBe('succeeded');
    expect(ran).toContain(b.jobId);
    // Earlier tests may leave due jobs elsewhere; none of the capped workspace's ran.
    for (const job of [a, ...peerJobs]) expect(ran).not.toContain(job.jobId);
    await db.owner`update extension_jobs set status='cancelled',lease_until=null where workspace_id=${a.workspace}`;
  });
  it('drains without aborting or releasing a claimed run and stops further claims', async () => {
    const h = await setup();
    const started = deferred<void>();
    const finish = deferred<{ status: 'succeeded' }>();
    const drained = deferred<void>();
    let signal: AbortSignal | undefined;
    const executor = h.executor({
      invoke: (_target, invocation, abort) => {
        if (invocation.runId !== h.jobId) return Promise.resolve({ status: 'succeeded' });
        signal = abort;
        started.resolve();
        return finish.promise;
      },
    });
    const loop = executor.run({ idleMs: 10, onClaimingStopped: async () => drained.resolve() });
    try {
      await started.promise;
      executor.drain();
      await drained.promise;
      expect(signal?.aborted).toBe(false);
      expect(
        (await db.owner`select status from extension_jobs where id=${h.jobId}`)[0]?.status,
      ).toBe('running');
      finish.resolve({ status: 'succeeded' });
      await loop;
      expect(
        (await db.owner`select status,code from extension_jobs where id=${h.jobId}`)[0],
      ).toEqual({ status: 'succeeded', code: null });
      expect(await executor.tick()).toEqual({ executed: 0, fenced: 0 });
    } finally {
      finish.resolve({ status: 'succeeded' });
      executor.drain();
      await loop;
    }
  });
  it('releases a claim acquired after drain began without invoking the provider', async () => {
    const h = await setup();
    const blocker = db.connect({ max: 1, keepConnections: true });
    const queueKey = `${h.workspace}:${h.id}`;
    await blocker`select pg_advisory_lock(21062::int4, hashtext(${queueKey}))`;
    const invoked: string[] = [];
    const executor = h.executor({
      invoke: async (_target, invocation) => {
        invoked.push(invocation.runId);
        return { status: 'succeeded' };
      },
    });
    // Isolate claims from maintenance so the real queue lock blocks claim() itself.
    const loop = executor.run({ idleMs: 10, maintenanceMs: Number.POSITIVE_INFINITY });
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await db.owner`
        select count(*)::int as count from pg_locks where locktype='advisory'
          and classid=21062 and not granted
          and database=(select oid from pg_database where datname=current_database())`
            )[0]?.count,
          ),
        )
        .toBe(1);
      executor.drain();
    } finally {
      await blocker`select pg_advisory_unlock(21062::int4, hashtext(${queueKey}))`;
      executor.drain();
      await loop;
    }
    expect(invoked).not.toContain(h.jobId);
    expect(
      (
        await db.owner`select status,code,cycle_attempt,lease_owner from extension_jobs where id=${h.jobId}`
      )[0],
    ).toEqual({ status: 'queued', code: 'executor_stopped', cycle_attempt: 0, lease_owner: null });
    expect(await h.queue.claim(h.workspace, h.jobId, 'successor')).not.toBeNull();
    await db.owner`update extension_jobs set status='cancelled',lease_until=null where id=${h.jobId}`;
  });
  it('elects exactly one leader when coordinator invocations race on real sessions', async () => {
    const h = await setup();
    const started = deferred<void>();
    const finish = deferred<{ status: 'succeeded' }>();
    let calls = 0;
    const driver: ExecutionDriver = {
      invoke: (_target, invocation) => {
        if (invocation.runId !== h.jobId) return Promise.resolve({ status: 'succeeded' });
        calls++;
        started.resolve();
        return finish.promise;
      },
    };
    const executors = [h.executor(driver), h.executor(driver)];
    const passes = executors.map((executor) =>
      runExecutorLeader(db.connect({ max: 1, keepConnections: true }), executor, 10000, {
        idleTimeoutMs: 50,
        idleMs: 10,
      }),
    );
    try {
      await started.promise;
      expect(await Promise.race(passes)).toEqual({ skipped: true });
      expect(calls).toBe(1);
      finish.resolve({ status: 'succeeded' });
      const results = await Promise.all(passes);
      expect(results.filter((result) => result.skipped)).toHaveLength(1);
      expect(
        (await db.owner`select status from extension_jobs where id=${h.jobId}`)[0]?.status,
      ).toBe('succeeded');
    } finally {
      finish.resolve({ status: 'succeeded' });
      for (const executor of executors) executor.drain();
      await Promise.all(passes);
    }
  });
  it('hands off the leader at the claim deadline while its older run still acknowledges normally', async () => {
    const h = await setup();
    const started = deferred<void>();
    const finish = deferred<{ status: 'succeeded' }>();
    const executor = h.executor({
      invoke: (_target, invocation) => {
        if (invocation.runId !== h.jobId) return Promise.resolve({ status: 'succeeded' });
        started.resolve();
        return finish.promise;
      },
    });
    const pass = runExecutorLeader(db.connect({ max: 1, keepConnections: true }), executor, 150, {
      idleTimeoutMs: 10000,
      idleMs: 10,
    });
    try {
      await started.promise;
      await expect
        .poll(async () =>
          Number(
            (
              await db.owner`
        select count(*)::int as count from pg_locks where locktype='advisory' and objid=${EXECUTOR_LEADER}
          and database=(select oid from pg_database where datname=current_database())`
            )[0]?.count,
          ),
        )
        .toBe(0);
      expect(
        (await db.owner`select status from extension_jobs where id=${h.jobId}`)[0]?.status,
      ).toBe('running');
      const other = await setup();
      const next = other.executor({ invoke: async () => ({ status: 'succeeded' }) });
      expect(
        await runExecutorLeader(db.connect({ max: 1, keepConnections: true }), next, 10000, {
          idleTimeoutMs: 50,
          idleMs: 10,
        }),
      ).toEqual({ skipped: false });
      expect(
        (await db.owner`select status from extension_jobs where id=${other.jobId}`)[0]?.status,
      ).toBe('succeeded');
      finish.resolve({ status: 'succeeded' });
      await pass;
      expect(
        (await db.owner`select status from extension_jobs where id=${h.jobId}`)[0]?.status,
      ).toBe('succeeded');
    } finally {
      finish.resolve({ status: 'succeeded' });
      executor.drain();
      await pass;
    }
  });
});
