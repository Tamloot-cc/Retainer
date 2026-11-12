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
const SALES_EMPLOYEES = '0dc97bea-8bbe-4bd8-9713-0c6628049268';
const LINKEDIN = randomUUID();
const changeInput = {
  type: 'object' as const,
  properties: { changePosition: { type: 'string' as const, maxLength: 19 } },
  required: ['changePosition'],
  additionalProperties: false as const,
};
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
          universalId: SALES_EMPLOYEES,
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
        field: { universalId: LINKEDIN, name: 'linkedinUrl', label: 'LinkedIn URL', type: 'links' },
      },
      {
        key: 'headquarters',
        label: 'Headquarters',
        description: 'Headquarters city and country',
        types: ['address'],
      },
      {
        key: 'employee_band',
        label: 'Employee band',
        description: 'Lower bound of the company-reported size band',
        types: ['number'],
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
      inputSchema: changeInput,
      mappedWrite: true,
    },
  ],
});
const plain = extensionFixture({ name: 'plain' });
const outputs = manifest.mapping?.outputs ?? [];
const release = (version: string, next: typeof outputs) =>
  extensionFixture({
    ...manifest,
    version,
    mapping: { ...(manifest.mapping as NonNullable<typeof manifest.mapping>), outputs: next },
  });
// 1.1.0 drops headquarters and adds revenue; 1.2.0 stops accepting a number for the count.
const added = release('1.1.0', [
  ...outputs.filter((o) => o.key !== 'headquarters'),
  { key: 'revenue', label: 'Revenue', description: 'Annual revenue', types: ['money'] },
]);
const retyped = release(
  '1.2.0',
  outputs.map((o) =>
    o.key === 'employee_count' ? { ...o, types: ['text'], field: undefined } : o,
  ),
);
const catalog = new ExtensionCatalog([
  { manifest, actorCeiling: 'agent', runtimeEnabled: true },
  { manifest: added, actorCeiling: 'agent', runtimeEnabled: true },
  { manifest: retyped, actorCeiling: 'agent', runtimeEnabled: true },
  { manifest: plain, actorCeiling: 'integration' },
]);
let tokens: RunTokens;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'mapping',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});
const workspaceIds: string[] = [];
afterEach(async () => {
  if (workspaceIds.length)
    await db.owner`delete from workspaces where id=any(${workspaceIds.splice(0)}::uuid[])`;
});

type Choices = Record<string, { action: string; field?: string }>;
async function setup(template?: string) {
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Mapping ${randomUUID()}`, ...(template ? { template } : {}) },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['admin'] },
    },
  );
  workspaceIds.push(workspace.id);
  const queue = new ExtensionQueue(app.sql, catalog.runtime);
  const base = { registrationId: manifest.universalId, version: '1.0.0', settings: {} };
  const preview = (mapping?: Choices, key = keys.admin, extra: Record<string, unknown> = {}) =>
    app.request('/v1/extensions/preview', {
      key,
      body: { ...base, ...(mapping ? { mapping } : {}), ...extra },
    });
  const commit = (
    path: string,
    mapping: Choices,
    planDigest: string,
    key = keys.admin,
    extra: Record<string, unknown> = {},
  ) =>
    app.request(path, {
      key,
      body: { ...base, mapping, planDigest, ...extra },
      headers: { 'Idempotency-Key': randomUUID() },
    });
  async function install(mapping: Choices) {
    const plan = await preview(mapping);
    expect(plan.status).toBe(200);
    const installed = await commit('/v1/extensions', mapping, plan.body.planDigest);
    expect(installed.status).toBe(201);
    const [job] =
      await db.owner`select id from extension_jobs where installation_id=${installed.body.id} and trigger_kind='install'`;
    const run = await queue.claim(workspace.id, job?.id, 'setup');
    if (!run) throw new Error('setup missing');
    await queue.complete(run, { status: 'succeeded' });
    return installed.body.id as string;
  }
  const schema = (operations: unknown[]) =>
    app.request('/v1/schema/changes', { key: keys.admin, body: { operations } });
  const detail = async (id: string) =>
    (await app.request(`/v1/extensions/${id}`, { key: keys.admin })).body;
  return { app, workspace, keys, queue, preview, commit, install, schema, detail };
}
const full: Choices = {
  employee_count: { action: 'create' },
  linkedin_url: { action: 'create' },
  headquarters: { action: 'existing', field: 'address' },
  employee_band: { action: 'skip' },
};

describe('reviewed output mappings', () => {
  it('previews the resolved bindings and field additions, and lets only a human approve', async () => {
    const h = await setup();
    const plan = await h.preview(full, h.keys.agent);
    expect(plan.status).toBe(200);
    expect(plan.body.mapping[3]).toEqual({
      output: 'employee_band',
      action: 'skip',
      contribution: false,
      status: 'ok',
    });
    expect(plan.body.mapping.slice(0, 3)).toEqual([
      {
        output: 'employee_count',
        action: 'create',
        field: { name: 'employeeCount', label: 'Employee Count', type: 'number' },
        contribution: true,
        status: 'ok',
      },
      {
        output: 'linkedin_url',
        action: 'create',
        field: { name: 'linkedinUrl', label: 'LinkedIn URL', type: 'links' },
        contribution: true,
        status: 'ok',
      },
      {
        output: 'headquarters',
        action: 'existing',
        field: { name: 'address', label: 'Address', type: 'address' },
        contribution: false,
        status: 'ok',
      },
    ]);
    expect(plan.body.operations).toHaveLength(2);
    expect(plan.body.grants).toEqual({ actor: 'agent', scopes: ['read', 'write'] });
    expect(plan.body.warnings).toContain(
      'The mapping applies to records created or changed from now on. Existing records are not filled in.',
    );
    expect(
      (await h.commit('/v1/extensions', full, plan.body.planDigest, h.keys.agent)).status,
    ).toBe(403);
  });

  it('reports every invalid choice together', async () => {
    const h = await setup();
    await h.schema([
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'notes', label: 'Notes', type: 'text' },
      },
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'headcount', label: 'Headcount', type: 'number' },
      },
    ]);
    const reasons = async (mapping: Choices | undefined) => {
      const res = await h.preview(mapping);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('mapping_invalid');
      return Object.fromEntries(
        (res.body.error.details.outputs as { output: string; reason: string }[]).map((i) => [
          i.output,
          i.reason,
        ]),
      );
    };
    expect(await reasons(undefined)).toEqual({ '*': 'missing_mapping' });
    expect(
      await reasons({
        employee_count: { action: 'existing', field: 'notes' },
        linkedin_url: { action: 'existing', field: 'domain' },
        headquarters: { action: 'create' },
        employee_band: { action: 'skip' },
        extra: { action: 'skip' },
      }),
    ).toEqual({
      employee_count: 'incompatible_type',
      linkedin_url: 'lookup_field',
      headquarters: 'no_suggested_field',
      extra: 'unknown_output',
    });
    expect(
      await reasons({
        employee_count: { action: 'existing', field: 'headcount' },
        linkedin_url: { action: 'create' },
        employee_band: { action: 'skip' },
      }),
    ).toEqual({ employee_count: 'field_not_found', headquarters: 'missing_output' });
    expect(
      await reasons({
        employee_count: { action: 'skip' },
        linkedin_url: { action: 'skip' },
        headquarters: { action: 'skip' },
        employee_band: { action: 'skip' },
      }),
    ).toEqual({ '*': 'nothing_mapped' });
  });

  it('refuses a duplicate destination and a field that exists only in another workspace', async () => {
    const h = await setup();
    const other = await setup();
    await other.schema([
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'elsewhere', label: 'Elsewhere', type: 'links' },
      },
    ]);
    await h.schema([
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'profile', label: 'Profile', type: 'links' },
      },
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'size', label: 'Size', type: 'number' },
      },
    ]);
    const elsewhere = await h.preview({
      ...full,
      linkedin_url: { action: 'existing', field: 'elsewhere' },
    });
    expect(elsewhere.body.error.details.outputs).toEqual([
      { output: 'linkedin_url', reason: 'field_not_found' },
    ]);
    const twice = await h.preview({
      ...full,
      employee_count: { action: 'existing', field: 'size' },
      employee_band: { action: 'existing', field: 'size' },
    });
    expect(twice.body.error.details.outputs).toEqual([
      { output: 'employee_band', reason: 'duplicate_destination' },
    ]);
    const ok = await h.preview({
      ...full,
      employee_count: { action: 'existing', field: 'size' },
      linkedin_url: { action: 'existing', field: 'profile' },
    });
    expect(ok.status).toBe(200);
  });

  it('installs schema, mapping, contributions and setup atomically, and rejects stale plans', async () => {
    const h = await setup();
    const plan = await h.preview(full);
    // A schema change after preview makes the plan stale and commits nothing.
    await h.schema([
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'later', label: 'Later', type: 'text' },
      },
    ]);
    const stale = await h.commit('/v1/extensions', full, plan.body.planDigest);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_plan');
    expect(
      await db.owner`select 1 from fields where workspace_id=${h.workspace.id} and name='linkedinUrl'`,
    ).toHaveLength(0);
    expect(
      await db.owner`select 1 from extension_installations where workspace_id=${h.workspace.id}`,
    ).toHaveLength(0);
    // A different mapping than the reviewed one is stale too.
    const fresh = await h.preview(full);
    const changed = await h.commit(
      '/v1/extensions',
      { ...full, headquarters: { action: 'skip' } },
      fresh.body.planDigest,
    );
    expect(changed.body.error.code).toBe('stale_plan');
    const id = await h.install(full);
    const detail = await h.detail(id);
    expect(detail.state).toBe('active');
    expect(detail.mapping.revision).toBe(0);
    expect(detail.mapping.outputs.slice(0, 3)).toEqual([
      {
        output: 'employee_count',
        action: 'existing',
        field: { name: 'employeeCount', label: 'Employee Count', type: 'number' },
        contribution: true,
        status: 'ok',
      },
      {
        output: 'linkedin_url',
        action: 'existing',
        field: { name: 'linkedinUrl', label: 'LinkedIn URL', type: 'links' },
        contribution: true,
        status: 'ok',
      },
      {
        output: 'headquarters',
        action: 'existing',
        field: { name: 'address', label: 'Address', type: 'address' },
        contribution: false,
        status: 'ok',
      },
    ]);
    expect(
      detail.contributions
        .filter((c: { kind: string }) => c.kind === 'field')
        .map((c: { universalId: string }) => c.universalId)
        .sort(),
    ).toEqual([SALES_EMPLOYEES, LINKEDIN].sort());
    const [stored] = await db.owner<
      { mapping: unknown }[]
    >`select mapping from extension_installations where id=${id}`;
    expect(JSON.stringify(stored?.mapping)).not.toContain('employeeCount');
  });

  it('binds the existing field when the suggested one already exists', async () => {
    const h = await setup('sales');
    const plan = await h.preview(full);
    expect(plan.status).toBe(200);
    expect(plan.body.mapping[0]).toEqual({
      output: 'employee_count',
      action: 'create',
      field: { name: 'employeeCount', label: 'Employees', type: 'number' },
      contribution: false,
      status: 'ok',
    });
    expect(plan.body.operations).toHaveLength(1);
    expect(plan.body.warnings).toContain(
      'Output Employee count uses the existing field Employees instead of creating one.',
    );
  });

  it('keeps bindings through a rename and reports a deleted target by output', async () => {
    const h = await setup();
    const id = await h.install(full);
    expect(
      (
        await h.schema([
          { op: 'rename_field', object: 'company', field: 'address', name: 'office' },
        ])
      ).status,
    ).toBe(200);
    expect((await h.detail(id)).mapping.outputs[2]).toMatchObject({
      field: { name: 'office' },
      status: 'ok',
    });
    expect(
      (await h.schema([{ op: 'delete_field', object: 'company', field: 'office' }])).status,
    ).toBe(200);
    expect((await h.detail(id)).mapping.outputs[2]).toMatchObject({
      output: 'headquarters',
      field: { label: 'Address' },
      status: 'missing',
    });
    // A field the installation created cannot be deleted while it is installed.
    const blocked = await h.schema([
      { op: 'delete_field', object: 'company', field: 'linkedinUrl' },
    ]);
    expect(blocked.status).toBe(422);
  });

  it('commits a mapping change: new generation, same state, queued and running work moves over', async () => {
    const h = await setup();
    const id = await h.install(full);
    const before = await h.detail(id);
    const company = await h.app.request('/v1/objects/company/records', {
      key: h.keys.admin,
      body: { values: { name: 'Acme', domain: 'acme.com' } },
    });
    expect(company.status).toBe(201);
    await h.queue.dispatchChanges(h.workspace.id, id);
    const [queued] = await db.owner<
      { id: string }[]
    >`select id from extension_jobs where installation_id=${id} and trigger_kind='change' and status='queued'`;
    if (!queued) throw new Error('change job missing');
    const running = await h.queue.claim(h.workspace.id, queued.id, 'worker');
    if (!running) throw new Error('claim failed');
    const remap: Choices = { ...full, headquarters: { action: 'skip' } };
    const plan = await h.preview(remap, h.keys.admin, { installationId: id, mappingChange: true });
    expect(plan.status).toBe(200);
    expect(plan.body.operations).toEqual([]);
    // Only the mapping route commits a mapping change.
    expect(
      (await h.commit(`/v1/extensions/${id}/mapping`, remap, plan.body.planDigest)).status,
    ).toBe(400);
    const committed = await h.commit(
      `/v1/extensions/${id}/mapping`,
      remap,
      plan.body.planDigest,
      h.keys.admin,
      {
        installationId: id,
        mappingChange: true,
      },
    );
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({
      state: 'active',
      generation: before.generation + 1,
      grantGeneration: before.grantGeneration,
    });
    const after = await h.detail(id);
    expect(after.mapping.revision).toBe(1);
    expect(after.mapping.outputs[2]).toEqual({
      output: 'headquarters',
      action: 'skip',
      contribution: false,
      status: 'ok',
    });
    const [job] = await db.owner<
      { status: string; generation: number }[]
    >`select status,generation from extension_jobs where id=${queued.id}`;
    expect(job).toEqual({ status: 'queued', generation: after.generation });
    const [attempt] = await db.owner<
      { status: string; code: string }[]
    >`select status,code from extension_attempts where job_id=${queued.id} order by started_at desc limit 1`;
    expect(attempt).toEqual({ status: 'cancelled', code: 'mapping_changed' });
    const [dispatch] = await db.owner<
      { generation: number }[]
    >`select generation from change_dispatch where installation_id=${id}`;
    expect(dispatch?.generation).toBe(after.generation);
    // The old run token is fenced; the job runs again at the new generation.
    const again = await h.queue.claim(h.workspace.id, queued.id, 'worker');
    expect(again?.generation).toBe(after.generation);
    // A mapping change keeps settings and credentials; it refuses other changes.
    const settings = await h.preview(remap, h.keys.admin, {
      installationId: id,
      mappingChange: true,
      settings: { unknown: true },
    });
    expect(settings.status).toBeGreaterThanOrEqual(400);
  });

  it('carries the mapping over an upgrade and refuses a target the release no longer accepts', async () => {
    const h = await setup();
    const id = await h.install(full);
    const upgrade = (version: string) =>
      h.app.request('/v1/extensions/preview', {
        key: h.keys.admin,
        body: { registrationId: manifest.universalId, version, settings: {}, installationId: id },
      });
    const plan = await upgrade('1.1.0');
    expect(plan.status).toBe(200);
    expect(
      plan.body.mapping.map((b: { output: string; action: string }) => [b.output, b.action]),
    ).toEqual([
      ['employee_count', 'existing'],
      ['linkedin_url', 'existing'],
      ['employee_band', 'skip'],
      ['revenue', 'skip'],
    ]);
    expect(plan.body.warnings).toContain(
      'Output headquarters is no longer provided; its field mapping is removed.',
    );
    const conflict = await upgrade('1.2.0');
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'upgrade_conflict',
      details: { output: 'employee_count', field: 'employeeCount' },
    });
  });

  it('refuses a mapping for a release without one', async () => {
    const h = await setup();
    const res = await h.app.request('/v1/extensions/preview', {
      key: h.keys.admin,
      body: {
        registrationId: plain.universalId,
        version: '1.0.0',
        settings: {},
        mapping: { anything: { action: 'skip' } },
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('mapping_invalid');
    const ok = await h.app.request('/v1/extensions/preview', {
      key: h.keys.admin,
      body: { registrationId: plain.universalId, version: '1.0.0', settings: {} },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.mapping).toBeUndefined();
  });
});
