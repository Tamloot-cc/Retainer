import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'reader' | 'admin' | 'adminAgent', string>;

beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Acme Clinic' },
    {
      agent: {
        actor: { type: 'agent', id: 'front-desk' },
        scopes: ['read', 'write', 'schema:write'],
      },
      reader: { actor: { type: 'agent', id: 'reader' }, scopes: ['read'] },
      admin: { actor: { type: 'user', id: 'dana' }, scopes: ['admin'] },
      adminAgent: { actor: { type: 'agent', id: 'boss-bot' }, scopes: ['admin'] },
    },
  ));
});

describe('GET /v1/schema', () => {
  it('requires a key', async () => {
    expect((await t.request('/v1/schema')).status).toBe(401);
  });

  it('describes the workspace and its objects by API name', async () => {
    const res = await t.request('/v1/schema', { key: keys.reader });
    expect(res.status).toBe(200);
    expect(res.body.workspace).toEqual({
      id: expect.any(String),
      name: 'Acme Clinic',
      slug: 'acme-clinic',
      templates: [],
      initialized: false,
      schemaVersion: 1,
    });
    const objects = res.body.objects as { nameSingular: string; class: string }[];
    expect(objects.filter((o) => o.class === 'entity').map((o) => o.nameSingular)).toEqual([
      'company',
      'person',
      'task',
    ]);
    // The base event types; the internal-note type stays hidden (6.4).
    expect(
      objects
        .filter((o) => o.class === 'event')
        .map((o) => o.nameSingular)
        .sort(),
    ).toEqual(['conversation']);
    const meeting = res.body.objects.find(
      (o: { nameSingular: string }) => o.nameSingular === 'conversation',
    );
    expect(meeting).toMatchObject({
      labelField: 'title',
      eventColumns: expect.arrayContaining(['occurredAt', 'channel', 'externalId']),
    });
    expect(
      meeting.fields.map((f: { name: string; coreRole?: string }) => [f.name, f.coreRole]),
    ).toEqual(
      expect.arrayContaining([
        ['title', 'title'],
        ['summary', 'summary'],
        ['medium', undefined],
      ]),
    );
    // Medium is an ordinary select a person or agent can correct, documented against channel.
    // Clients find the base event types and medium after a rename, as for base objects.
    expect(meeting.baseObject).toBe('conversation');
    expect(meeting.fields.find((f: { name: string }) => f.name === 'medium')).toMatchObject({
      baseField: 'conversationMedium',
      type: 'select',
      isFilterable: true,
      isProtected: false,
      description: expect.stringContaining('channel'),
    });
    expect(res.body.builtIns.map((b: { name: string }) => b.name)).toEqual([
      'fact',
      'comment',
      'memory',
    ]);
    const person = objects.find((o) => o.nameSingular === 'person') as never as {
      labelField: string;
      fields: { name: string }[];
    };
    expect(person.labelField).toBe('name');
    expect(person.fields.find((f: { name: string }) => f.name === 'company')).toMatchObject({
      type: 'relation',
      settings: {
        targetObject: 'company',
        inverseField: 'people',
        relationCardinality: 'many_to_one',
        onDelete: 'set_null',
      },
      readOnly: false,
    });
    const company = objects.find((o) => o.nameSingular === 'company') as never as {
      fields: { name: string }[];
    };
    expect(company.fields.find((f: { name: string }) => f.name === 'people')).toMatchObject({
      readOnly: true,
      settings: {
        targetObject: 'person',
        inverseField: 'company',
        relationCardinality: 'one_to_many',
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('universalId');
  });
});

describe('POST /v1/schema/changes', () => {
  it('needs the schema:write scope', async () => {
    const res = await t.request('/v1/schema/changes', {
      key: keys.reader,
      body: { operations: [{ op: 'delete_field', object: 'person', field: 'jobTitle' }] },
    });
    expect(res.status).toBe(403);
  });

  it('validates the request shape', async () => {
    const res = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: { operations: [{ op: 'explode', object: 'person' }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');

    const badJson = await t.app.request('/v1/schema/changes', {
      method: 'POST',
      headers: { authorization: `Bearer ${keys.agent}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
  });

  it('applies additive changes from an agent with 200', async () => {
    const res = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'person',
            field: {
              name: 'allergies',
              label: 'Allergies',
              type: 'multi_select',
              settings: { options: [{ value: 'penicillin', label: 'Penicillin' }] },
            },
          },
        ],
        reason: 'Front desk asks about allergies',
      },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'applied',
      schemaVersion: 2,
      change: {
        status: 'applied',
        isDestructive: false,
        reason: 'Front desk asks about allergies',
        requestedBy: { type: 'agent', id: 'front-desk' },
        operations: [expect.objectContaining({ kind: 'create_field' })],
      },
    });
  });

  it('returns 422 with every issue for an invalid change', async () => {
    const res = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'person',
            field: { name: 'createdAt', label: 'x', type: 'text' },
          },
          { op: 'update_field', object: 'person', field: 'jobTitle', type: 'number' },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'schema_invalid' });
    expect(res.body.error.details.issues).toHaveLength(2);
  });

  it('ignores universal IDs from callers', async () => {
    const pinned = '7e87d873-8c93-4786-9a0b-95447310c8d3'; // person's universal ID
    const res = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'person',
            field: { universalId: pinned, name: 'nickname', label: 'Nickname', type: 'text' },
          },
        ],
      },
    });
    expect(res.status).toBe(200);
  });

  it('proposes destructive changes with 202, even from an agent with admin', async () => {
    const res = await t.request('/v1/schema/changes', {
      key: keys.adminAgent,
      body: {
        operations: [{ op: 'rename_field', object: 'person', field: 'nickname', name: 'alias' }],
      },
    });
    expect(res.status).toBe(202);
    expect(res.body.change.status).toBe('proposed');

    const listed = await t.request('/v1/schema/changes?status=proposed', { key: keys.reader });
    expect(listed.body.changes.map((c: { id: string }) => c.id)).toContain(res.body.change.id);

    const fetched = await t.request(`/v1/schema/changes/${res.body.change.id}`, {
      key: keys.reader,
    });
    expect(fetched.body).toMatchObject({ id: res.body.change.id, status: 'proposed' });
  });

  it('shows what approving a proposal would do now, by name', async () => {
    const proposed = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          { op: 'update_field', object: 'company', field: 'name', label: 'Legal name' },
          { op: 'update_field', object: 'company', field: 'name', isUnique: true },
        ],
      },
    });
    expect(proposed.status).toBe(202);
    const id = proposed.body.change.id as string;
    const label = (body: { operations: { property?: string }[] }) =>
      body.operations.find((op) => op.property === 'label');
    expect(label(proposed.body.change)).toMatchObject({ from: 'Name', to: 'Legal name' });

    // The schema moves on before anyone decides; approval re-plans against it.
    const relabel = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [{ op: 'update_field', object: 'company', field: 'name', label: 'Title' }],
      },
    });
    expect(relabel.body.status).toBe('applied');

    const fetched = await t.request(`/v1/schema/changes/${id}`, { key: keys.reader });
    expect(label(fetched.body)).toMatchObject({ from: 'Title', to: 'Legal name' });
    const listed = await t.request('/v1/schema/changes?status=proposed', { key: keys.reader });
    const inList = listed.body.changes.find((c: { id: string }) => c.id === id);
    expect(label(inList)).toMatchObject({ from: 'Title', to: 'Legal name' });
    // Universal IDs stay inside the engine.
    expect(JSON.stringify(listed.body)).not.toMatch(/labelFieldId|targetObjectId|inverseFieldId/);
  });

  it('shows no operations for a proposal the schema already matches', async () => {
    const made = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'person',
            field: { name: 'badge', label: 'Badge', type: 'text' },
          },
        ],
      },
    });
    expect(made.body.status).toBe('applied');
    const proposed = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [{ op: 'update_field', object: 'person', field: 'badge', isUnique: true }],
      },
    });
    expect(proposed.status).toBe(202);
    const applied = await t.request('/v1/schema/changes', {
      key: keys.admin,
      body: {
        operations: [{ op: 'update_field', object: 'person', field: 'badge', isUnique: true }],
      },
    });
    expect(applied.body.status).toBe('applied');
    const fetched = await t.request(`/v1/schema/changes/${proposed.body.change.id}`, {
      key: keys.reader,
    });
    expect(fetched.body).toMatchObject({ status: 'proposed', operations: [] });
  });

  it('stops calling a proposal destructive once another change made that part', async () => {
    await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'person',
            field: { name: 'pin', label: 'Pin', type: 'text' },
          },
        ],
      },
    });
    const proposed = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          { op: 'update_field', object: 'person', field: 'pin', label: 'PIN' },
          { op: 'update_field', object: 'person', field: 'pin', isUnique: true },
        ],
      },
    });
    expect(proposed.body.change.isDestructive).toBe(true);
    await t.request('/v1/schema/changes', {
      key: keys.admin,
      body: {
        operations: [{ op: 'update_field', object: 'person', field: 'pin', isUnique: true }],
      },
    });
    const fetched = await t.request(`/v1/schema/changes/${proposed.body.change.id}`, {
      key: keys.reader,
    });
    expect(fetched.body).toMatchObject({
      isDestructive: false,
      operations: [expect.objectContaining({ property: 'label', to: 'PIN' })],
    });
  });

  it('applies destructive changes from a user admin directly', async () => {
    const res = await t.request('/v1/schema/changes', {
      key: keys.admin,
      body: { operations: [{ op: 'delete_field', object: 'person', field: 'allergies' }] },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('applied');
  });
});

describe('approve and reject', () => {
  async function propose(name: string) {
    const res = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'task',
            field: { name, label: name, type: 'text', isUnique: true },
          },
        ],
      },
    });
    expect(res.status).toBe(202);
    return res.body.change.id as string;
  }

  it('requires the admin scope and a user actor', async () => {
    const id = await propose('code');
    expect(
      (await t.request(`/v1/schema/changes/${id}/approve`, { method: 'POST', key: keys.agent }))
        .status,
    ).toBe(403);
    expect(
      (
        await t.request(`/v1/schema/changes/${id}/approve`, {
          method: 'POST',
          key: keys.adminAgent,
        })
      ).status,
    ).toBe(403);
  });

  it('approves a proposal', async () => {
    const id = await propose('externalRef');
    const res = await t.request(`/v1/schema/changes/${id}/approve`, {
      method: 'POST',
      key: keys.admin,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'applied',
      change: { decidedBy: { type: 'user', id: 'dana' } },
    });
    const again = await t.request(`/v1/schema/changes/${id}/approve`, {
      method: 'POST',
      key: keys.admin,
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_decided');
  });

  it('rejects a proposal', async () => {
    const id = await propose('sku');
    const res = await t.request(`/v1/schema/changes/${id}/reject`, {
      method: 'POST',
      key: keys.admin,
    });
    expect(res.body.status).toBe('rejected');
  });

  it('answers 404 for unknown or malformed change IDs', async () => {
    const unknown = await t.request(
      '/v1/schema/changes/00000000-0000-4000-8000-000000000000/approve',
      {
        method: 'POST',
        key: keys.admin,
      },
    );
    expect(unknown.status).toBe(404);
    expect((await t.request('/v1/schema/changes/nope', { key: keys.admin })).status).toBe(404);
  });
});

describe('templates', () => {
  it('lists every template with what it adds', async () => {
    const res = await t.request('/v1/templates', { key: keys.reader });
    expect(res.status).toBe(200);
    expect(res.body.templates.map((x: { name: string }) => x.name)).toEqual([
      'sales',
      'services',
      'clinic',
      'real_estate',
      'recruiting',
      'blank',
    ]);
    const clinic = res.body.templates.find((x: { name: string }) => x.name === 'clinic');
    expect(clinic).toMatchObject({
      version: 1,
      applied: false,
      adds: {
        objects: [
          { name: 'appointment', fields: ['title', 'startsAt', 'type', 'status', 'person'] },
        ],
        fields: [
          { object: 'person', field: 'dateOfBirth' },
          { object: 'person', field: 'preferredChannel' },
        ],
      },
    });
  });

  it('applies a template with schema:write and reports it as initialized', async () => {
    expect(
      (await t.request('/v1/templates/clinic/apply', { method: 'POST', key: keys.reader })).status,
    ).toBe(403);
    const res = await t.request('/v1/templates/clinic/apply', { method: 'POST', key: keys.agent });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'applied', alreadyApplied: false });

    const again = await t.request('/v1/templates/clinic/apply', {
      method: 'POST',
      key: keys.agent,
    });
    expect(again.body).toMatchObject({ status: 'unchanged', alreadyApplied: true });

    const schema = await t.request('/v1/schema', { key: keys.reader });
    expect(schema.body.workspace.initialized).toBe(true);
    expect(schema.body.workspace.templates).toEqual([
      { name: 'clinic', version: 1, appliedAt: expect.any(String) },
    ]);
    const listed = await t.request('/v1/templates', { key: keys.reader });
    expect(listed.body.templates.find((x: { name: string }) => x.name === 'clinic').applied).toBe(
      true,
    );
  });

  it('answers 404 for an unknown template, listing the real ones', async () => {
    const res = await t.request('/v1/templates/dentist/apply', { method: 'POST', key: keys.agent });
    expect(res.status).toBe(404);
    expect(res.body.error.details.templates).toContain('clinic');
  });
});

describe('routing', () => {
  it('answers unknown routes with a JSON 404', async () => {
    const res = await t.request('/v1/nothing', { key: keys.reader });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
