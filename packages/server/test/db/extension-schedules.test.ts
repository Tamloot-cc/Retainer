import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase(),
  scheduleId = randomUUID(),
  jobId = randomUUID();
const manifest = extensionFixture({
  functions: [
    {
      universalId: scheduleId,
      name: 'poll',
      description: 'Poll fixture',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 120,
      trigger: { kind: 'schedule', cron: '* * * * *', timezone: 'UTC' },
      inputSchema: {
        type: 'object',
        properties: { scheduledAt: { type: 'string', maxLength: 100 } },
        required: ['scheduledAt'],
        additionalProperties: false,
      },
    },
    {
      universalId: jobId,
      name: 'page',
      description: 'Fixture page',
      handlerDigest: 'c'.repeat(64),
      timeoutSeconds: 120,
      trigger: { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
    },
  ],
});
const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
let t: TestApp;
beforeAll(() => {
  t = startTestApp(db, { extensionCatalog: catalog });
});
async function setup(limit = 10000) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Schedules ${randomUUID()}` },
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
  const queue = new ExtensionQueue(t.sql, catalog.runtime, {
    queued: limit,
    kvBytes: 1048576,
  });
  return { workspace: workspace.id, id, queue, key: keys.admin };
}
describe('transactional schedule ticks', () => {
  it('coalesces missed ticks once under competing schedulers and permits only trusted schedule enqueue', async () => {
    const { workspace, id, queue } = await setup();
    expect(await queue.scheduleTick(workspace, id)).toEqual({ scheduled: 0 });
    const past = new Date('2026-01-01T00:00:00Z');
    await db.owner`update extension_schedules set next_due_at=${past} where installation_id=${id}`;
    const results = await Promise.all([
      queue.scheduleTick(workspace, id),
      queue.scheduleTick(workspace, id),
    ]);
    expect(results.map((r) => r.scheduled).sort()).toEqual([0, 1]);
    const rows = await db.owner`select id,input from extension_jobs where installation_id=${id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.input).toEqual({ scheduledAt: past.toISOString() });
    const [schedule] =
      await db.owner`select next_due_at,last_occurrence from extension_schedules where installation_id=${id}`;
    expect(schedule?.last_occurrence).toEqual(past);
    expect(schedule?.next_due_at.getTime()).toBeGreaterThan(Date.now());
    expect(await queue.claim(workspace, rows[0]?.id, 'scheduler-worker')).not.toBeNull();
    await expect(
      queue.enqueue(workspace, id, {
        functionId: scheduleId,
        input: { scheduledAt: past.toISOString() },
        dedupeKey: 'forged-schedule',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it('isolates a missing pinned release so healthy workspace schedules and jobs still run in the same tick', async () => {
    const broken = await setup(),
      healthy = await setup();
    await broken.queue.scheduleTick(broken.workspace, broken.id);
    await healthy.queue.scheduleTick(healthy.workspace, healthy.id);
    const past = new Date('2026-01-01T00:00:00Z');
    await db.owner`update extension_schedules set next_due_at=${past} where installation_id in (${broken.id},${healthy.id})`;
    // The owner inventory can still discover an installation whose pinned release is absent locally.
    const unavailableDigest = 'f'.repeat(64);
    await db.owner`update extension_installations set release_digest=${unavailableDigest} where id=${broken.id}`;
    const queue = new ExtensionQueue(t.sql, catalog.runtime);
    const discovery = db.connect({ role: 'retainer_executor' });
    await queue.maintain(discovery);
    const [diagnostic] =
      await db.owner`select state,last_error,connection_health from extension_installations where id=${broken.id}`;
    expect(diagnostic).toEqual({
      state: 'active',
      last_error: null,
      connection_health: 'needs_reconnect',
    });
    expect(
      (
        await db.owner`select code,generation,runtime_identity from extension_runtime_unavailable where installation_id=${broken.id}`
      )[0],
    ).toMatchObject({ code: 'incompatible_runtime', runtime_identity: catalog.runtime.identity });
    const [pending] =
      await db.owner`select next_due_at from extension_schedules where installation_id=${broken.id}`;
    expect(pending?.next_due_at).toEqual(past);
    const due = await queue.discover(discovery);
    const job = due.find((row) => row.workspace_id === healthy.workspace);
    expect(job).toBeDefined();
    const run = await queue.claim(healthy.workspace, job?.job_id as string, 'healthy-worker');
    if (!run) throw new Error('healthy schedule was blocked');
    await queue.complete(run, { status: 'succeeded' });
  });
  it('keeps nextDue unchanged when queue quota prevents acceptance, and disabled installations accumulate nothing', async () => {
    const { workspace, id, queue, key } = await setup(1);
    await queue.scheduleTick(workspace, id);
    await queue.enqueue(workspace, id, { functionId: jobId, input: {}, dedupeKey: 'full' });
    const past = new Date('2026-01-01T00:00:00Z');
    await db.owner`update extension_schedules set next_due_at=${past} where installation_id=${id}`;
    await expect(queue.scheduleTick(workspace, id)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    const [schedule] =
      await db.owner`select next_due_at,last_occurrence from extension_schedules where installation_id=${id}`;
    expect(schedule?.next_due_at).toEqual(past);
    expect(schedule?.last_occurrence).toBeNull();
    await t.request(`/v1/extensions/${id}/disable`, { key, method: 'POST' });
    expect(await queue.scheduleTick(workspace, id)).toEqual({ scheduled: 0 });
  });
});
