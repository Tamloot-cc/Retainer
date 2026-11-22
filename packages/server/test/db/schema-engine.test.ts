import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import type { ApiKeyScope } from '../../src/db/schema.js';
import { inWorkspace, lockPrivacyShared, lockSchemaExclusive } from '../../src/db/tx.js';
import { getWorkspace } from '../../src/db/workspaces.js';
import { AppError } from '../../src/errors.js';
import { logEventFor } from '../../src/memory/service.js';
import { createRecord, readRecord } from '../../src/records/service.js';
import { getSchema } from '../../src/schema/compiled.js';
import { loadSchemaState } from '../../src/schema/load.js';
import { SchemaValidationError } from '../../src/schema/types.js';
import { decideSchemaChange, runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { applyTemplate } from '../../src/templates/apply.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Sql;

const agent: Actor = { type: 'agent', id: 'front-desk' };
const admin: Actor = { type: 'user', id: 'dana' };
const ALL: ApiKeyScope[] = ['read', 'write', 'schema:write', 'admin'];

beforeAll(() => {
  app = db.connect({ role: RUNTIME_ROLE, max: 20 });
});

function change(
  workspaceId: string,
  operations: SchemaOperation[],
  actor: Actor = agent,
  scopes: ApiKeyScope[] = ['schema:write'],
) {
  return inWorkspace(app, workspaceId, (tx) =>
    runSchemaChange(tx, { workspaceId, actor, scopes, operations }),
  );
}

function decide(
  workspaceId: string,
  changeId: string,
  decision: 'approve' | 'reject',
  actor = admin,
) {
  return inWorkspace(app, workspaceId, (tx) =>
    decideSchemaChange(tx, { workspaceId, changeId, actor, scopes: ALL, decision }),
  );
}

function fieldNames(workspaceId: string, object: string) {
  return inWorkspace(app, workspaceId, async (tx) => {
    const state = await loadSchemaState(tx, workspaceId);
    return state.objects
      .find((o) => o.nameSingular === object)
      ?.fields.filter((f) => f.status === 'active')
      .map((f) => f.name);
  });
}

let counter = 0;
const newWorkspace = (template?: string) =>
  createWorkspace(db.owner, { name: `Workspace ${++counter}`, ...(template ? { template } : {}) });

describe('workspace creation', () => {
  it('seeds only hidden types through the engine', async () => {
    const workspace = await newWorkspace();
    expect(workspace).toMatchObject({ schemaVersion: 1, templates: [], initializedAt: null });
    expect(await fieldNames(workspace.id, 'person')).toBeUndefined();
    const schema = await inWorkspace(app, workspace.id, (tx) => getSchema(tx, workspace.id));
    expect(schema.visibleObjectIds).toHaveLength(0);
    expect(schema.internalNote).toBeDefined();
    const changes = await db.owner`select status, requested_by from schema_changes
      where workspace_id = ${workspace.id}`;
    expect(changes).toEqual([
      { status: 'applied', requested_by: { type: 'system', id: 'retainer' } },
    ]);
  });

  it('applies a template and records it', async () => {
    const workspace = await newWorkspace('clinic');
    expect(workspace.templates).toEqual([
      { name: 'clinic', version: 1, appliedAt: expect.any(String) },
    ]);
    expect(workspace.initializedAt).not.toBeNull();
    expect(await fieldNames(workspace.id, 'appointment')).toEqual([
      'title',
      'startsAt',
      'type',
      'status',
      'person',
    ]);
  });

  it('leaves nothing behind when the template does not exist', async () => {
    await expect(
      createWorkspace(db.owner, { name: 'Broken', template: 'nope' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(getWorkspace(db.owner, 'broken')).rejects.toBeInstanceOf(AppError);
  });
});

describe('schema changes', () => {
  let workspaceId: string;
  beforeAll(async () => {
    workspaceId = (await newWorkspace('starter')).id;
  });

  it('applies additive changes requested by an agent', async () => {
    const result = await change(workspaceId, [
      {
        op: 'create_field',
        object: 'person',
        field: { name: 'nickname', label: 'Nickname', type: 'text' },
      },
    ]);
    expect(result).toMatchObject({ status: 'applied', schemaVersion: 3 });
    expect(result.change?.requestedBy).toEqual(agent);
    expect(await fieldNames(workspaceId, 'person')).toContain('nickname');

    const [field] = await db.owner`select owner from fields where name = 'nickname'
      and workspace_id = ${workspaceId}`;
    expect(field?.owner).toBe('agent');
  });

  it('returns unchanged for a change that changes nothing', async () => {
    const result = await change(workspaceId, [
      { op: 'update_field', object: 'person', field: 'nickname', label: 'Nickname' },
    ]);
    expect(result).toMatchObject({ status: 'unchanged', change: null });
  });

  it('rejects invalid changes with every issue', async () => {
    await expect(
      change(workspaceId, [
        { op: 'create_field', object: 'person', field: { name: 'id', label: 'Id', type: 'text' } },
        { op: 'delete_object', object: 'nothing' },
      ]),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof SchemaValidationError && error.issues.length === 2,
    );
  });

  it('proposes destructive changes from an agent, even with an admin key', async () => {
    const result = await change(
      workspaceId,
      [{ op: 'rename_field', object: 'person', field: 'nickname', name: 'alias' }],
      agent,
      ALL,
    );
    expect(result.status).toBe('proposed');
    expect(result.change?.isDestructive).toBe(true);
    expect(await fieldNames(workspaceId, 'person')).toContain('nickname');

    const approved = await decide(workspaceId, result.change?.id as string, 'approve');
    expect(approved.status).toBe('applied');
    expect(approved.change?.decidedBy).toEqual(admin);
    expect(await fieldNames(workspaceId, 'person')).toContain('alias');
  });

  it('applies destructive changes from a user with admin scope directly', async () => {
    const result = await change(
      workspaceId,
      [{ op: 'rename_field', object: 'person', field: 'alias', name: 'nickname' }],
      admin,
      ALL,
    );
    expect(result.status).toBe('applied');
  });

  it('proposes destructive changes from a user without admin scope', async () => {
    const result = await change(
      workspaceId,
      [{ op: 'delete_field', object: 'person', field: 'nickname' }],
      admin,
      ['schema:write'],
    );
    expect(result.status).toBe('proposed');
    const rejected = await decide(workspaceId, result.change?.id as string, 'reject');
    expect(rejected.status).toBe('rejected');
    expect(await fieldNames(workspaceId, 'person')).toContain('nickname');
  });

  it('marks an approval failed when the change no longer validates', async () => {
    const proposed = await change(workspaceId, [
      { op: 'rename_field', object: 'person', field: 'jobTitle', name: 'role' },
    ]);
    await change(
      workspaceId,
      [{ op: 'delete_field', object: 'person', field: 'jobTitle' }],
      admin,
      ALL,
    );
    const result = await decide(workspaceId, proposed.change?.id as string, 'approve');
    expect(result.status).toBe('failed');
    expect(result.change?.error).toContain('unknown field');
  });

  it('lets only a user with admin scope decide', async () => {
    const proposed = await change(workspaceId, [
      { op: 'delete_field', object: 'person', field: 'nickname' },
    ]);
    await expect(
      decide(workspaceId, proposed.change?.id as string, 'approve', agent),
    ).rejects.toMatchObject({
      status: 403,
    });
    await decide(workspaceId, proposed.change?.id as string, 'reject');
    await expect(
      decide(workspaceId, proposed.change?.id as string, 'approve'),
    ).rejects.toMatchObject({
      code: 'already_decided',
    });
  });

  it('serializes concurrent changes in one workspace', async () => {
    const before = (await getWorkspace(db.owner, workspaceId)).schemaVersion;
    const names = Array.from({ length: 10 }, (_, i) => `concurrent${i}`);
    const results = await Promise.all(
      names.map((name) =>
        change(workspaceId, [
          { op: 'create_field', object: 'company', field: { name, label: name, type: 'text' } },
        ]),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(names.map(() => 'applied'));
    expect(results.map((r) => r.schemaVersion).sort((a, b) => a - b)).toEqual(
      names.map((_, i) => before + i + 1),
    );
    expect(await fieldNames(workspaceId, 'company')).toEqual(expect.arrayContaining(names));
  });

  it('caches the compiled schema per schema version', async () => {
    const first = await inWorkspace(app, workspaceId, (tx) => getSchema(tx, workspaceId));
    const again = await inWorkspace(app, workspaceId, (tx) => getSchema(tx, workspaceId));
    expect(again).toBe(first);
    await change(workspaceId, [
      {
        op: 'create_field',
        object: 'task',
        field: { name: 'priority', label: 'P', type: 'number' },
      },
    ]);
    const after = await inWorkspace(app, workspaceId, (tx) => getSchema(tx, workspaceId));
    expect(after.version).toBe(first.version + 1);
    expect(after.objectsByName.get('task')?.fieldsByName.has('priority')).toBe(true);
  });
});

describe('templates', () => {
  const apply = (workspaceId: string, name: string, actor: Actor = agent) =>
    inWorkspace(app, workspaceId, (tx) =>
      applyTemplate(tx, { workspaceId, actor, scopes: ['schema:write'], name }),
    );

  it('records a template only after approval and copies the starter definitions', async () => {
    const { id } = await newWorkspace();
    const first = await apply(id, 'sales');
    expect(first).toMatchObject({ status: 'proposed', change: { template: 'sales' } });
    expect((await getWorkspace(db.owner, id)).templates).toEqual([]);
    expect(await fieldNames(id, 'person')).toBeUndefined();

    if (!first.change) throw new Error('missing template proposal');
    const result = await decide(id, first.change.id, 'approve');
    expect(result.status).toBe('applied');
    const schema = await inWorkspace(app, id, (tx) => getSchema(tx, id));
    expect([...schema.objectsByName.keys()]).toEqual(
      expect.arrayContaining(['deal', 'person', 'company', 'task', 'conversation']),
    );
    expect(schema.objectsByName.get('person')?.fieldsByName.get('emails')).toMatchObject({
      isUnique: true,
      owner: 'workspace',
    });
    expect((await getWorkspace(db.owner, id)).templates.map((t) => t.name)).toEqual(['sales']);
    await expect(apply(id, 'sales')).rejects.toMatchObject({ code: 'workspace_not_empty' });
  });

  it('rechecks emptiness at approval while a schema create holds the exclusive lock', async () => {
    const { id } = await newWorkspace();
    const proposal = await apply(id, 'sales');
    if (!proposal.change) throw new Error('missing template proposal');
    let signalLocked = () => {};
    let releaseLock = () => {};
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const create = inWorkspace(app, id, async (tx) => {
      await lockPrivacyShared(tx, id);
      await lockSchemaExclusive(tx, id);
      signalLocked();
      await release;
      return runSchemaChange(tx, {
        workspaceId: id,
        actor: agent,
        scopes: ['schema:write'],
        operations: [
          {
            op: 'create_object',
            object: {
              nameSingular: 'vendor',
              namePlural: 'vendors',
              labelSingular: 'Vendor',
              labelPlural: 'Vendors',
              labelField: 'name',
              fields: [{ name: 'name', label: 'Name', type: 'text' }],
            },
          },
        ],
      });
    });
    await locked;
    const approval = decide(id, proposal.change.id, 'approve');
    releaseLock();
    const [created, approved] = await Promise.allSettled([create, approval]);
    if (created.status === 'rejected') throw created.reason;
    expect(created.value.status).toBe('applied');
    expect(approved).toMatchObject({
      status: 'rejected',
      reason: { status: 409, code: 'workspace_not_empty' },
    });
    expect((await getWorkspace(db.owner, id)).templates).toEqual([]);
    expect(await fieldNames(id, 'deal')).toBeUndefined();
  });
});

describe('event types', () => {
  it('copies the starter event type, and hides the internal-note type from the schema', async () => {
    const { id } = await newWorkspace('starter');
    const schema = await inWorkspace(app, id, (tx) => getSchema(tx, id));
    const events = [...schema.objectsByName.values()].filter((o) => o.isEvent);
    expect(events.map((o) => o.name).sort()).toEqual(['conversation']);
    expect(schema.eventTypeIds).toHaveLength(1);
    expect(schema.objectsByName.get('conversation')?.fieldsByName.get('medium')).toMatchObject({
      type: 'select',
      isNullable: true,
      isFilterable: true,
      isProtected: false,
    });
    expect(schema.internalNote).toBeDefined();
    expect(schema.visibleObjectIds).not.toContain(schema.internalNote?.id);
  });

  it('creates an event type with class "event" and its core fields', async () => {
    const { id } = await newWorkspace();
    const result = await change(id, [
      {
        op: 'create_object',
        object: {
          nameSingular: 'payment',
          namePlural: 'payments',
          labelSingular: 'Payment',
          labelPlural: 'Payments',
          class: 'event',
          fields: [{ name: 'amount', label: 'Amount', type: 'money' }],
        },
      },
    ]);
    expect(result.status).toBe('applied');
    expect(await fieldNames(id, 'payment')).toEqual(['title', 'summary', 'amount']);
  });

  it('deletes an event type through the event deletion lifecycle, atomically', async () => {
    const { id } = await newWorkspace('starter');
    const caller = { workspaceId: id, actor: agent, scopes: ['read', 'write'] as ApiKeyScope[] };
    const call = await logEventFor(app, caller, {
      type: 'conversation',
      channel: 'zoom',
      externalId: 'z-1',
      occurredAt: '2026-10-01T10:00:00Z',
      title: 'Renewal call',
      fields: {},
      participants: [],
      about: [],
    });
    const person = await createRecord(
      app,
      caller,
      'person',
      { emails: 'dana@acme.com', jobTitle: 'CTO' },
      { source: call.id },
    );
    expect(person.record.fields.jobTitle).toBe('CTO');

    const result = await change(id, [{ op: 'delete_object', object: 'conversation' }], admin, ALL);
    expect(result.status).toBe('applied');

    // The call is deleted with its type, and what it was cited for no longer counts.
    const [row] = await db.owner<{ deleted_at: Date | null }[]>`
      select deleted_at from records where id = ${call.id}`;
    expect(row?.deleted_at).not.toBeNull();
    const after = await readRecord(app, caller, person.id);
    expect(after.fields.jobTitle ?? null).toBeNull();
    const statuses = await db.owner<{ status: string }[]>`
      select status from field_assertions
      where record_id = ${person.id} and source_record_id = ${call.id}`;
    // Both values (emails and jobTitle) cited the call.
    expect(statuses.map((s) => s.status)).toEqual(['retracted', 'retracted']);
  });
});
