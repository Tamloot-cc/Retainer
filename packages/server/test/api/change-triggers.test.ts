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
async function setup(count = 1, standalone = 0) {
  const initial = startTestApp(db),
    { workspace, keys } = await initial.setupWorkspace(
      { name: `Triggers ${randomUUID()}` },
      {
        admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
        sync: { actor: { type: 'integration', id: 'sync' }, scopes: ['read', 'write'] },
      },
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
  const apps = Array.from({ length: standalone }, () =>
    extensionFixture({ execution: 'standalone', scopes: ['read', 'write'] }),
  );
  const catalog = new ExtensionCatalog([
    ...manifests.map((manifest) => ({
      manifest,
      actorCeiling: 'integration' as const,
      runtimeEnabled: true,
    })),
    ...apps.map((manifest) => ({ manifest, actorCeiling: 'integration' as const })),
  ]);
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
  const standaloneKeys: { id: string; key: string }[] = [];
  for (const manifest of apps) {
    const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
    const plan = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
    const installed = await app.request('/v1/extensions', {
      key: keys.admin,
      body: { ...input, planDigest: plan.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(installed.status).toBe(201);
    const issued = await app.request(`/v1/extensions/${installed.body.id}/keys`, {
      key: keys.admin,
      body: { expectedGeneration: installed.body.generation, scopes: ['read', 'write'] },
    });
    expect(issued.status).toBe(201);
    standaloneKeys.push({ id: installed.body.id, key: issued.body.key });
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
  async function edit(key: string, record: string, jobTitle: string, headers = {}) {
    const result = await app.request(`/v1/records/${record}`, {
      key,
      method: 'PATCH',
      body: { values: { jobTitle } },
      headers,
    });
    expect(result.status).toBe(200);
  }
  async function changeJobs(installation: string) {
    return db.owner<
      {
        id: string;
        status: string;
        input: { changePosition: string };
        cause: string[];
        dedupe_key: string;
        change_snapshot: { position: string; record_id: string; operation: string } | null;
      }[]
    >`select id,status,input,cause,dedupe_key,change_snapshot from extension_jobs
      where installation_id=${installation} and trigger_kind='change' order by created_at,id`;
  }
  async function latest(record: string) {
    const [row] = await db.owner<
      { position: string; cause: string[] }[]
    >`select position::text,cause from record_changes where record_id=${record} order by record_changes.position desc limit 1`;
    if (!row) throw new Error('change missing');
    return row;
  }
  async function cursor(installation: string) {
    const [row] = await db.owner<
      { position: string }[]
    >`select position::text from change_dispatch where installation_id=${installation}`;
    return row?.position;
  }
  async function health(installation: string) {
    const info = await app.request(`/v1/extensions/${installation}`, { key: keys.admin });
    return { connectionHealth: info.body.connectionHealth, lastError: info.body.lastError };
  }
  return {
    app,
    workspace,
    keys,
    manifests,
    ids,
    field,
    queue,
    resolve,
    person,
    job,
    claim,
    edit,
    changeJobs,
    latest,
    cursor,
    health,
    standaloneKeys,
  };
}
describe('transactional change dispatch with real Postgres', () => {
  it('deduplicates competing dispatchers and keeps the jobs it accepted before the quota', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const one = await h.person('One');
    await h.person('Two');
    const limited = new ExtensionQueue(h.app.sql, h.resolve, { queued: 1, kvBytes: 1048576 });
    expect(await limited.dispatchChanges(h.workspace.id, id)).toEqual({
      queued: 1,
      blocked: 0,
      deferred: 'quota_exceeded',
    });
    expect(await h.health(id)).toEqual({
      connectionHealth: 'degraded',
      lastError: 'quota_exceeded',
    });
    expect(await h.changeJobs(id)).toHaveLength(1);
    expect(await h.cursor(id)).toBe((await h.latest(one)).position);
    const results = await Promise.all([
      h.queue.dispatchChanges(h.workspace.id, id),
      h.queue.dispatchChanges(h.workspace.id, id),
    ]);
    expect(results.reduce((n, r) => n + r.queued, 0)).toBe(1);
    const jobs = await h.changeJobs(id);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => Object.keys(j.input).join(',') === 'changePosition')).toBe(true);
    expect(await h.health(id)).toEqual({ connectionHealth: 'ok', lastError: null });
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
describe('change trigger coalescing and throttling (R9)', () => {
  it('coalesces 50 edits to one record into one queued job carrying the latest change', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const person = await h.person('Busy person');
    await h.queue.dispatchChanges(h.workspace.id, id);
    for (let i = 0; i < 25; i++) await h.edit(h.keys.admin, person, `Title ${i}`);
    expect(await h.queue.dispatchChanges(h.workspace.id, id)).toEqual({
      queued: 1,
      blocked: 0,
      coalesced: 24,
    });
    expect(await h.cursor(id)).toBe((await h.latest(person)).position);
    for (let i = 25; i < 50; i++) await h.edit(h.keys.admin, person, `Title ${i}`);
    expect(await h.queue.dispatchChanges(h.workspace.id, id)).toEqual({
      queued: 0,
      blocked: 0,
      coalesced: 25,
    });
    const jobs = await h.changeJobs(id),
      last = await h.latest(person);
    // The creation keeps its own job; the 50 updates share one.
    expect(jobs).toHaveLength(2);
    const update = jobs[1];
    expect(update?.input).toEqual({ changePosition: last.position });
    expect(update?.dedupe_key).toBe(
      `change:${last.position}:${h.manifests[0]?.functions[0]?.universalId}`,
    );
    expect(update?.change_snapshot).toMatchObject({
      position: last.position,
      record_id: person,
      operation: 'update',
    });
    expect(await h.cursor(id)).toBe(last.position);
    // The feed pages in numeric order, not text order (1, 10, 11, …, 2).
    const page = await h.app.request('/v1/changes?limit=12', { key: h.keys.admin });
    const positions = page.body.changes.map(
      (change: { cursor: string }) =>
        JSON.parse(Buffer.from(change.cursor, 'base64url').toString()).p as string,
    );
    expect(positions).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));
    // The handler reads the coalesced change through its run credential.
    const run = await h.claim(id, person);
    expect(run.run.jobId).toBe(update?.id);
    const read = await h.app.request(`/v1/changes/${last.position}`, { key: run.key });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ recordId: person, operation: 'update' });
  });
  it('queues a second job when the record changes while its job is running', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const person = await h.person('Running person');
    await h.queue.dispatchChanges(h.workspace.id, id);
    const creation = await h.claim(id, person);
    await h.queue.complete(creation.run, { status: 'succeeded' });
    await h.edit(h.keys.admin, person, 'First');
    await h.queue.dispatchChanges(h.workspace.id, id);
    const running = await h.claim(id, person);
    const read = await h.app.request(`/v1/changes/${running.pending.input.changePosition}`, {
      key: running.key,
    });
    expect(read.status).toBe(200);
    await h.edit(h.keys.admin, person, 'Second');
    expect(await h.queue.dispatchChanges(h.workspace.id, id)).toEqual({ queued: 1, blocked: 0 });
    const jobs = await h.changeJobs(id);
    expect(jobs.map((j) => j.status)).toEqual(['succeeded', 'running', 'queued']);
    expect(jobs[1]?.input).toEqual(running.pending.input);
    expect(jobs[2]?.input).toEqual({ changePosition: (await h.latest(person)).position });
  });
  it('never loses a change when a claim races the coalescing dispatch', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const person = await h.person('Raced person');
    await h.queue.dispatchChanges(h.workspace.id, id);
    const creation = await h.claim(id, person);
    await h.queue.complete(creation.run, { status: 'succeeded' });
    for (let round = 0; round < 5; round++) {
      await h.edit(h.keys.admin, person, `Round ${round}`);
      await h.queue.dispatchChanges(h.workspace.id, id);
      const pending = await h.job(id, person);
      await h.edit(h.keys.admin, person, `Round ${round} again`);
      const [claimed] = await Promise.all([
        h.queue.claim(h.workspace.id, pending.id, 'racer'),
        h.queue.dispatchChanges(h.workspace.id, id),
      ]);
      if (!claimed) throw new Error('claim lost');
      const last = (await h.latest(person)).position,
        claimedPosition = (claimed.input as { changePosition: string }).changePosition;
      const queued = (await h.changeJobs(id)).filter((j) => j.status === 'queued');
      if (claimedPosition === last) expect(queued).toHaveLength(0);
      else expect(queued.map((j) => j.input.changePosition)).toEqual([last]);
      await h.queue.complete(claimed, { status: 'succeeded' });
      for (const job of queued) {
        const run = await h.queue.claim(h.workspace.id, job.id, 'drain');
        if (run) await h.queue.complete(run, { status: 'succeeded' });
      }
    }
  });
  it('keeps an absorbed cause so A to B to A stays blocked', async () => {
    const h = await setup(2),
      [a, b] = h.ids;
    if (!a || !b) throw new Error('installations missing');
    const person = await h.person('Coalesced cause');
    await h.queue.dispatchChanges(h.workspace.id, a);
    await h.queue.dispatchChanges(h.workspace.id, b);
    // An integration's edit, so the extensions' later claims are not held for review.
    await h.edit(h.keys.sync, person, 'Sync edit');
    await h.queue.dispatchChanges(h.workspace.id, a);
    await h.queue.dispatchChanges(h.workspace.id, b);
    const first = await h.claim(a, person);
    await h.edit(first.key, person, 'From A');
    await h.queue.complete(first.run, { status: 'succeeded' });
    expect((await h.queue.dispatchChanges(h.workspace.id, b)).coalesced).toBe(1);
    const second = await h.claim(b, person);
    expect(second.pending.cause).toEqual([a]);
    await h.edit(second.key, person, 'From B');
    await h.queue.complete(second.run, { status: 'succeeded' });
    expect((await h.latest(person)).cause).toEqual([a, b]);
    // A's own write and B's reaction to it are both blocked for A.
    expect(await h.queue.dispatchChanges(h.workspace.id, a)).toEqual({ queued: 0, blocked: 2 });
    expect((await h.health(a)).lastError).toBe('trigger_cycle_blocked');
  });
  it('defers one installation at its quota without blocking another or losing changes', async () => {
    const h = await setup(2),
      [a, b] = h.ids;
    if (!a || !b) throw new Error('installations missing');
    const people = [];
    for (let i = 0; i < 3; i++) people.push(await h.person(`Quota ${i}`));
    const limited = new ExtensionQueue(h.app.sql, h.resolve, { queued: 2, kvBytes: 1048576 });
    const discovery = db.connect({ role: 'retainer_executor' }),
      maintenance = new ChangeMaintenance(h.app.sql, discovery, limited);
    const tick = await maintenance.tick();
    expect(tick.failed).toBe(0);
    expect((await h.changeJobs(a)).length + (await h.changeJobs(b)).length).toBe(4);
    for (const id of [a, b]) {
      expect(await h.cursor(id)).toBe((await h.latest(people[1] ?? '')).position);
      expect((await h.health(id)).lastError).toBe('quota_exceeded');
    }
    // Draining a's queue lets its cursor resume; b stays deferred on its own.
    for (const job of await h.changeJobs(a)) {
      const run = await h.queue.claim(h.workspace.id, job.id, 'drain');
      if (run) await h.queue.complete(run, { status: 'succeeded' });
    }
    expect(await limited.dispatchChanges(h.workspace.id, a)).toEqual({ queued: 1, blocked: 0 });
    expect(await h.cursor(a)).toBe((await h.latest(people[2] ?? '')).position);
    expect(await h.health(a)).toEqual({ connectionHealth: 'ok', lastError: null });
    expect((await h.health(b)).lastError).toBe('quota_exceeded');
    expect(await h.queue.dispatchChanges(h.workspace.id, b)).toEqual({ queued: 1, blocked: 0 });
  });
  it('defers enqueues past the per-minute throttle and records trigger_throttled', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const one = await h.person('Throttle one'),
      two = await h.person('Throttle two');
    const throttled = new ExtensionQueue(h.app.sql, h.resolve, {
      queued: 10000,
      kvBytes: 1048576,
      changesPerMinute: 1,
    });
    expect(await throttled.dispatchChanges(h.workspace.id, id)).toEqual({
      queued: 1,
      blocked: 0,
      deferred: 'trigger_throttled',
    });
    expect(await h.cursor(id)).toBe((await h.latest(one)).position);
    expect(await h.health(id)).toEqual({
      connectionHealth: 'degraded',
      lastError: 'trigger_throttled',
    });
    expect((await throttled.dispatchChanges(h.workspace.id, id)).deferred).toBe(
      'trigger_throttled',
    );
    await db.owner`update extension_jobs set created_at=clock_timestamp()-interval '2 minutes' where installation_id=${id}`;
    expect(await throttled.dispatchChanges(h.workspace.id, id)).toEqual({ queued: 1, blocked: 0 });
    expect(await h.cursor(id)).toBe((await h.latest(two)).position);
    expect(await h.health(id)).toEqual({ connectionHealth: 'ok', lastError: null });
  });
  it('lets a standalone app carry the cause of the change it reacts to', async () => {
    const h = await setup(1, 1),
      hosted = h.ids[0],
      app = h.standaloneKeys[0];
    if (!hosted || !app) throw new Error('installations missing');
    const person = await h.person('Standalone loop');
    await h.queue.dispatchChanges(h.workspace.id, hosted);
    const creation = await h.claim(hosted, person);
    await h.queue.complete(creation.run, { status: 'succeeded' });
    // The standalone app writes; the hosted function reacts.
    await h.edit(app.key, person, 'From app');
    expect((await h.latest(person)).cause).toEqual([app.id]);
    expect((await h.queue.dispatchChanges(h.workspace.id, hosted)).queued).toBe(1);
    const reaction = await h.claim(hosted, person);
    await h.edit(reaction.key, person, 'From hosted');
    await h.queue.complete(reaction.run, { status: 'succeeded' });
    const hostedChange = await h.latest(person);
    expect(hostedChange.cause).toEqual([app.id, hosted]);
    // The app reads that change from the feed and answers it, naming it as the cause.
    const feed = await h.app.request('/v1/changes', { key: app.key });
    const item = feed.body.changes.at(-1);
    expect(item.cause).toEqual([app.id, hosted]);
    await h.edit(app.key, person, 'App again', { 'Retainer-Caused-By': item.cursor });
    expect((await h.latest(person)).cause).toEqual([app.id, hosted]);
    // Blocked: the hosted function's own write, and the app's answer to it.
    expect(await h.queue.dispatchChanges(h.workspace.id, hosted)).toEqual({
      queued: 0,
      blocked: 2,
    });
    // Only installation credentials may declare a cause.
    const spoof = await h.app.request(`/v1/records/${person}`, {
      key: h.keys.admin,
      method: 'PATCH',
      body: { values: { jobTitle: 'Spoof' } },
      headers: { 'Retainer-Caused-By': item.cursor },
    });
    expect(spoof.status).toBe(400);
  });
  async function feedRows(
    h: Awaited<ReturnType<typeof setup>>,
    record: string,
    rows: { operation: string; cause?: string[] }[],
  ) {
    const [type] = await db.owner<
      { object_type_id: string }[]
    >`select object_type_id from records where id=${record}`;
    if (!type) throw new Error('record missing');
    const [counter] = await db.owner<{ position: string }[]>`update change_counters
      set position=position+${rows.length} where workspace_id=${h.workspace.id} returning position::text`;
    const end = BigInt(counter?.position ?? '0');
    for (const [i, row] of rows.entries())
      await db.owner`insert into record_changes(workspace_id,position,record_id,object_type_id,operation,field_keys,cause)
        values(${h.workspace.id},${(end - BigInt(rows.length - 1 - i)).toString()}::bigint,${record},${type.object_type_id},
          ${row.operation},${db.owner.json(row.operation === 'update' ? [h.field.key] : [])},${db.owner.json(row.cause ?? [])})`;
  }
  it('never folds a change into a job queued before a later lifecycle job', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const person = await h.person('Ordered person');
    await h.queue.dispatchChanges(h.workspace.id, id);
    const creation = await h.claim(id, person);
    await h.queue.complete(creation.run, { status: 'succeeded' });
    await h.edit(h.keys.admin, person, 'Before delete'); // P2 -> J1
    // P3 delete, P4 undelete (which the collector also labels delete).
    await feedRows(h, person, [{ operation: 'delete' }, { operation: 'delete' }]);
    await h.edit(h.keys.admin, person, 'After undelete'); // P5
    expect(await h.queue.dispatchChanges(h.workspace.id, id)).toEqual({ queued: 4, blocked: 0 });
    const queued = (await h.changeJobs(id)).filter((j) => j.status === 'queued');
    expect(queued.map((j) => [j.input.changePosition, j.change_snapshot?.operation])).toEqual([
      ['2', 'update'],
      ['3', 'delete'],
      ['4', 'delete'],
      ['5', 'update'],
    ]);
    // The next update folds into the newest job, which runs last.
    await h.edit(h.keys.admin, person, 'Later');
    expect((await h.queue.dispatchChanges(h.workspace.id, id)).coalesced).toBe(1);
    expect(
      (await h.changeJobs(id))
        .filter((j) => j.status === 'queued')
        .map((j) => j.input.changePosition),
    ).toEqual(['2', '3', '4', '6']);
  });
  it('keeps the deeper depth when chains merge, so coalescing never manufactures a depth block', async () => {
    const h = await setup(2),
      [a, b] = h.ids;
    if (!a || !b) throw new Error('installations missing');
    const person = await h.person('Deep person');
    await h.queue.dispatchChanges(h.workspace.id, a);
    await h.queue.dispatchChanges(h.workspace.id, b);
    const chain = () => Array.from({ length: 5 }, () => randomUUID());
    await feedRows(h, person, [
      { operation: 'update', cause: chain() },
      { operation: 'update', cause: chain() },
    ]);
    expect((await h.queue.dispatchChanges(h.workspace.id, a)).coalesced).toBe(1);
    await h.queue.dispatchChanges(h.workspace.id, b);
    const [merged] = await db.owner<
      { cause: string[]; cause_depth: number }[]
    >`select cause,cause_depth from extension_jobs where installation_id=${a} and trigger_kind='change' and status='queued'
      order by (input->>'changePosition')::bigint desc limit 1`;
    expect(merged?.cause).toHaveLength(10);
    expect(merged?.cause_depth).toBe(5);
    const run = await h.claim(a, person);
    await h.edit(run.key, person, 'From deep A');
    await h.queue.complete(run.run, { status: 'succeeded' });
    const [change] = await db.owner<
      { cause: string[]; cause_depth: number }[]
    >`select cause,cause_depth from record_changes where record_id=${person} order by record_changes.position desc limit 1`;
    expect(change?.cause).toHaveLength(11);
    expect(change?.cause_depth).toBe(6);
    expect(await h.queue.dispatchChanges(h.workspace.id, b)).toEqual({
      queued: 0,
      blocked: 0,
      coalesced: 1,
    });
  });
  it('orders dispatch and the feed by number across the 9 to 10 boundary', async () => {
    const h = await setup(),
      id = h.ids[0];
    if (!id) throw new Error('installation missing');
    const person = await h.person('Boundary person'); // P1
    for (let i = 0; i < 11; i++) await h.edit(h.keys.admin, person, `Edit ${i}`); // P2..P12
    expect(await h.queue.dispatchChanges(h.workspace.id, id, 10)).toEqual({
      queued: 2,
      blocked: 0,
      coalesced: 8,
    });
    expect(await h.cursor(id)).toBe('10');
    expect((await h.changeJobs(id)).map((j) => j.input.changePosition)).toEqual(['1', '10']);
    await h.queue.dispatchChanges(h.workspace.id, id, 10);
    expect(await h.cursor(id)).toBe('12');
    const decode = (cursor: string) =>
      JSON.parse(Buffer.from(cursor, 'base64url').toString()).p as string;
    const page = await h.app.request('/v1/changes?limit=10', { key: h.keys.admin });
    expect(page.body.changes.map((c: { cursor: string }) => decode(c.cursor))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
    expect(decode(page.body.nextCursor)).toBe('10');
    const rest = await h.app.request(`/v1/changes?limit=10&after=${page.body.nextCursor}`, {
      key: h.keys.admin,
    });
    expect(rest.body.changes.map((c: { cursor: string }) => decode(c.cursor))).toEqual([
      '11',
      '12',
    ]);
  });
  it('checks Retainer-Caused-By: read scope, an existing change, and no inherited depth', async () => {
    const h = await setup(0, 1),
      app = h.standaloneKeys[0];
    if (!app) throw new Error('installation missing');
    const person = await h.person('Header checks');
    const cursor = (p: string) =>
      Buffer.from(JSON.stringify({ v: 1, w: h.workspace.id, p })).toString('base64url');
    const write = (key: string, header: string) =>
      h.app.request(`/v1/records/${person}`, {
        key,
        method: 'PATCH',
        body: { values: { jobTitle: `Caused by ${header}` } },
        headers: { 'Retainer-Caused-By': header },
      });
    expect((await write(app.key, cursor('999999'))).status).toBe(410);
    const writeOnly = await h.app.request(`/v1/extensions/${app.id}/keys`, {
      key: h.keys.admin,
      body: {
        expectedGeneration: (await h.app.request(`/v1/extensions/${app.id}`, { key: h.keys.admin }))
          .body.generation,
        scopes: ['write'],
      },
    });
    expect(writeOnly.status).toBe(201);
    expect((await write(writeOnly.body.key, cursor('1'))).status).toBe(403);
    // A long inherited chain excludes installations but adds no depth.
    const long = Array.from({ length: 9 }, () => randomUUID());
    await feedRows(h, person, [{ operation: 'update', cause: long }]);
    const [last] = await db.owner<
      { position: string }[]
    >`select position::text from record_changes where record_id=${person} order by record_changes.position desc limit 1`;
    expect((await write(app.key, cursor(last?.position ?? ''))).status).toBe(200);
    const [change] = await db.owner<
      { cause: string[]; cause_depth: number }[]
    >`select cause,cause_depth from record_changes where record_id=${person} order by record_changes.position desc limit 1`;
    expect(change?.cause).toEqual([...long, app.id]);
    expect(change?.cause_depth).toBe(1);
  });
});
