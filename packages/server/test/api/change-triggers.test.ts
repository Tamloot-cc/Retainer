import { randomUUID } from 'node:crypto';
import { BASE_OBJECT_IDS } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { ChangeMaintenance } from '../../src/worker/changes.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const workspaceIds: string[] = [];
afterEach(async () => {
  if (workspaceIds.length)
    await db.owner`delete from workspaces where id=any(${workspaceIds.splice(0)}::uuid[])`;
});
let tokens: RunTokens;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'changes',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});
async function setup(count = 1) {
  const initial = startTestApp(db),
    { workspace, keys } = await initial.setupWorkspace(
      { name: `Triggers ${randomUUID()}` },
      { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
    );
  const [field] = await db.owner<
    { universal_id: string; key: string }[]
  >`select universal_id,key from fields where workspace_id=${workspace.id} and name='jobTitle'`;
  workspaceIds.push(workspace.id);
  if (!field) throw new Error('watch field missing');
  const manifests = Array.from({ length: count }, () =>
    extensionFixture({
      scopes: ['read', 'write'],
      functions: [
        {
          universalId: randomUUID(),
          name: 'react',
          description: 'React to minimal change metadata',
          handlerDigest: 'b'.repeat(64),
          timeoutSeconds: 120,
          trigger: {
            kind: 'change',
            objectId: BASE_OBJECT_IDS.person,
            fieldIds: [field.universal_id],
          },
          inputSchema: {
            type: 'object',
            properties: { changePosition: { type: 'string', maxLength: 19 } },
            required: ['changePosition'],
            additionalProperties: false,
          },
        },
      ],
    }),
  );
  const catalog = new ExtensionCatalog(
    manifests.map((manifest) => ({
      manifest,
      actorCeiling: 'integration' as const,
      runtimeEnabled: true,
    })),
  );
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
  });
  const resolve = catalog.runtime,
    queue = new ExtensionQueue(app.sql, resolve),
    ids: string[] = [];
  for (const manifest of manifests) {
    const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
    const plan = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
    const installed = await app.request('/v1/extensions', {
      key: keys.admin,
      body: { ...input, planDigest: plan.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(installed.status).toBe(201);
    ids.push(installed.body.id);
    const [setup] =
      await db.owner`select id from extension_jobs where installation_id=${installed.body.id} and trigger_kind='install'`;
    const run = await queue.claim(workspace.id, setup?.id, 'setup');
    if (!run) throw new Error('setup missing');
    await queue.complete(run, { status: 'succeeded' });
  }
  async function person(name: string) {
    const result = await app.request('/v1/objects/person/records', {
      key: keys.admin,
      body: { values: { name } },
    });
    expect(result.status).toBe(201);
    return result.body.id as string;
  }
  async function job(installation: string, record: string) {
    const [row] = await db.owner<
      { id: string; input: { changePosition: string }; cause: string[] }[]
    >`select j.id,j.input,j.cause from extension_jobs j join record_changes c on c.workspace_id=j.workspace_id and c.position=(j.input->>'changePosition')::bigint
      where j.installation_id=${installation} and j.trigger_kind='change' and c.record_id=${record} and j.status='queued' order by c.position desc limit 1`;
    if (!row) throw new Error('change job missing');
    return row;
  }
  async function claim(installation: string, record: string) {
    const pending = await job(installation, record),
      run = await queue.claim(workspace.id, pending.id, 'change-worker');
    if (!run) throw new Error('change claim missing');
    const manifest = manifests[ids.indexOf(installation)];
    if (!manifest) throw new Error('registration missing');
    return {
      run,
      key: await tokens.issue(app.sql, run, manifest.universalId, run.scopes),
      pending,
    };
  }
  return { app, workspace, keys, manifests, ids, field, queue, resolve, person, job, claim };
}
describe('transactional change dispatch with real Postgres', () => {
  it('deduplicates competing dispatchers and keeps matching jobs and checkpoint atomic at capacity', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    await h.person('One');
    await h.person('Two');
    const limited = new ExtensionQueue(h.app.sql, h.resolve, { queued: 1, kvBytes: 1048576 });
    await expect(limited.dispatchChanges(h.workspace.id, id)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    expect(
      (await h.app.request(`/v1/extensions/${id}`, { key: h.keys.admin })).body.connectionHealth,
    ).toBe('degraded');
    expect(
      await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='change'`,
    ).toHaveLength(0);
    const [cursor] =
      await db.owner`select position::text from change_dispatch where installation_id=${id}`;
    expect(cursor?.position).toBe('0');
    const results = await Promise.all([
      h.queue.dispatchChanges(h.workspace.id, id),
      h.queue.dispatchChanges(h.workspace.id, id),
    ]);
    expect(results.reduce((n, r) => n + r.queued, 0)).toBe(2);
    const jobs =
      await db.owner`select input from extension_jobs where installation_id=${id} and trigger_kind='change'`;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => Object.keys(j.input).join(',') === 'changePosition')).toBe(true);
  });
  it('keeps UUID/key watches through a rename and ignores an unrelated effective field change', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const person = await h.person('Watch person');
    await h.queue.dispatchChanges(h.workspace.id, id);
    await h.app.request(`/v1/records/${person}`, {
      key: h.keys.admin,
      method: 'PATCH',
      body: { values: { name: 'Unwatched name' } },
    });
    expect(await h.queue.dispatchChanges(h.workspace.id, id)).toEqual({ queued: 0, blocked: 0 });
    expect(
      (
        await h.app.request('/v1/schema/changes', {
          key: h.keys.admin,
          body: {
            operations: [
              { op: 'rename_field', object: 'person', field: 'jobTitle', name: 'positionTitle' },
            ],
          },
        })
      ).status,
    ).toBe(200);
    await h.app.request(`/v1/records/${person}`, {
      key: h.keys.admin,
      method: 'PATCH',
      body: { values: { positionTitle: 'Renamed watch' } },
    });
    expect((await h.queue.dispatchChanges(h.workspace.id, id)).queued).toBe(1);
    const [row] =
      await db.owner`select field_keys from record_changes where record_id=${person} order by position desc limit 1`;
    expect(row?.field_keys).toEqual([h.field.key]);
  });
  it('propagates server-derived causation and stops direct and A to B to A cycles', async () => {
    const h = await setup(2),
      [a, b] = h.ids;
    if (!a || !b) throw new Error('installations missing');
    const person = await h.person('Causal person');
    await h.queue.dispatchChanges(h.workspace.id, a);
    await h.queue.dispatchChanges(h.workspace.id, b);
    const first = await h.claim(a, person);
    expect(
      (
        await h.app.request(`/v1/records/${person}`, {
          key: first.key,
          method: 'PATCH',
          body: { values: { jobTitle: 'From A' } },
        })
      ).status,
    ).toBe(200);
    await h.queue.complete(first.run, { status: 'succeeded' });
    expect((await h.queue.dispatchChanges(h.workspace.id, a)).blocked).toBe(1);
    expect(
      (await h.app.request(`/v1/extensions/${a}`, { key: h.keys.admin })).body.connectionHealth,
    ).toBe('ok');
    expect((await h.queue.dispatchChanges(h.workspace.id, b)).queued).toBe(1);
    const second = await h.claim(b, person);
    expect(second.pending.cause).toEqual([a]);
    expect(
      (
        await h.app.request(`/v1/records/${person}`, {
          key: second.key,
          method: 'PATCH',
          body: { values: { jobTitle: 'From B' } },
        })
      ).status,
    ).toBe(200);
    await h.queue.complete(second.run, { status: 'succeeded' });
    const [change] =
      await db.owner`select cause,origin_installation_id from record_changes where record_id=${person} order by position desc limit 1`;
    expect(change).toEqual({ cause: [a, b], origin_installation_id: b });
    expect((await h.queue.dispatchChanges(h.workspace.id, a)).blocked).toBe(1);
    const [blocked] =
      await db.owner`select blocked_cycles from change_dispatch where installation_id=${a}`;
    expect(blocked?.blocked_cycles).toBe(2);
    expect((await h.app.request(`/v1/extensions/${a}`, { key: h.keys.admin })).body.lastError).toBe(
      'trigger_cycle_blocked',
    );
    expect(
      (
        await h.app.request(`/v1/records/${person}`, {
          key: h.keys.admin,
          method: 'PATCH',
          body: { values: { jobTitle: 'Spoof' }, cause: [b] },
        })
      ).status,
    ).toBe(400);
  });
  it('fences fetched content and clears runtime KV during erasure while retaining unrelated durable work', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const erased = await h.person('Erase'),
      survivor = await h.person('Survive');
    await h.queue.dispatchChanges(h.workspace.id, id);
    const old = await h.claim(id, survivor),
      erasedJob = await h.job(id, erased);
    await h.queue.checkpoint(old.run, {
      children: [],
      kv: { key: 'operational-record-id', expectedRevision: null, value: { recordId: erased } },
    });
    expect(
      (await h.app.request(`/v1/records/${erased}/forget`, { key: h.keys.admin, method: 'POST' }))
        .status,
    ).toBe(200);
    expect(
      (
        await h.app.request(`/v1/records/${survivor}`, {
          key: old.key,
          method: 'PATCH',
          body: { values: { jobTitle: 'Old fetched data' } },
        })
      ).status,
    ).toBe(409);
    const [redacted] =
      await db.owner`select input,status from extension_jobs where id=${erasedJob.id}`;
    expect(redacted).toEqual({ input: {}, status: 'cancelled' });
    const [retained] =
      await db.owner`select status,input from extension_jobs where id=${old.run.jobId}`;
    expect(retained?.status).toBe('queued');
    expect(retained?.input).toEqual(old.pending.input);
    expect(await db.owner`select key from extension_kv where installation_id=${id}`).toHaveLength(
      0,
    );
    const next = await h.queue.claim(h.workspace.id, old.run.jobId, 'fresh-worker');
    expect(next).toBeTruthy();
  });
  it('uses discovery-only permissions and performs competing maintenance passes without duplicate jobs', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    await h.person('Maintenance');
    const discovery = db.connect({ role: 'retainer_executor' }),
      a = new ChangeMaintenance(h.app.sql, discovery, h.queue),
      b = new ChangeMaintenance(h.app.sql, discovery, h.queue);
    const results = await Promise.all([a.tick(), b.tick()]);
    expect(results.reduce((n, r) => n + r.queued, 0)).toBe(1);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    await expect(discovery`select record_id from record_changes`).rejects.toMatchObject({
      code: '42501',
    });
  });
  it('quarantines unavailable change dispatch for its catalog and recovers without losing its cursor', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    await h.person('Pending unavailable dispatch');
    const [before] =
      await db.owner`select position::text from change_dispatch where installation_id=${id}`;
    const empty = new ExtensionQueue(h.app.sql, new ExtensionCatalog().runtime),
      discovery = db.connect({ role: 'retainer_executor' });
    expect(
      (await empty.discoverChanges(discovery, null)).some((row) => row.installation_id === id),
    ).toBe(true);
    expect(await empty.dispatchChanges(h.workspace.id, id)).toEqual({ queued: 0, blocked: 0 });
    expect(
      (await empty.discoverChanges(discovery, null)).some((row) => row.installation_id === id),
    ).toBe(false);
    expect(
      (await db.owner`select position::text from change_dispatch where installation_id=${id}`)[0],
    ).toEqual(before);
    expect(
      (await h.queue.discoverChanges(discovery, null)).some((row) => row.installation_id === id),
    ).toBe(true);
    expect((await h.queue.dispatchChanges(h.workspace.id, id)).queued).toBe(1);
  });
  it('preserves accepted change metadata through feed retention and still erases the owned copy', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const person = await h.person('Retained job');
    await h.queue.dispatchChanges(h.workspace.id, id);
    const active = await h.claim(id, person);
    await db.owner`update record_changes set created_at=clock_timestamp()-interval '31 days' where workspace_id=${h.workspace.id}`;
    const maintenance = new ChangeMaintenance(h.app.sql, db.connect({ role: 'retainer_executor' }));
    expect((await maintenance.tick()).failed).toBe(0);
    expect(
      await db.owner`select position from record_changes where workspace_id=${h.workspace.id}`,
    ).toHaveLength(0);
    const path = `/v1/changes/${active.pending.input.changePosition}`;
    expect((await h.app.request(path, { key: h.keys.admin })).status).toBe(410);
    const owned = await h.app.request(path, { key: active.key });
    expect(owned.status).toBe(200);
    expect(owned.body.recordId).toBe(person);
    expect(
      (await h.app.request(`/v1/records/${person}/forget`, { key: h.keys.admin, method: 'POST' }))
        .status,
    ).toBe(200);
    const [erased] =
      await db.owner`select change_snapshot,input,status from extension_jobs where id=${active.run.jobId}`;
    expect(erased).toEqual({ change_snapshot: null, input: {}, status: 'cancelled' });
    expect((await h.app.request(path, { key: active.key })).status).toBe(409);
  });
  it('marks expired dispatch history for a rescan and prunes only bounded terminal diagnostics', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    await h.person('Missed history');
    await db.owner`update record_changes set created_at=clock_timestamp()-interval '31 days' where workspace_id=${h.workspace.id}`;
    await expect(h.queue.dispatchChanges(h.workspace.id, id)).rejects.toMatchObject({
      code: 'cursor_expired',
    });
    const info = await h.app.request(`/v1/extensions/${id}`, { key: h.keys.admin });
    expect(info.body.lastError).toBe('cursor_expired');
    await db.owner`update extension_jobs set updated_at=clock_timestamp()-interval '31 days' where installation_id=${id} and status='succeeded'`;
    const maintenance = new ChangeMaintenance(h.app.sql, db.connect({ role: 'retainer_executor' }));
    const result = await maintenance.tick();
    expect(result.pruned).toBeGreaterThanOrEqual(2);
    expect(result.failed).toBe(0);
    expect(await db.owner`select id from extension_jobs where installation_id=${id}`).toHaveLength(
      0,
    );
  });
  it('expires abandoned jobs visibly without an executor and permits an explicit admin retry', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const person = await h.person('Expired delivery');
    await h.queue.dispatchChanges(h.workspace.id, id);
    const pending = await h.job(id, person);
    await db.owner`update extension_jobs set expires_at=clock_timestamp()-interval '1 second' where id=${pending.id}`;
    const maintenance = new ChangeMaintenance(h.app.sql, db.connect({ role: 'retainer_executor' }));
    expect((await maintenance.tick()).failed).toBe(0);
    const [expired] = await db.owner`select status,code from extension_jobs where id=${pending.id}`;
    expect(expired).toEqual({ status: 'failed', code: 'job_expired' });
    expect(
      (await h.app.request(`/v1/extensions/${id}`, { key: h.keys.admin })).body.connectionHealth,
    ).toBe('degraded');
    expect(
      (
        await h.app.request(`/v1/extensions/${id}/runs/${pending.id}/retry`, {
          key: h.keys.admin,
          method: 'POST',
          headers: { 'Idempotency-Key': 'retry-expired' },
        })
      ).status,
    ).toBe(200);
    expect(await h.queue.claim(h.workspace.id, pending.id, 'after-expiry-retry')).toBeTruthy();
  });
  it('refuses a dispatch whose change is pruned after its retention check, without advancing the cursor', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    await h.person('Pruned mid-dispatch');
    const [before] =
      await db.owner`select position::text from change_dispatch where installation_id=${id}`;
    let entered = () => {},
      release = () => {};
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      paused = new Promise<void>((r) => {
        release = r;
      });
    // Holds new job rows back, so the dispatcher pauses after its retention check.
    const blocker = db.owner.begin(async (tx) => {
      await tx`lock table extension_jobs in exclusive mode`;
      entered();
      await paused;
    });
    await started;
    const dispatch = h.queue.dispatchChanges(h.workspace.id, id);
    dispatch.catch(() => {});
    try {
      for (let i = 0; i < 100; i++) {
        const [waiting] = await db.owner`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'`;
        if ((waiting?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await db.owner`update record_changes set created_at=clock_timestamp()-interval '31 days' where workspace_id=${h.workspace.id}`;
      expect(
        await new ChangeMaintenance(h.app.sql, h.app.sql).pruneChanges(h.workspace.id),
      ).toBeGreaterThan(0);
    } finally {
      release();
      await blocker;
    }
    await expect(dispatch).rejects.toMatchObject({ code: 'cursor_expired' });
    const [after] =
      await db.owner`select position::text from change_dispatch where installation_id=${id}`;
    expect(after?.position).toBe(before?.position);
    expect(
      await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='change'`,
    ).toHaveLength(0);
  });
});
