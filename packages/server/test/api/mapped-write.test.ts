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

const db = useTestDatabase();
const DOMAIN = 'bf87f1cd-b6f4-4c93-9ac7-df7a1b6bf641';
const manifest = extensionFixture({
  requestedActor: 'agent',
  scopes: ['read', 'write'],
  mapping: {
    objectId: BASE_OBJECT_IDS.company,
    lookup: { fieldId: DOMAIN, type: 'links' },
    outputs: [
      {
        key: 'employee_count',
        label: 'Employee count',
        description: 'Employees the provider finds',
        types: ['number'],
        field: {
          universalId: randomUUID(),
          name: 'employeeCount',
          label: 'Employee Count',
          type: 'number',
        },
      },
      {
        key: 'linkedin_url',
        label: 'LinkedIn URL',
        description: 'Company LinkedIn profile',
        types: ['links'],
        field: {
          universalId: randomUUID(),
          name: 'linkedinUrl',
          label: 'LinkedIn URL',
          type: 'links',
        },
      },
      {
        key: 'headquarters',
        label: 'Headquarters',
        description: 'Headquarters city and country',
        types: ['address'],
      },
    ],
  },
  functions: [
    {
      universalId: randomUUID(),
      name: 'enrich',
      description: 'Enrich a company',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 60,
      trigger: {
        kind: 'change',
        objectId: BASE_OBJECT_IDS.company,
        fieldIds: [DOMAIN],
        related: false,
        operations: ['create', 'update'],
      },
      inputSchema: {
        type: 'object',
        properties: { changePosition: { type: 'string', maxLength: 19 } },
        required: ['changePosition'],
        additionalProperties: false,
      },
      mappedWrite: true,
    },
  ],
});
const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'agent', runtimeEnabled: true }]);
let tokens: RunTokens;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'mapped',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});
const workspaceIds: string[] = [];
afterEach(async () => {
  if (workspaceIds.length)
    await db.owner`delete from workspaces where id=any(${workspaceIds.splice(0)}::uuid[])`;
});

async function setup() {
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Mapped ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'other-agent' }, scopes: ['read', 'write'] },
    },
  );
  workspaceIds.push(workspace.id);
  const queue = new ExtensionQueue(app.sql, catalog.runtime);
  const mapping = {
    employee_count: { action: 'create' },
    linkedin_url: { action: 'create' },
    headquarters: { action: 'existing', field: 'address' },
  };
  const body = { registrationId: manifest.universalId, version: '1.0.0', settings: {}, mapping };
  const plan = await app.request('/v1/extensions/preview', { key: keys.admin, body });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...body, planDigest: plan.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string;
  const [setupJob] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
  const setupRun = await queue.claim(workspace.id, setupJob?.id, 'setup');
  if (!setupRun) throw new Error('setup missing');
  await queue.complete(setupRun, { status: 'succeeded' });

  async function company(values: Record<string, unknown>) {
    const res = await app.request('/v1/objects/company/records', {
      key: keys.admin,
      body: { values },
    });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }
  /** Claims the newest queued change job for a record and returns its run token. */
  async function run(record: string) {
    await queue.dispatchChanges(workspace.id, id);
    const [job] = await db.owner<{ id: string }[]>`
      select id from extension_jobs where installation_id=${id} and trigger_kind='change'
        and status='queued' and change_snapshot->>'record_id'=${record}
      order by created_at desc limit 1`;
    if (!job) throw new Error('change job missing');
    const claimed = await queue.claim(workspace.id, job.id, 'worker');
    if (!claimed) throw new Error('claim failed');
    return {
      claimed,
      token: await tokens.issue(app.sql, claimed, manifest.universalId, claimed.scopes),
    };
  }
  const write = (token: string, input: Record<string, unknown>) =>
    app.request(`/v1/extensions/${id}/runtime/mapped-writes`, { key: token, body: input });
  const patch = (key: string, record: string, values: Record<string, unknown>) =>
    app.request(`/v1/records/${record}`, { key, method: 'PATCH', body: { values } });
  const read = async (record: string) =>
    (await app.request(`/v1/records/${record}`, { key: keys.admin })).body;
  const assertions = async (record: string) =>
    (
      await db.owner<
        { count: number }[]
      >`select count(*)::int as count from field_assertions where record_id=${record}`
    )[0]?.count ?? 0;
  return { app, workspace, keys, queue, id, company, run, write, patch, read, assertions };
}

const values = {
  employee_count: 52,
  linkedin_url: { primary: { url: 'https://www.linkedin.com/company/acme' }, additional: [] },
  headquarters: { city: 'Tel Aviv', country: 'Israel' },
};

describe('fill-only mapped writes', () => {
  it('fills unset targets as the agent actor, and a replay adds nothing', async () => {
    const h = await setup();
    const acme = await h.company({ name: 'Acme', domain: 'https://www.acme.com/' });
    const { token } = await h.run(acme);
    const res = await h.write(token, { recordId: acme, lookup: 'acme.com', values });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'applied',
      fields: { employee_count: 'applied', linkedin_url: 'applied', headquarters: 'applied' },
    });
    const record = await h.read(acme);
    expect(record.fields.employeeCount).toBe(52);
    expect(record.fields.address).toMatchObject({ city: 'Tel Aviv', country: 'Israel' });
    const [assertion] = await db.owner<
      { actor: { type: string; id: string }; confidence: number }[]
    >`select a.actor, a.confidence from field_assertions a join fields f on f.id=a.field_id
      where a.record_id=${acme} and f.name='employeeCount'`;
    expect(assertion).toEqual({ actor: { type: 'agent', id: h.id }, confidence: 1 });
    const count = await h.assertions(acme);
    const replay = await h.write(token, { recordId: acme, lookup: 'acme.com', values });
    expect(replay.body).toEqual({
      outcome: 'skipped',
      reason: 'nothing_to_fill',
      fields: { employee_count: 'populated', linkedin_url: 'populated', headquarters: 'populated' },
    });
    expect(await h.assertions(acme)).toBe(count);
    // The mapped fields are not watched and the write carries this installation's cause.
    expect((await h.queue.dispatchChanges(h.workspace.id, h.id)).queued).toBe(0);
  });

  it('skips populated values, explicit clears, and zero as a value', async () => {
    const h = await setup();
    const acme = await h.company({ name: 'Acme', domain: 'acme.com' });
    expect(
      (await h.patch(h.keys.admin, acme, { employeeCount: 0, linkedinUrl: null })).status,
    ).toBe(200);
    const { token } = await h.run(acme);
    const res = await h.write(token, { recordId: acme, lookup: 'acme.com', values });
    expect(res.body).toEqual({
      outcome: 'applied',
      fields: { employee_count: 'populated', linkedin_url: 'cleared', headquarters: 'applied' },
    });
    const record = await h.read(acme);
    expect(record.fields.employeeCount).toBe(0);
    expect(record.fields.linkedinUrl ?? null).toBeNull();
  });

  it('reports each skip reason for its own run', async () => {
    const h = await setup();
    for (const [change, reason] of [
      ['domain', 'lookup_changed'],
      ['delete', 'record_deleted'],
      ['merge', 'record_merged'],
    ] as const) {
      const record = await h.company({ name: `Co ${change}`, domain: `${change}.example.com` });
      const { token, claimed } = await h.run(record);
      if (change === 'domain')
        expect((await h.patch(h.keys.admin, record, { domain: 'other.example.com' })).status).toBe(
          200,
        );
      if (change === 'delete')
        await h.app.request(`/v1/records/${record}`, { key: h.keys.admin, method: 'DELETE' });
      if (change === 'merge') {
        const survivor = await h.company({ name: 'Survivor' });
        await h.app.request(`/v1/records/${survivor}/merge`, {
          key: h.keys.admin,
          body: { recordId: record },
          headers: { 'Idempotency-Key': randomUUID() },
        });
      }
      const res = await h.write(token, {
        recordId: record,
        lookup: `${change}.example.com`,
        values,
      });
      expect(res.body).toEqual({ outcome: 'skipped', reason, fields: {} });
      await h.queue.complete(claimed, { status: 'succeeded' });
    }
  });

  it('refuses unmapped outputs, null and invalid values, and non-run credentials', async () => {
    const h = await setup();
    const acme = await h.company({ name: 'Acme', domain: 'acme.com' });
    const { token } = await h.run(acme);
    const unknown = await h.write(token, { recordId: acme, values: { revenue: 1 } });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('mapping_invalid');
    expect(
      (await h.write(token, { recordId: acme, values: { employee_count: null } })).status,
    ).toBe(422);
    expect(
      (await h.write(token, { recordId: acme, values: { employee_count: 'many' } })).status,
    ).toBe(422);
    const admin = await h.app.request(`/v1/extensions/${h.id}/runtime/mapped-writes`, {
      key: h.keys.admin,
      body: { recordId: acme, values },
    });
    expect(admin.status).toBe(403);
    expect((await h.read(acme)).fields.employeeCount ?? null).toBeNull();
  });

  it('fails a write to a deleted target and marks the installation degraded', async () => {
    const h = await setup();
    const acme = await h.company({ name: 'Acme', domain: 'acme.com' });
    const { token } = await h.run(acme);
    expect(
      (
        await h.app.request('/v1/schema/changes', {
          key: h.keys.admin,
          body: { operations: [{ op: 'delete_field', object: 'company', field: 'address' }] },
        })
      ).status,
    ).toBe(200);
    const res = await h.write(token, { recordId: acme, lookup: 'acme.com', values });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'schema_binding_conflict',
      details: { outputs: [{ output: 'headquarters', field: 'address', reason: 'missing' }] },
    });
    expect((await h.read(acme)).fields.employeeCount ?? null).toBeNull();
    const detail = await h.app.request(`/v1/extensions/${h.id}`, { key: h.keys.admin });
    expect(detail.body).toMatchObject({
      connectionHealth: 'degraded',
      lastError: 'schema_binding_conflict',
    });
  });

  it('never overwrites a value another writer sets concurrently', async () => {
    const h = await setup();
    for (let i = 0; i < 8; i++) {
      const record = await h.company({ name: `Race ${i}`, domain: `race${i}.example.com` });
      const { token, claimed } = await h.run(record);
      const [mapped, competing] = await Promise.all([
        h.write(token, {
          recordId: record,
          lookup: `race${i}.example.com`,
          values: { employee_count: 52 },
        }),
        h.patch(h.keys.agent, record, { employeeCount: 40 }),
      ]);
      expect(mapped.status).toBe(200);
      expect(competing.status).toBe(200);
      // Whichever committed first, the other agent's value is the one that stays.
      expect((await h.read(record)).fields.employeeCount).toBe(40);
      await h.queue.complete(claimed, { status: 'succeeded' });
    }
  });

  it('never writes data looked up for a domain the record no longer has', async () => {
    const h = await setup();
    for (let i = 0; i < 8; i++) {
      const record = await h.company({ name: `Move ${i}`, domain: `old${i}.example.com` });
      const { token, claimed } = await h.run(record);
      const [mapped] = await Promise.all([
        h.write(token, {
          recordId: record,
          lookup: `old${i}.example.com`,
          values: { employee_count: 52 },
        }),
        h.patch(h.keys.admin, record, { domain: `new${i}.example.com` }),
      ]);
      const filled = (await h.read(record)).fields.employeeCount === 52;
      // Applied only if it committed before the domain changed; otherwise skipped.
      expect(mapped.body.outcome === 'applied').toBe(filled);
      if (!filled) expect(mapped.body.reason).toBe('lookup_changed');
      await h.queue.complete(claimed, { status: 'succeeded' });
    }
  });
});
