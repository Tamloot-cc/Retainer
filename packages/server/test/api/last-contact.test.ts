import { randomUUID } from 'node:crypto';
import { BASE_OBJECT_IDS } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase(),
  workspaces: string[] = [];
let tokens: RunTokens;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'last-contact',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});
afterEach(async () => {
  if (workspaces.length)
    await db.owner`delete from workspaces where id=any(${workspaces.splice(0)}::uuid[])`;
});
async function setup() {
  const setupId = randomUUID(),
    computeId = randomUUID(),
    otherId = randomUUID();
  const fields = [BASE_OBJECT_IDS.person, BASE_OBJECT_IDS.company].map((objectId) => ({
    objectId,
    fieldId: randomUUID(),
  }));
  const manifest = extensionFixture({
    scopes: ['read', 'write'],
    schema: fields.map(({ objectId, fieldId }) => ({
      kind: 'field',
      objectId,
      definition: {
        universalId: fieldId,
        name: 'lastContactAt',
        label: 'Last contact',
        type: 'date_time',
        isNullable: true,
      },
    })),
    lastContact: { functionIds: [computeId], fields },
    functions: [setupId, computeId, otherId].map((id, index) => ({
      universalId: id,
      name: `function-${index}`,
      description: 'Last-contact fixture',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 120,
      trigger: index === 0 ? { kind: 'install' } : { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
    })),
  });
  const catalog = new ExtensionCatalog([
      { manifest, actorCeiling: 'integration', runtimeEnabled: true },
    ]),
    release = catalog.get(manifest.universalId, manifest.version);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set([release.digest]),
    runTokens: tokens,
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Last contact ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  workspaces.push(workspace.id);
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const plan = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: plan.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string,
    path = `/v1/extensions/${id}/runtime/last-contact`,
    queue = new ExtensionQueue(app.sql, catalog.runtime);
  const [pending] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
  const installRun = await queue.claim(workspace.id, pending?.id, 'setup');
  if (!installRun) throw new Error('setup missing');
  const setupToken = await tokens.issue(app.sql, installRun, manifest.universalId, [
    'read',
    'write',
  ]);
  expect((await app.request(path, { key: setupToken, body: { kind: 'scan' } })).status).toBe(409);
  await queue.complete(installRun, { status: 'succeeded' });
  const job = await queue.enqueue(workspace.id, id, {
    functionId: computeId,
    input: {},
    dedupeKey: randomUUID(),
  });
  const run = await queue.claim(workspace.id, job.id, 'derive');
  if (!run) throw new Error('compute missing');
  const token = await tokens.issue(app.sql, run, manifest.universalId, ['read', 'write']);
  const call = (body: unknown, key = token) => app.request(path, { key, body });
  const create = async (object: string, values: Record<string, unknown>) => {
    const created = await app.request(`/v1/objects/${object}/records`, {
      key: keys.admin,
      body: { values },
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  };
  const event = async (at: string, about: string[]) => {
    const logged = await app.request('/v1/events', {
      key: keys.admin,
      body: {
        type: 'conversation',
        occurredAt: at,
        title: 'A conversation',
        channel: 'last-contact-test',
        externalId: randomUUID(),
        about,
      },
    });
    expect(logged.status).toBe(201);
    return logged.body.id as string;
  };
  const value = async (recordId: string) =>
    (await app.request(`/v1/records/${recordId}`, { key: keys.admin })).body.fields.lastContactAt;
  const rollup = () =>
    app.request('/v1/schema/changes', {
      key: keys.admin,
      body: {
        operations: [
          { op: 'update_field', object: 'person', field: 'company', rollUpEvents: true },
        ],
      },
    });
  return {
    app,
    workspace: workspace.id,
    keys,
    id,
    manifest,
    fields,
    queue,
    run,
    token,
    call,
    create,
    event,
    value,
    rollup,
    otherId,
  };
}
const old = '2026-01-01T12:00:00.000Z',
  recent = '2026-01-02T12:00:00.000Z';
describe('release-pinned last contact', () => {
  it('serializes competing recomputations, cites the latest current conversation and makes repeat scans quiet', async () => {
    const h = await setup(),
      person = await h.create('person', { name: 'Dana' });
    await h.event(old, [person]);
    const newest = await h.event(recent, [person]);
    await h.event(new Date(Date.now() + 300000).toISOString(), [person]);
    const responses = await Promise.all([
      h.call({ kind: 'records', recordIds: [person] }),
      h.call({ kind: 'records', recordIds: [person] }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses.reduce((n, r) => n + r.body.changed, 0)).toBe(1);
    expect(await h.value(person)).toBe(recent);
    const claims =
      await db.owner`select source_record_id,observed_at,actor,status from field_assertions where record_id=${person} and actor->>'id'=${h.id}`;
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      source_record_id: newest,
      observed_at: new Date(recent),
      actor: { type: 'integration', id: h.id },
      status: 'active',
    });
    const [before] =
      await db.owner`select position::text from change_counters where workspace_id=${h.workspace}`;
    expect((await h.call({ kind: 'scan' })).body.changed).toBe(0);
    const [after] =
      await db.owner`select position::text from change_counters where workspace_id=${h.workspace}`;
    expect(after?.position).toBe(before?.position);
  });
  it('can decrease on unlink and clear after retraction without inventing a newer source timestamp', async () => {
    const h = await setup(),
      person = await h.create('person', { name: 'Dana' });
    const first = await h.event(old, [person]),
      second = await h.event(recent, [person]);
    expect((await h.call({ kind: 'records', recordIds: [person] })).status).toBe(200);
    expect(
      (
        await h.app.request(`/v1/events/${second}/about/${person}`, {
          key: h.keys.admin,
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect((await h.call({ kind: 'records', recordIds: [person] })).body.changed).toBe(1);
    expect(await h.value(person)).toBe(old);
    const [claim] =
      await db.owner`select observed_at,source_record_id from field_assertions where record_id=${person} and actor->>'id'=${h.id} and status='active'`;
    expect(claim).toEqual({ observed_at: new Date(old), source_record_id: first });
    expect(
      (await h.app.request(`/v1/events/${first}`, { key: h.keys.admin, method: 'DELETE' })).status,
    ).toBe(200);
    expect((await h.call({ kind: 'records', recordIds: [person] })).status).toBe(200);
    expect(await h.value(person)).toBeUndefined();
  });
  it('preserves human overrides while replacing only its own supported assertions', async () => {
    const h = await setup(),
      person = await h.create('person', {
        name: 'Dana',
        lastContactAt: '2025-01-01T00:00:00.000Z',
      });
    await h.event(old, [person]);
    expect((await h.call({ kind: 'records', recordIds: [person] })).status).toBe(200);
    expect(await h.value(person)).toBe('2025-01-01T00:00:00.000Z');
    await h.event(recent, [person]);
    expect((await h.call({ kind: 'records', recordIds: [person] })).status).toBe(200);
    expect(await h.value(person)).toBe('2025-01-01T00:00:00.000Z');
    const [claim] =
      await db.owner`select status from field_assertions where record_id=${person} and actor->>'type'='user' and field_id in(select id from fields where universal_id=any(${h.fields.map((entry) => entry.fieldId)}::uuid[]))`;
    expect(claim?.status).toBe('active');
  });
  it('includes one-hop rollups and hard-erases dependent claims when their supporting person is forgotten even if the event survives', async () => {
    const h = await setup();
    expect((await h.rollup()).status).toBe(200);
    const company = await h.create('company', { name: 'Acme' }),
      person = await h.create('person', { name: 'Dana', company });
    await h.event(old, [company]);
    const survives = await h.event(recent, [person]);
    expect((await h.call({ kind: 'records', recordIds: [person] })).body.processed).toBe(2);
    expect(await h.value(company)).toBe(recent);
    const deps =
      await db.owner`select d.support_record_id from assertion_dependencies d join field_assertions a on a.id=d.assertion_id where a.record_id=${company} order by d.support_record_id`;
    expect(deps.map((row) => row.support_record_id).sort()).toEqual([person, survives].sort());
    expect(
      (await h.app.request(`/v1/records/${person}/forget`, { key: h.keys.admin, body: {} })).status,
    ).toBe(200);
    expect((await h.app.request(`/v1/events/${survives}`, { key: h.keys.admin })).status).toBe(200);
    expect(await h.value(company)).toBeUndefined();
    expect(
      await db.owner`select id from field_assertions where record_id=${company} and actor->>'id'=${h.id}`,
    ).toHaveLength(0);
    expect((await h.call({ kind: 'records', recordIds: [company] })).status).toBe(409); // The process that held erased content was fenced.
    const next = await h.queue.claim(h.workspace, h.run.jobId, 'after-forget');
    if (!next) throw new Error('restarted compute missing');
    const token = await tokens.issue(h.app.sql, next, h.manifest.universalId, ['read', 'write']);
    expect((await h.call({ kind: 'records', recordIds: [company] }, token)).status).toBe(200);
    expect(await h.value(company)).toBe(old);
  });
  it('bounds scan pages with a fixed upper ID and rejects value, actor, foreign-field and unpinned-function overrides', async () => {
    const h = await setup();
    expect((await h.call({ kind: 'scan' }, h.keys.admin)).status).toBe(403);
    expect((await h.call({ kind: 'scan', actor: { type: 'user', id: 'admin' } })).status).toBe(400);
    for (let i = 0; i < 21; i++) await h.create('company', { name: `Company ${i}` });
    const page = await h.call({ kind: 'scan' });
    expect(page.status).toBe(200);
    expect(page.body.processed).toBe(20);
    expect(page.body.nextAfter).toBeTruthy();
    await h.create('company', { name: 'After fixed bound' });
    const end = await h.call({
      kind: 'scan',
      after: page.body.nextAfter,
      through: page.body.through,
    });
    expect(end.body.processed).toBe(1);
    expect(end.body.nextAfter).toBeNull();
    await h.queue.complete(h.run, { status: 'succeeded' });
    const job = await h.queue.enqueue(h.workspace, h.id, {
      functionId: h.otherId,
      input: {},
      dedupeKey: randomUUID(),
    });
    const run = await h.queue.claim(h.workspace, job.id, 'unrelated');
    if (!run) throw new Error('missing job');
    const token = await tokens.issue(h.app.sql, run, h.manifest.universalId, ['read', 'write']);
    expect((await h.call({ kind: 'scan' }, token)).status).toBe(403);
  });
  it('does not commit a derived write after disable wins its competing transaction', async () => {
    const h = await setup(),
      person = await h.create('person', { name: 'Dana' });
    await h.event(recent, [person]);
    const [derived, disabled] = await Promise.all([
      h.call({ kind: 'records', recordIds: [person] }),
      h.app.request(`/v1/extensions/${h.id}/disable`, { key: h.keys.admin, body: {} }),
    ]);
    expect(disabled.status).toBe(200);
    expect([200, 409]).toContain(derived.status);
    const claims =
      await db.owner`select id from field_assertions where record_id=${person} and actor->>'id'=${h.id}`;
    expect((await h.call({ kind: 'records', recordIds: [person] })).status).toBe(409);
    expect(
      await db.owner`select id from field_assertions where record_id=${person} and actor->>'id'=${h.id}`,
    ).toEqual(claims);
  });
});
