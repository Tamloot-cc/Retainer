import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { type ClaimedJob, ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const functionId = randomUUID(),
  installFn = randomUUID();
const inputSchema = {
  type: 'object' as const,
  properties: { sourceId: { type: 'string' as const, maxLength: 100 } },
  required: ['sourceId'],
  additionalProperties: false as const,
};
const manifest = extensionFixture({
  functions: [
    {
      universalId: functionId,
      name: 'sync',
      description: 'Sync one source ID',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'job' },
      timeoutSeconds: 120,
      inputSchema,
    },
    {
      universalId: installFn,
      name: 'install',
      description: 'Setup fixture',
      handlerDigest: 'c'.repeat(64),
      trigger: { kind: 'install' },
      timeoutSeconds: 120,
      inputSchema,
    },
  ],
});
const catalog = new ExtensionCatalog([
  { manifest, actorCeiling: 'integration', runtimeEnabled: true },
]);
let t: TestApp;
beforeAll(() => {
  t = startTestApp(db, { extensionCatalog: catalog });
});
const resolve = catalog.runtime;

async function setup(limits = { queued: 10000, kvBytes: 1048576 }) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Queue ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(preview.status).toBe(200);
  const response = await t.request('/v1/extensions', {
    key: keys.admin,
    headers: { 'Idempotency-Key': 'install' },
    body: { ...input, planDigest: preview.body.planDigest },
  });
  expect(response.status).toBe(201);
  // Trusted fixture activation, bypassing unavailable production execution for queue verification only.
  await db.owner`update extension_installations set state='active' where id=${response.body.id}`;
  return {
    workspace: workspace.id,
    installation: response.body.id as string,
    key: keys.admin,
    queue: new ExtensionQueue(t.sql, resolve, limits),
  };
}
const job = (key: string) => ({ functionId, input: { sourceId: key }, dedupeKey: key });
function claimed(value: ClaimedJob | null): ClaimedJob {
  if (!value) throw new Error('expected a lease');
  return value;
}

describe('durable extension jobs and checkpoints', () => {
  it('deduplicates concurrent enqueue and claims one run per installation', async () => {
    const { workspace, installation, queue } = await setup();
    const results = await Promise.all([
      queue.enqueue(workspace, installation, job('same')),
      queue.enqueue(workspace, installation, job('same')),
    ]);
    expect(results[0]).toEqual(results[1]);
    const id = results[0]?.id;
    if (!id) throw new Error('job missing');
    await expect(
      queue.enqueue(workspace, installation, { ...job('same'), input: { sourceId: 'different' } }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const leases = await Promise.all([
      queue.claim(workspace, id, 'worker-a'),
      queue.claim(workspace, id, 'worker-b'),
    ]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const lease = claimed(leases.find(Boolean) ?? null);
    const second = await queue.enqueue(workspace, installation, job('second'));
    expect(await queue.claim(workspace, second.id, 'worker-c')).toBeNull();
    await queue.complete(lease, { status: 'succeeded' });
    expect(await queue.claim(workspace, second.id, 'worker-c')).not.toBeNull();
  });
  it('fences an expired worker after takeover, including renew, ack and checkpoint', async () => {
    const { workspace, installation, queue } = await setup();
    const { id } = await queue.enqueue(workspace, installation, job('takeover'));
    const old = claimed(await queue.claim(workspace, id, 'old-worker'));
    await db.owner`update extension_jobs set lease_until=clock_timestamp()-interval '1 second' where id=${id}`;
    const next = claimed(await queue.claim(workspace, id, 'new-worker'));
    expect(Number(next.fence)).toBe(Number(old.fence) + 1);
    await expect(queue.renew(old)).rejects.toMatchObject({ code: 'lease_expired' });
    await expect(queue.complete(old, { status: 'succeeded' })).rejects.toMatchObject({
      code: 'lease_expired',
    });
    await expect(queue.checkpoint(old, { children: [job('stale-child')] })).rejects.toMatchObject({
      code: 'lease_expired',
    });
    await queue.complete(next, { status: 'succeeded' });
    const attempts =
      await db.owner`select status from extension_attempts where job_id=${id} order by attempt`;
    expect(attempts.map((a) => a.status)).toEqual(['expired', 'succeeded']);
  });
  it('keeps checkpoint and every child unchanged when the queue quota is exhausted', async () => {
    const { workspace, installation, queue } = await setup({ queued: 2, kvBytes: 1048576 });
    const { id } = await queue.enqueue(workspace, installation, job('page'));
    const lease = claimed(await queue.claim(workspace, id, 'scanner'));
    await queue.checkpoint(lease, {
      children: [],
      kv: { key: 'cursor', expectedRevision: null, value: 'before' },
    });
    await expect(
      queue.checkpoint(lease, {
        children: [job('child-1'), job('child-2')],
        kv: { key: 'cursor', expectedRevision: 1, value: 'after' },
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(await queue.getKv(lease, 'cursor')).toEqual({ value: 'before', revision: 1 });
    const [count] =
      await db.owner`select count(*)::int as count from extension_jobs where installation_id=${installation}`;
    expect(count?.count).toBe(1);
    const checkpoint = await queue.checkpoint(lease, {
      children: [job('child-1')],
      kv: { key: 'cursor', expectedRevision: 1, value: 'after' },
    });
    expect(checkpoint.revision).toBe(2);
    // A retry with the new expected revision reuses the durable business child.
    const retried = await queue.checkpoint(lease, {
      children: [job('child-1')],
      kv: { key: 'cursor', expectedRevision: 2, value: 'after' },
    });
    expect(retried.ids).toEqual(checkpoint.ids);
  });
  it('serializes KV CAS and rolls children back when a competing cursor wins', async () => {
    const { workspace, installation, queue } = await setup();
    const { id } = await queue.enqueue(workspace, installation, job('cas'));
    const lease = claimed(await queue.claim(workspace, id, 'scanner'));
    await queue.checkpoint(lease, {
      children: [],
      kv: { key: 'cursor', expectedRevision: null, value: 0 },
    });
    const results = await Promise.allSettled(
      [1, 2].map((n) =>
        queue.checkpoint(lease, {
          children: [job(`cas-${n}`)],
          kv: { key: 'cursor', expectedRevision: 1, value: n },
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const [count] =
      await db.owner`select count(*)::int as count from extension_jobs where installation_id=${installation}`;
    expect(count?.count).toBe(2);
    expect((await queue.getKv(lease, 'cursor'))?.revision).toBe(2);
  });
  it('rejects cross-workspace leases, lifecycle enqueue and malformed input', async () => {
    const a = await setup(),
      b = await setup();
    const { id } = await a.queue.enqueue(a.workspace, a.installation, job('isolated'));
    const lease = claimed(await a.queue.claim(a.workspace, id, 'worker'));
    await expect(
      a.queue.getKv({ ...lease, workspaceId: b.workspace }, 'cursor'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      a.queue.getKv({ ...lease, installationId: b.installation }, 'cursor'),
    ).rejects.toMatchObject({ status: 404 });
    for (const input of [
      {},
      { sourceId: 'ok', unknown: 'no' },
      { sourceId: 33 },
      JSON.parse('{"sourceId":"ok","constructor":{}}'),
    ])
      await expect(
        a.queue.enqueue(a.workspace, a.installation, { ...job(randomUUID()), input }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      a.queue.enqueue(a.workspace, a.installation, { ...job('lifecycle'), functionId: installFn }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('cancels queued/running jobs on disable and refuses old leases after it returns', async () => {
    const { workspace, installation, queue, key } = await setup();
    const { id } = await queue.enqueue(workspace, installation, job('disable'));
    const lease = claimed(await queue.claim(workspace, id, 'worker'));
    await Promise.allSettled([
      queue.checkpoint(lease, { children: [job('racing-child')] }),
      t.request(`/v1/extensions/${installation}/disable`, { key, method: 'POST' }),
    ]);
    await expect(queue.renew(lease)).rejects.toMatchObject({ code: 'installation_disabled' });
    await expect(
      queue.checkpoint(lease, { children: [job('after-disable')] }),
    ).rejects.toMatchObject({ code: 'installation_disabled' });
    const pending =
      await db.owner`select id from extension_jobs where installation_id=${installation} and status in ('queued','running')`;
    expect(pending).toHaveLength(0);
  });
  it('bounds attempt lifetime, retries with delay, and exposes only IDs to the discovery role', async () => {
    const { workspace, installation, queue } = await setup();
    const { id } = await queue.enqueue(workspace, installation, job('retry'));
    const discovery = db.connect({ role: 'retainer_executor' });
    expect(await queue.discover(discovery)).toContainEqual({ workspace_id: workspace, job_id: id });
    await expect(discovery`select * from extension_jobs`).rejects.toMatchObject({ code: '42501' });
    await expect(
      t.sql`select * from retainer_extension_jobs_due(100,${[]}::uuid[],${[]}::text[])`,
    ).rejects.toMatchObject({
      code: '42501',
    });
    const lease = claimed(await queue.claim(workspace, id, 'worker'));
    await queue.complete(lease, {
      status: 'retry',
      code: 'provider_unavailable',
      retryAfterSeconds: 120,
    });
    expect(await queue.claim(workspace, id, 'too-early')).toBeNull();
    await db.owner`update extension_jobs set available_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()-interval '1 second' where id=${id}`;
    expect(await queue.claim(workspace, id, 'expired')).toBeNull();
    const [row] = await db.owner`select status,code from extension_jobs where id=${id}`;
    expect(row).toEqual({ status: 'failed', code: 'retry_exhausted' });
  });
  it('lists only safe paginated diagnostics and retries failed work with a durable admin receipt', async () => {
    const { workspace, installation, queue, key } = await setup();
    const ids = [];
    for (const name of ['failure-a', 'failure-b']) {
      const { id } = await queue.enqueue(workspace, installation, job(name));
      ids.push(id);
      await queue.complete(claimed(await queue.claim(workspace, id, 'worker')), {
        status: 'failed',
        code: 'invalid_provider_id',
      });
    }
    const page = await t.request(`/v1/extensions/${installation}/runs?limit=1`, { key });
    expect(page.status).toBe(200);
    expect(page.body.runs).toHaveLength(1);
    expect(page.body.runs[0]).not.toHaveProperty('input');
    expect(page.body.runs[0]).not.toHaveProperty('lease_owner');
    expect(page.body.nextCursor).toBeTruthy();
    const second = await t.request(
      `/v1/extensions/${installation}/runs?limit=1&cursor=${page.body.nextCursor}`,
      { key },
    );
    expect(second.body.runs[0].id).not.toBe(page.body.runs[0].id);
    expect(second.body.nextCursor).toBeNull();
    const id = ids[0];
    if (!id) throw new Error('missing failed run');
    const retries = await Promise.all(
      [1, 2].map(() =>
        t.request(`/v1/extensions/${installation}/runs/${id}/retry`, {
          key,
          method: 'POST',
          headers: { 'Idempotency-Key': 'retry-failed' },
        }),
      ),
    );
    expect(retries.map((r) => r.status)).toEqual([200, 200]);
    expect(retries[0]?.body).toEqual({ id, status: 'queued' });
    const lease = claimed(await queue.claim(workspace, id, 'retry-worker'));
    expect(lease.attempt).toBe(2);
    await queue.complete(lease, { status: 'succeeded' });
    expect(
      (
        await queue.retry(
          { workspaceId: workspace, actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
          installation,
          id,
          'retry-failed',
        )
      ).status,
    ).toBe('queued');
    const attempts =
      await db.owner`select status from extension_attempts where job_id=${id} order by attempt`;
    expect(attempts.map((a) => a.status)).toEqual(['failed', 'succeeded']);
  });
  it('enforces workspace capacity across simultaneous claims from separate installations', async () => {
    const manifests = Array.from({ length: 5 }, () =>
      extensionFixture({ functions: manifest.functions }),
    );
    const releases = new ExtensionCatalog(
      manifests.map((manifest) => ({
        manifest,
        actorCeiling: 'integration' as const,
        runtimeEnabled: true,
      })),
    );
    const app = startTestApp(db, { extensionCatalog: releases });
    const { workspace, keys } = await app.setupWorkspace(
      { name: `Capacity ${randomUUID()}` },
      { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
    );
    const capacityQueue = new ExtensionQueue(app.sql, releases.runtime);
    const ids = [];
    for (const manifest of manifests) {
      const input = {
        registrationId: manifest.universalId,
        version: manifest.version,
        settings: {},
      };
      const p = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
      const install = await app.request('/v1/extensions', {
        key: keys.admin,
        headers: { 'Idempotency-Key': manifest.universalId },
        body: { ...input, planDigest: p.body.planDigest },
      });
      expect(install.status).toBe(201);
      await db.owner`update extension_installations set state='active' where id=${install.body.id}`;
      ids.push(
        (await capacityQueue.enqueue(workspace.id, install.body.id, job(manifest.universalId))).id,
      );
    }
    const leases = await Promise.all(
      ids.map((id, n) => capacityQueue.claim(workspace.id, id, `capacity-${n}`)),
    );
    expect(leases.filter(Boolean)).toHaveLength(4);
    const first = claimed(leases.find(Boolean) ?? null);
    await capacityQueue.complete(first, { status: 'succeeded' });
    const skipped = ids.find((_id, n) => leases[n] === null);
    if (!skipped) throw new Error('expected a capped job');
    expect(await capacityQueue.claim(workspace.id, skipped, 'after-capacity')).not.toBeNull();
  });
});
