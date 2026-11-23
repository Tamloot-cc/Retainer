import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { inWorkspace } from '../../src/db/tx.js';
import {
  acquireWriterLease,
  releaseWriterLease,
  WRITER_CONTROL_LOCK,
} from '../../src/db/writer-lease.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import type { AppEnv } from '../../src/http/response.js';
import { withMigrationLock } from '../../src/lambda/deploy-lock.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { requireMigrationOwnership } from '../../src/lambda/writer-ops.js';
import { hostedModelAdmission, modelLeaseRoute } from '../../src/model/routes.js';
import { recordUsage } from '../../src/model/usage.js';
import { createRecord } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import {
  claimRun,
  installModelRelease,
  modelRelease,
  PICK,
  testRunTokens,
} from '../helpers/model.js';

const db = useTestDatabase();
const previous = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const rolling = 'c'.repeat(40);
const ops = (build: string) =>
  createOpsHandler(loadConfig({ DATABASE_URL: db.url, LOG_LEVEL: 'error' }), build);
const status = () => ops(candidate)({ command: 'writer-admission-status', protocol: 1 });
const denied = { code: '55000', message: 'retainer writer admission denied' };
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

it('fences transactions, pooled reconnects, stale builds and interrupted migrations', async () => {
  // Before activation, both old tools and timed deployments continue to work.
  expect(await status()).toMatchObject({ phase: 'unmanaged' });
  await expect(ops(previous)({ command: 'migrate' })).resolves.toMatchObject({
    command: 'migrate',
  });
  const left = await createWorkspace(db.owner, { name: 'Left', template: 'starter' });
  const right = await createWorkspace(db.owner, { name: 'Right', template: 'starter' });
  const actor = { type: 'user', id: 'writer-test' } as const;
  const record = (
    await createRecord(db.owner, { workspaceId: right.id, actor, scopes: ['admin'] }, 'person', {
      name: 'Original',
    })
  ).record;

  const manifest = modelRelease();
  const catalog = new ExtensionCatalog([{ manifest, runtimeEnabled: true, actorCeiling: 'agent' }]);
  const { tokens } = await testRunTokens();
  const modelApp = startTestApp(db, { extensionCatalog: catalog, runTokens: tokens });
  const installation = await installModelRelease(modelApp, db, manifest);
  const job = await claimRun(modelApp, catalog, installation.workspace, installation.id, PICK);
  const modelToken = await tokens.issueModel(job);
  const modelClaims = await tokens.verifyModel(modelToken);
  await db.owner`update extension_jobs set status = 'succeeded', run_until = null, lease_until = null, lease_owner = null where id = ${job.jobId}`;
  const usage = {
    id: randomUUID(),
    model: 'fixture-model',
    providerRequestId: 'provider-1',
    partial: false,
    inputTokens: 3,
    outputTokens: 2,
    cacheReadInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usage: {},
    at: new Date().toISOString(),
  };

  // Simulate a future migration adding a table. Its guard must be installed
  // in the same transaction before this table can be seen by an application.
  await db.owner.begin(async (tx) => {
    await tx`create table public.writer_fixture (value text not null)`;
    await tx`grant select, insert, update on public.writer_fixture to retainer_app`;
    await tx`select retainer_deploy.install_guards()`;
  });
  await expect(
    ops(previous)({ command: 'writer-admission-open', protocol: 1, candidate: previous }),
  ).resolves.toMatchObject({ phase: 'open' });
  const initial = await status();
  if (!('generation' in initial) || !initial.generation) throw new Error('missing generation');
  const ownership = { generation: initial.generation, deployment: randomUUID(), candidate };
  const close = () =>
    ops(candidate)({
      command: 'writer-admission-close',
      protocol: 1,
      ownership,
      expectedBuilds: [previous, rolling],
      timed: false,
    });

  const old = db.connect({ role: RUNTIME_ROLE, max: 1, writerBuild: previous });
  const next = db.connect({ role: RUNTIME_ROLE, max: 1, writerBuild: candidate });
  const stateLocked = deferred();
  const releaseState = deferred();
  const lockState = db.owner.begin(async (tx) => {
    await tx`select singleton from retainer_deploy.admission where singleton for update`;
    stateLocked.resolve();
    await releaseState.promise;
  });
  await stateLocked.promise;
  const enroll = expect(
    ops(rolling)({
      command: 'writer-admission-enroll',
      protocol: 1,
      candidate: rolling,
      generation: initial.generation,
    }),
  ).resolves.toMatchObject({ phase: 'open' });
  try {
    // Enrollment holds its metadata lock while waiting for the row. Data
    // writers must continue to commit during the ongoing rolling update.
    let holding = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await db.owner`
        select exists (
          select 1 from pg_locks where locktype = 'advisory' and granted
            and objid = ${WRITER_CONTROL_LOCK}::oid
            and database = (select oid from pg_database where datname = current_database())
        ) as holding`;
      if (row?.holding) {
        holding = true;
        break;
      }
      await delay(10);
    }
    expect(holding).toBe(true);
    await expect(
      old`insert into writer_fixture values ('during enrollment') returning value`,
    ).resolves.toEqual([{ value: 'during enrollment' }]);
  } finally {
    releaseState.resolve();
    await lockState;
    await enroll;
  }
  const modelIngress = new Hono<AppEnv>();
  const modelSecret = 'writer-test-model-lease-secret';
  modelLeaseRoute(modelIngress, { sql: old, tokens, secret: modelSecret });
  const callId = randomUUID();
  const releaseAfterLostResponse = hostedModelAdmission(
    {
      origin: 'https://retainer.test',
      secret: modelSecret,
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const response = await modelIngress.request(url, init);
        if (JSON.parse(String(init?.body)).action === 'acquire') {
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ id: callId });
          throw new Error('acquire response lost');
        }
        return response;
      },
    },
    previous,
  );
  await expect(releaseAfterLostResponse(modelToken, callId)).rejects.toThrow(
    'acquire response lost',
  );
  expect(
    await db.owner`select id from retainer_deploy.writer_leases where id = ${callId}`,
  ).toHaveLength(0);

  const tooLate = await modelIngress.request(
    'https://retainer.test/v1/extensions/internal/model-lease',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${modelSecret}` },
      body: JSON.stringify({
        action: 'acquire',
        token: modelToken,
        build: previous,
        callId,
        acquireBy: new Date(Date.now() - 5000).toISOString(),
      }),
    },
  );
  expect(tooLate.status).toBe(503);
  expect(
    await db.owner`select id from retainer_deploy.writer_leases where id = ${callId}`,
  ).toHaveLength(0);

  const proxyLease = await acquireWriterLease(old, 60_000, {
    peerBuild: previous,
    effect: 'model:rolling',
  });
  expect(proxyLease).toBeDefined();
  await releaseWriterLease(
    db.connect({ role: RUNTIME_ROLE, writerBuild: rolling }),
    proxyLease,
    previous,
  );
  const legacy = db.connect({ role: RUNTIME_ROLE, max: 1 });
  await expect(legacy`insert into writer_fixture values ('legacy')`).rejects.toMatchObject(denied);
  await expect(next`insert into writer_fixture values ('premature')`).rejects.toMatchObject(denied);
  await expect(
    inWorkspace(
      old,
      left.id,
      (tx) => tx`update records set label = 'wrong tenant' where id = ${record.id} returning id`,
    ),
  ).resolves.toHaveLength(0);

  const admitted = deferred();
  const finish = deferred();
  const first = old.begin(async (tx) => {
    await tx`insert into writer_fixture values ('committed before close')`;
    admitted.resolve();
    await finish.promise;
  });
  await admitted.promise;
  try {
    await expect(close()).resolves.toMatchObject({ phase: 'busy' });
    await expect(
      ops(candidate)({ command: 'migrate', writerAdmission: ownership }),
    ).rejects.toThrow('verified deployment ownership');
  } finally {
    finish.resolve();
    await first;
  }

  // A durable invocation lease remains visible after its admission pool dies.
  const lease = await acquireWriterLease(old, 60_000);
  const [leasedConnection] = await old`select pg_backend_pid() as id`;
  await db.owner`select pg_terminate_backend(${leasedConnection?.id})`;
  await expect(close()).resolves.toMatchObject({ phase: 'busy' });
  await releaseWriterLease(old, lease);

  // The coordinator may have lost a tool response while a routine is
  // waiting. Finishing the routine does not resolve the orphaned effect.
  const [routine] = await inWorkspace(
    old,
    left.id,
    (tx) => tx`
    insert into routine_runs (workspace_id, mode, trigger_kind, status, lease_owner, lease_until)
      values (${left.id}, 'build', 'build', 'running', 'writer-test', now() + interval '1 minute') returning id`,
  );
  const effect = await acquireWriterLease(old, 1, { effect: 'routine-tool:fixture' });
  expect(effect).toBeDefined();
  await expect(close()).resolves.toMatchObject({ phase: 'busy' });
  await inWorkspace(
    old,
    left.id,
    (tx) => tx`
    update routine_runs set status = 'succeeded', lease_owner = null, lease_until = null where id = ${routine?.id}`,
  );
  await expect(close()).resolves.toMatchObject({ phase: 'busy' });
  await expect(status()).resolves.toMatchObject({
    uncertainEffects: [expect.objectContaining({ id: effect, effect: 'routine-tool:fixture' })],
  });
  await expect(
    ops(candidate)({
      command: 'writer-admission-reconcile',
      protocol: 1,
      lease: effect,
      evidence: 'Fixture tool outcome found under its idempotency key',
    }),
  ).resolves.toMatchObject({ phase: 'reconciled' });

  // Kill a data connection after it writes and before it commits.
  const writing = deferred();
  const finishLost = deferred();
  let pid = 0;
  const lost = old.begin(async (tx) => {
    const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    pid = backend?.pid ?? 0;
    await tx`insert into writer_fixture values ('rolled back on disconnect')`;
    writing.resolve();
    await finishLost.promise;
  });
  await Promise.race([writing.promise, lost]);
  const lostResult = expect(lost).rejects.toThrow();
  await db.owner`select pg_terminate_backend(${pid})`;
  await lostResult;
  finishLost.resolve();

  // Exactly one of a committed write and the exclusive closure may win.
  const racing = old`insert into writer_fixture values ('racing')`;
  const [closed, write] = await Promise.allSettled([close(), racing]);
  expect(closed.status).toBe('fulfilled');
  if (closed.status === 'fulfilled' && 'phase' in closed.value && closed.value.phase === 'busy') {
    expect(write.status).toBe('fulfilled');
    await expect(close()).resolves.toMatchObject({ phase: 'closed' });
  } else {
    expect(closed).toMatchObject({ value: { phase: 'closed' } });
    // A writer may finish before closure obtains its lock, otherwise it is rejected.
    if (write.status === 'rejected') expect(write.reason).toMatchObject(denied);
  }
  await expect(ops(candidate)({ command: 'migrate' })).rejects.toThrow(
    'verified deployment ownership',
  );
  await expect(runMigrations(db.url)).rejects.toThrow('managed writer admission');
  await expect(recordUsage(old, modelClaims, usage)).rejects.toMatchObject(denied);
  await expect(old`update writer_fixture set value = 'stale after close'`).rejects.toMatchObject(
    denied,
  );
  await expect(
    old.begin('read only', (tx) => tx`select value from writer_fixture`),
  ).resolves.toEqual(expect.arrayContaining([{ value: 'committed before close' }]));

  const open = () =>
    ops(candidate)({ command: 'writer-admission-open', protocol: 1, ownership, candidate });
  const migration = db.connect({ max: 1 });
  const ddl = deferred();
  const finishDdl = deferred();
  let ddlPid = 0;
  const interrupted = withMigrationLock(migration, 1, async (tx) => {
    await requireMigrationOwnership(tx, ownership, candidate);
    const [backend] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
    ddlPid = backend?.pid ?? 0;
    await tx`create table public.writer_interrupted_ddl (value int)`;
    ddl.resolve();
    await finishDdl.promise;
  });
  await Promise.race([ddl.promise, interrupted]);
  const interruptedResult = expect(interrupted).rejects.toThrow();
  await expect(open()).resolves.toMatchObject({ phase: 'busy' });
  await db.owner`select pg_terminate_backend(${ddlPid})`;
  await interruptedResult;
  finishDdl.resolve();
  expect(await db.owner`select to_regclass('public.writer_interrupted_ddl') as name`).toEqual([
    { name: null },
  ]);
  await expect(open()).rejects.toThrow('owned migration completes');

  const journal =
    await db.owner`select hash, created_at from drizzle.__drizzle_migrations order by id`;
  await expect(
    ops(candidate)({ command: 'migrate', writerAdmission: ownership }),
  ).resolves.toMatchObject({ command: 'migrate' });
  // The caller lost the successful response. Its replacement can prove the
  // same ownership and reconcile the journal without reapplying DDL.
  await expect(status()).resolves.toMatchObject({ phase: 'closed', migrated: true, ...ownership });
  await expect(
    ops(candidate)({ command: 'migrate', writerAdmission: ownership }),
  ).resolves.toMatchObject({ command: 'migrate' });
  expect(
    await db.owner`select hash, created_at from drizzle.__drizzle_migrations order by id`,
  ).toEqual(journal);
  const reopened = await open();
  expect(reopened).toMatchObject({
    phase: 'open',
    generation: expect.not.stringMatching(ownership.generation),
  });

  await expect(old`insert into writer_fixture values ('stale after reopen')`).rejects.toMatchObject(
    denied,
  );
  await expect(acquireWriterLease(next, 1_000, { peerBuild: previous })).rejects.toThrow(
    'admission denied',
  );
  await expect(
    next`insert into writer_fixture values ('new writer') returning value`,
  ).resolves.toEqual([{ value: 'new writer' }]);
  const values = (await db.owner`select value from writer_fixture`).map((row) => row.value);
  expect(values).not.toContain('rolled back on disconnect');
  expect(values).not.toContain('stale after reopen');
  await expect(
    ops(previous)({
      command: 'writer-admission-enroll',
      protocol: 1,
      candidate: previous,
      generation: (reopened as { generation: string }).generation,
    }),
  ).rejects.toThrow('retired writer build');
  // A delayed report can reach the current build twice. The same durable
  // usage ID yields one effect. The invocation running old code cannot write it.
  await expect(recordUsage(old, modelClaims, usage)).rejects.toMatchObject(denied);
  await Promise.all([recordUsage(next, modelClaims, usage), recordUsage(next, modelClaims, usage)]);
  expect(await db.owner`select id from ai_usage where id = ${usage.id}`).toHaveLength(1);
  const [rightRecord] = await db.owner`select label from records where id=${record.id}`;
  expect(rightRecord?.label).toBe('Original');
});
