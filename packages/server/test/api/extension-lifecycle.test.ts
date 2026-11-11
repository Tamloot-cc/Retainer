import { randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { ChangeMaintenance } from '../../src/worker/changes.js';
import { ExecutionRegistry, ExtensionExecutor } from '../../src/worker/extensions.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const setupId = randomUUID(),
  cleanupId = randomUUID(),
  childId = randomUUID();
const manifest = extensionFixture({
  scopes: ['read', 'write'],
  functions: (
    [
      [setupId, 'setup', 'install'],
      [cleanupId, 'cleanup', 'uninstall'],
      [childId, 'sync', 'job'],
    ] as const
  ).map(([id, name, kind]) => ({
    universalId: id,
    name: name,
    description: 'Lifecycle fixture',
    handlerDigest: 'b'.repeat(64),
    timeoutSeconds: 120,
    trigger: { kind: kind as 'install' | 'uninstall' | 'job' },
    inputSchema: { type: 'object' as const, additionalProperties: false as const },
  })),
});
const noHook = extensionFixture();
const allCatalog = new ExtensionCatalog([
  { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  { manifest: noHook, actorCeiling: 'integration', runtimeEnabled: true },
]);
let t: TestApp, tokens: RunTokens;
const queue = () =>
  new ExtensionQueue(t.sql, (id, version) => allCatalog.get(id, version).manifest);
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  t = startTestApp(db, {
    extensionCatalog: allCatalog,
    runTokens: tokens,
    extensionActivation: new Set(allCatalog.list().map((r) => r.digest)),
  });
});
async function install(target = manifest) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Lifecycle ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const input = { registrationId: target.universalId, version: target.version, settings: {} };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(preview.status).toBe(200);
  expect(preview.body.warnings).toEqual([]);
  const responses = await Promise.all(
    [0, 1].map(() =>
      t.request('/v1/extensions', {
        key: keys.admin,
        body: { ...input, planDigest: preview.body.planDigest },
        headers: { 'Idempotency-Key': 'install' },
      }),
    ),
  );
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  expect(responses[0]?.body).toEqual(responses[1]?.body);
  expect(responses[0]?.body.state).toBe('installing');
  return { workspace: workspace.id, key: keys.admin, id: responses[0]?.body.id as string };
}
async function claim(workspace: string, id: string, kind = 'install') {
  const [job] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind=${kind} and status='queued' order by id limit 1`;
  expect(job).toBeDefined();
  const claimed = await queue().claim(workspace, job?.id, randomUUID());
  expect(claimed).not.toBeNull();
  if (!claimed) throw new Error('claim failed');
  return claimed;
}
const state = async (id: string) =>
  (
    await db.owner`select state,last_error,generation from extension_installations where id=${id}`
  )[0];

describe('approved runtime lifecycle on real Postgres', () => {
  it.each(['install', 'upgrade'] as const)(
    'expires queued and abandoned running %s setup atomically under competing maintenance',
    async (kind) => {
      for (const running of [false, true]) {
        const { workspace, key, id } = await install();
        if (kind === 'upgrade')
          await db.owner`update extension_installations set setup_kind='upgrade',state='upgrading' where id=${id}`;
        const [job] =
          await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
        if (running) await claim(workspace, id);
        await db.owner`update extension_jobs set expires_at=clock_timestamp()-interval '1 second',lease_until=case when status='running' then clock_timestamp()-interval '1 second' else null end where id=${job?.id}`;
        const discovery = db.connect({ role: 'retainer_executor' });
        const results = await Promise.all([
          new ChangeMaintenance(t.sql, discovery).tick(),
          new ChangeMaintenance(t.sql, discovery).tick(),
        ]);
        expect(results.map((row) => row.failed)).toEqual([0, 0]);
        expect(await state(id)).toMatchObject({
          state: kind === 'upgrade' ? 'disabled' : 'setup_failed',
          last_error: 'job_expired',
        });
        expect(
          (await db.owner`select status,code from extension_jobs where id=${job?.id}`)[0],
        ).toEqual({ status: 'failed', code: 'job_expired' });
        const attempts =
          await db.owner`select status,code,finished_at from extension_attempts where job_id=${job?.id}`;
        expect(attempts).toHaveLength(running ? 1 : 0);
        for (const attempt of attempts) {
          expect(attempt).toMatchObject({
            status: 'failed',
            code: 'job_expired',
            finished_at: expect.any(Date),
          });
        }
        expect(
          (
            await t.request(`/v1/extensions/${id}/runs/${job?.id}/retry`, {
              key,
              method: 'POST',
              headers: { 'Idempotency-Key': 'retry-expired-setup' },
            })
          ).status,
        ).toBe(200);
        expect(await queue().claim(workspace, job?.id, 'after-maintenance')).toBeTruthy();
      }
    },
  );
  it('atomically queues setup, fences CRM until activation, and starts durable children after setup succeeds', async () => {
    const { workspace, key, id } = await install();
    const run = await claim(workspace, id);
    const token = await tokens.issue(t.sql, run, manifest.universalId, run.scopes);
    const blocked = await t.request('/v1/objects/company/records', {
      key: token,
      body: { values: { name: 'Premature' } },
    });
    expect(blocked.body.error.code).toBe('installation_disabled');
    expect(
      (
        await t.request(`/v1/extensions/${id}/runtime/checkpoint`, {
          key: token,
          body: {
            children: [{ functionId: childId, input: {}, dedupeKey: 'child' }],
            kv: { key: 'cursor', expectedRevision: null, value: 'page-2' },
          },
        })
      ).status,
    ).toBe(200);
    const [child] =
      await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='job'`;
    expect(await queue().claim(workspace, child?.id, 'early')).toBeNull();
    // A queued child must remain queued during setup rather than being discarded by admission.
    expect(
      (await db.owner`select status from extension_jobs where id=${child?.id}`)[0]?.status,
    ).toBe('queued');
    expect((await queue().complete(run, { status: 'succeeded' })).activated).toBe(true);
    expect((await state(id))?.state).toBe('active');
    const sync = await claim(workspace, id, 'job');
    const syncToken = await tokens.issue(t.sql, sync, manifest.universalId, sync.scopes);
    expect(
      (
        await t.request('/v1/objects/company/records', {
          key: syncToken,
          body: { values: { name: 'After setup' } },
        })
      ).status,
    ).toBe(201);
    await t.request(`/v1/extensions/${id}/disable`, { key, method: 'POST' });
    expect(
      (
        await t.request('/v1/objects/company/records', {
          key: syncToken,
          body: { values: { name: 'Disabled' } },
        })
      ).status,
    ).toBe(409);
    const enable = await t.request(`/v1/extensions/${id}/enable`, { key, method: 'POST' });
    expect(enable.body.state).toBe('installing');
    expect(enable.body.generation).toBe(3);
  });
  it('records safe setup failure, retries once across concurrent requests, and explicit disable prevents retry', async () => {
    const { workspace, key, id } = await install();
    const run = await claim(workspace, id);
    await queue().complete(run, { status: 'failed', code: 'connection_required' });
    expect(await state(id)).toMatchObject({
      state: 'setup_failed',
      last_error: 'connection_required',
    });
    const retries = await Promise.all(
      [0, 1].map(() =>
        t.request(`/v1/extensions/${id}/runs/${run.jobId}/retry`, {
          key,
          method: 'POST',
          headers: { 'Idempotency-Key': 'retry' },
        }),
      ),
    );
    expect(retries.map((r) => r.status)).toEqual([200, 200]);
    expect((await state(id))?.state).toBe('installing');
    const next = await claim(workspace, id);
    await queue().complete(next, { status: 'failed', code: 'provider_unavailable' });
    await t.request(`/v1/extensions/${id}/disable`, { key, method: 'POST' });
    const denied = await t.request(`/v1/extensions/${id}/runs/${run.jobId}/retry`, {
      key,
      method: 'POST',
      headers: { 'Idempotency-Key': 'after-disable' },
    });
    expect(denied.status).toBe(409);
    expect((await state(id))?.state).toBe('disabled');
  });
  it('revokes old runs before cleanup, restricts cleanup to connection access, and completes uninstall', async () => {
    const { workspace, key, id } = await install();
    await queue().complete(await claim(workspace, id), { status: 'succeeded' });
    const [a, b] = await Promise.all(
      [0, 1].map(() => t.request(`/v1/extensions/${id}/uninstall`, { key, method: 'POST' })),
    );
    expect(a?.body.state).toBe('uninstalling');
    expect(a?.body).toEqual(b?.body);
    const cleanup = await claim(workspace, id, 'uninstall');
    const token = await tokens.issue(t.sql, cleanup, manifest.universalId, cleanup.scopes);
    expect((await t.request('/v1/objects/company/query', { key: token, body: {} })).status).toBe(
      409,
    );
    expect(
      (
        await t.request(`/v1/extensions/${id}/runtime/checkpoint`, {
          key: token,
          body: { children: [] },
        })
      ).status,
    ).toBe(403);
    expect((await t.request(`/v1/extensions/${id}/runtime/kv/cursor`, { key: token })).status).toBe(
      403,
    );
    await queue().complete(cleanup, { status: 'succeeded' });
    expect((await state(id))?.state).toBe('uninstalled');
  });
  it('reaps failed cleanup at its bounded deadline and fences its outstanding lease', async () => {
    const { workspace, key, id } = await install();
    await queue().complete(await claim(workspace, id), { status: 'succeeded' });
    await t.request(`/v1/extensions/${id}/uninstall`, { key, method: 'POST' });
    const cleanup = await claim(workspace, id, 'uninstall');
    await db.owner`update extension_installations set cleanup_deadline=clock_timestamp()-interval '1 second' where id=${id}`;
    await queue().maintain(db.connect({ role: 'retainer_executor' }));
    expect(await state(id)).toMatchObject({
      state: 'uninstalled',
      last_error: 'cleanup_deadline_expired',
    });
    await expect(queue().complete(cleanup, { status: 'succeeded' })).rejects.toMatchObject({
      code: 'installation_disabled',
    });
  });
  it('uses a server builtin acknowledgement for releases without hooks and never issues its job a token', async () => {
    const { workspace, id } = await install(noHook);
    const run = await claim(workspace, id);
    expect(run.system).toBe(true);
    await expect(tokens.issue(t.sql, run, noHook.universalId, run.scopes)).rejects.toThrow(
      'no run credentials',
    );
    const executor = new ExtensionExecutor({
      sql: t.sql,
      discoverySql: db.connect({ role: 'retainer_executor' }),
      catalog: allCatalog,
      registry: new ExecutionRegistry([]),
      tokens,
      driver: {
        invoke: async () => {
          throw new Error('builtin must never launch a package');
        },
      },
      apiOrigin: 'https://retainer.test',
      owner: 'builtin',
    });
    expect(await executor.execute(run)).toBe('succeeded');
    expect((await state(id))?.state).toBe('active');
  });
});
