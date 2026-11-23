import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace, lockSchemaShared } from '../../src/db/tx.js';
import { AppError } from '../../src/errors.js';
import { reviewPage } from '../../src/reads/review.js';
import {
  createRecord,
  decideAssertion,
  deleteRecord,
  patchRecord,
  readRecord,
  upsertRecord,
  withRead,
} from '../../src/records/service.js';
import { lockRecord, UniqueConflictError, writeFields } from '../../src/records/write.js';
import { getSchema } from '../../src/schema/compiled.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';

const reviewQueue = (sql: Sql, caller: Caller, limit: number) =>
  withRead(sql, caller, (tx, schema) => reviewPage(tx, caller.workspaceId, schema, limit, {}));

import { useTestDatabase } from '../helpers/db.js';
import { expectDataMatchesAssertions as expectDataCache } from '../helpers/records.js';

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'front-desk' };
const USER: Actor = { type: 'user', id: 'dana' };
const INTEGRATION: Actor = { type: 'integration', id: 'hubspot' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

async function schemaChange(operations: SchemaOperation[], actor: Actor = USER, ws = workspaceId) {
  return inWorkspace(app, ws, (tx) =>
    runSchemaChange(tx, { workspaceId: ws, actor, scopes: ['schema:write', 'admin'], operations }),
  );
}

async function rawRecord(id: string) {
  const [row] = await db.owner`select data, label, search::text, deleted_at from records
    where id = ${id}`;
  return row;
}

const expectDataMatchesAssertions = (id: string) => expectDataCache(app, workspaceId, id);

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Clinic', template: 'clinic' })).id;
});

let n = 0;
const email = () => `person${++n}@acme.com`;

describe('creating records', () => {
  it('stores values by field key, derived from assertions', async () => {
    const result = await createRecord(app, as(AGENT), 'person', {
      name: 'Dana Levi',
      emails: 'Dana@Acme.com',
      jobTitle: 'CTO',
      preferredChannel: 'whatsapp',
    });
    expect(result).toMatchObject({
      created: true,
      fields: {
        name: 'applied',
        emails: 'applied',
        jobTitle: 'applied',
        preferredChannel: 'applied',
      },
      record: {
        object: 'person',
        label: 'Dana Levi',
        fields: {
          name: { first: 'Dana', last: 'Levi' },
          emails: { primary: 'dana@acme.com', additional: [] },
          jobTitle: 'CTO',
        },
        createdBy: AGENT,
      },
    });
    const raw = await rawRecord(result.id);
    expect(raw?.data).toMatchObject({ jobTitle: 'CTO', emails: { primary: 'dana@acme.com' } });
    expect(raw?.search).toContain("'dana':1A");
    expect(raw?.search).toContain("'cto'");
    await expectDataMatchesAssertions(result.id);

    const identifiers = await db.owner`select kind, value, is_claim from record_identifiers
      where record_id = ${result.id}`;
    expect(identifiers).toEqual([{ kind: 'email', value: 'dana@acme.com', is_claim: true }]);
  });

  it('rejects invalid values with every problem listed', async () => {
    await expect(
      createRecord(app, as(AGENT), 'person', { preferredChannel: 'fax', shoeSize: 42 }),
    ).rejects.toMatchObject({
      code: 'invalid_values',
      details: {
        errors: [
          {
            field: 'preferredChannel',
            message: 'expected one of the options',
            allowed: ['email', 'phone', 'sms', 'whatsapp'],
          },
          expect.objectContaining({ field: 'shoeSize', message: 'unknown field on person' }),
        ],
      },
    });
  });

  it('two concurrent creates with the same email produce one record', async () => {
    const shared = email();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => createRecord(app, as(AGENT), 'person', { emails: shared })),
    );
    const created = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter((r) => r.status === 'rejected');
    expect(created).toHaveLength(1);
    const winnerId = (created[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    for (const conflict of conflicts) {
      expect(conflict.reason).toBeInstanceOf(UniqueConflictError);
      expect((conflict.reason as UniqueConflictError).recordId).toBe(winnerId);
    }
    const rows = await db.owner`select r.id from records r
      where r.workspace_id = ${workspaceId} and r.data -> 'emails' ->> 'primary' = ${shared}`;
    expect(rows).toHaveLength(1);
  });

  it('concurrent upserts with ifMissing create converge on one record', async () => {
    const shared = email();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        upsertRecord(app, as(AGENT), 'person', {
          match: { emails: shared },
          values: { jobTitle: `title ${i}` },
          ifMissing: 'create',
        }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    await expectDataMatchesAssertions(results[0]?.id as string);
  });

  it('replays a create with the same idempotency key, even concurrently', async () => {
    const values = { name: 'Idem Potent', emails: email() };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createRecord(app, as(AGENT), 'person', values, { idempotencyKey: 'key-1' }),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    await expect(
      createRecord(app, as(AGENT), 'person', { name: 'Someone else' }, { idempotencyKey: 'key-1' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });
});

describe('writes to one record are serialized (rule 2.5)', () => {
  let fieldNames: string[];
  beforeAll(async () => {
    fieldNames = Array.from({ length: 20 }, (_, i) => `slot${i}`);
    await schemaChange([
      {
        op: 'create_object',
        object: {
          nameSingular: 'board',
          namePlural: 'boards',
          labelSingular: 'Board',
          labelPlural: 'Boards',
          labelField: 'title',
          fields: [
            { name: 'title', label: 'Title', type: 'text' },
            ...fieldNames.map((name) => ({ name, label: name, type: 'text' as const })),
          ],
        },
      },
    ]);
  });

  it('concurrent writes to different fields lose no values', async () => {
    const { id } = await createRecord(app, as(AGENT), 'board', { title: 'Locks' });
    await Promise.all(
      fieldNames.map((name) => patchRecord(app, as(AGENT), id, { values: { [name]: name } })),
    );
    const record = await readRecord(app, as(AGENT), id);
    for (const name of fieldNames) expect(record.fields[name]).toBe(name);
    await expectDataMatchesAssertions(id);
  });

  it('concurrent writes to one field leave exactly one active winner', async () => {
    const { id } = await createRecord(app, as(AGENT), 'board', { title: 'Race' });
    const actors: Actor[] = [AGENT, USER, INTEGRATION, { type: 'agent', id: 'other' }];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        patchRecord(app, as(actors[i % actors.length] as Actor), id, {
          values: { slot0: `value ${i}` },
        }),
      ),
    );
    const active = await db.owner`select a.actor from field_assertions a
      join fields f on f.id = a.field_id
      where a.record_id = ${id} and f.name = 'slot0' and a.status = 'active'`;
    expect(active).toHaveLength(1);
    expect(active[0]?.actor.type).toBe('user'); // highest precedence among the writers
    await expectDataMatchesAssertions(id);
  });
});

describe('precedence and review (rules 2.2, 2.3)', () => {
  it('holds a newer agent value against a user value for review', async () => {
    const { id } = await createRecord(app, as(USER), 'person', {
      emails: email(),
      jobTitle: 'CTO',
    });
    const agentWrite = await patchRecord(app, as(AGENT), id, { values: { jobTitle: 'CEO' } });
    expect(agentWrite.fields).toEqual({ jobTitle: 'pending_review' });
    expect(agentWrite.record.fields.jobTitle).toBe('CTO');

    const queue = await reviewQueue(app, as(USER), 100);
    const pending = queue.pendingAssertions.find((p) => p.recordId === id);
    expect(pending).toMatchObject({
      object: 'person',
      field: 'jobTitle',
      value: 'CEO',
      currentValue: 'CTO',
      reason: 'outranked',
      actor: AGENT,
    });

    // An agent cannot approve its own claim.
    await expect(
      decideAssertion(app, as(AGENT), pending?.id as string, 'accept'),
    ).rejects.toMatchObject({ status: 403 });

    const accepted = await decideAssertion(app, as(USER), pending?.id as string, 'accept');
    expect(accepted).toMatchObject({ status: 'accepted', fields: { jobTitle: 'applied' } });
    expect(accepted.record.fields.jobTitle).toBe('CEO');

    const history = await db.owner`select a.actor, a.status, a.reviewed_by from field_assertions a
      join fields f on f.id = a.field_id
      where a.record_id = ${id} and f.name = 'jobTitle' order by a.created_at`;
    expect(history).toEqual([
      { actor: USER, status: 'superseded', reviewed_by: null },
      { actor: AGENT, status: 'superseded', reviewed_by: USER },
      { actor: USER, status: 'active', reviewed_by: null },
    ]);
    await expect(
      decideAssertion(app, as(USER), pending?.id as string, 'accept'),
    ).rejects.toMatchObject({ code: 'not_pending' });
    await expectDataMatchesAssertions(id);
  });

  it('supersedes an agent value equal to the user value instead of holding it', async () => {
    const { id } = await createRecord(app, as(USER), 'person', {
      emails: email(),
      jobTitle: 'CTO',
    });
    const result = await patchRecord(app, as(AGENT), id, { values: { jobTitle: 'CTO' } });
    expect(result.fields).toEqual({ jobTitle: 'superseded' });
  });

  it('lets integrations lose to people silently and agents beat agents by time', async () => {
    const { id } = await createRecord(app, as(USER), 'person', {
      emails: email(),
      jobTitle: 'CTO',
    });
    expect(
      (await patchRecord(app, as(INTEGRATION), id, { values: { jobTitle: 'VP' } })).fields,
    ).toEqual({ jobTitle: 'superseded' });

    const other = await createRecord(app, as(AGENT), 'person', { emails: email(), jobTitle: 'A' });
    const second = await patchRecord(app, as({ type: 'agent', id: 'b' }), other.id, {
      values: { jobTitle: 'B' },
    });
    expect(second.fields).toEqual({ jobTitle: 'applied' });
    expect(second.record.fields.jobTitle).toBe('B');
  });

  it('keeps an older agent claim from overwriting a newer one', async () => {
    const { id } = await createRecord(app, as(AGENT), 'person', {
      emails: email(),
      jobTitle: 'Now',
    });
    const statuses = await inWorkspace(app, workspaceId, async (tx) => {
      await lockSchemaShared(tx, workspaceId);
      const schema = await getSchema(tx, workspaceId);
      const object = schema.objectsByName.get('person');
      if (!object) throw new Error('no person');
      const record = await lockRecord(tx, workspaceId, id);
      return writeFields(
        tx,
        { workspaceId, actor: AGENT, schema, confidenceThreshold: 0.5 },
        object,
        record,
        new Map([[object.fieldsByName.get('jobTitle') as never, 'From an old email']]),
        { observedAt: new Date('2024-01-01T00:00:00Z') },
      );
    });
    expect(statuses).toEqual({ jobTitle: 'superseded' });
    expect((await readRecord(app, as(AGENT), id)).fields.jobTitle).toBe('Now');
  });

  it('holds agent values below the confidence threshold', async () => {
    const { id } = await createRecord(app, as(AGENT), 'person', { emails: email() });
    const statuses = await inWorkspace(app, workspaceId, async (tx) => {
      const schema = await getSchema(tx, workspaceId);
      const object = schema.objectsByName.get('person');
      if (!object) throw new Error('no person');
      const record = await lockRecord(tx, workspaceId, id);
      return writeFields(
        tx,
        { workspaceId, actor: AGENT, schema, confidenceThreshold: 0.5 },
        object,
        record,
        new Map([[object.fieldsByName.get('jobTitle') as never, 'Maybe CFO']]),
        { confidence: 0.2 },
      );
    });
    expect(statuses).toEqual({ jobTitle: 'pending_review' });
    const queue = await reviewQueue(app, as(USER), 500);
    expect(queue.pendingAssertions.find((p) => p.recordId === id)?.reason).toBe('low_confidence');
  });

  it('rejects a pending assertion without changing the record', async () => {
    const { id } = await createRecord(app, as(USER), 'person', {
      emails: email(),
      jobTitle: 'CTO',
    });
    await patchRecord(app, as(AGENT), id, { values: { jobTitle: 'Intern' } });
    const pending = (await reviewQueue(app, as(USER), 500)).pendingAssertions.find(
      (p) => p.recordId === id,
    );
    const rejected = await decideAssertion(app, as(USER), pending?.id as string, 'reject');
    expect(rejected.record.fields.jobTitle).toBe('CTO');
    const after = await reviewQueue(app, as(USER), 500);
    expect(after.pendingAssertions.some((p) => p.id === pending?.id)).toBe(false);
  });

  it('clears a nullable field with null', async () => {
    const { id } = await createRecord(app, as(AGENT), 'person', { emails: email(), jobTitle: 'X' });
    const result = await patchRecord(app, as(AGENT), id, { values: { jobTitle: null } });
    expect(result.fields).toEqual({ jobTitle: 'applied' });
    expect(result.record.fields.jobTitle).toBeNull();
    await expectDataMatchesAssertions(id);
  });

  it('rejects a stale expectedUpdatedAt', async () => {
    const created = await createRecord(app, as(USER), 'person', { emails: email() });
    await patchRecord(app, as(USER), created.id, { values: { jobTitle: 'A' } });
    await expect(
      patchRecord(app, as(USER), created.id, {
        values: { jobTitle: 'B' },
        expectedUpdatedAt: created.record.updatedAt,
      }),
    ).rejects.toMatchObject({ status: 412, code: 'stale_write' });
  });

  it('exposes and compares updatedAt at microsecond precision', async () => {
    const created = await createRecord(app, as(USER), 'person', { emails: email() });
    // Two changes in one millisecond: only the microseconds tell them apart.
    await db.owner`update records set updated_at = '2026-11-21T10:00:00.123456Z' where id = ${created.id}`;
    const read = await readRecord(app, as(USER), created.id);
    expect(read.updatedAt).toBe('2026-11-21T10:00:00.123456Z');
    await expect(
      patchRecord(app, as(USER), created.id, {
        values: { jobTitle: 'A' },
        expectedUpdatedAt: '2026-11-21T10:00:00.123Z',
      }),
    ).rejects.toMatchObject({
      status: 412,
      code: 'stale_write',
      details: { updatedAt: '2026-11-21T10:00:00.123456Z' },
    });
    const written = await patchRecord(app, as(USER), created.id, {
      values: { jobTitle: 'A' },
      expectedUpdatedAt: read.updatedAt,
    });
    expect(written.record.updatedAt).toMatch(/\.\d{6}Z$/);
  });

  it('lets one of two concurrent writes with the same expectedUpdatedAt through', async () => {
    const created = await createRecord(app, as(USER), 'person', { emails: email() });
    const results = await Promise.allSettled(
      ['A', 'B'].map((jobTitle) =>
        patchRecord(app, as(USER), created.id, {
          values: { jobTitle },
          expectedUpdatedAt: created.record.updatedAt,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { status: 412, code: 'stale_write' },
    });
  });
});

describe('upsert by match (6.2)', () => {
  it('updates the record whose unique email matches', async () => {
    const address = email();
    const { id } = await createRecord(app, as(AGENT), 'person', { emails: address });
    const result = await upsertRecord(app, as(AGENT), 'person', {
      match: { emails: address.toUpperCase() },
      values: { address: { street1: '12 Rothschild Blvd', city: 'Tel Aviv' } },
      ifMissing: 'fail',
    });
    expect(result).toMatchObject({ id, created: false, fields: { address: 'applied' } });
  });

  it('fails by default when nothing matches, and creates with ifMissing create', async () => {
    const address = email();
    await expect(
      upsertRecord(app, as(AGENT), 'person', {
        match: { emails: address },
        values: {},
        ifMissing: 'fail',
      }),
    ).rejects.toMatchObject({ status: 404, message: expect.stringContaining('ifMissing') });
    const created = await upsertRecord(app, as(AGENT), 'person', {
      match: { emails: address },
      values: { jobTitle: 'New' },
      ifMissing: 'create',
    });
    expect(created.created).toBe(true);
    expect(created.record.fields.emails).toEqual({ primary: address, additional: [] });
  });

  it('refuses names and phones, pointing to search', async () => {
    await expect(
      upsertRecord(app, as(AGENT), 'person', {
        match: { phones: '+972501234567' },
        values: {},
        ifMissing: 'fail',
      }),
    ).rejects.toMatchObject({
      code: 'invalid_match',
      message: expect.stringContaining('search or query_records'),
      details: { allowed: ['emails'] },
    });
    await expect(
      upsertRecord(app, as(AGENT), 'person', {
        match: { name: 'Dana Levi' },
        values: {},
        ifMissing: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'invalid_match' });
  });

  it('returns a conflict with the candidate when identifiers point at different records', async () => {
    const first = email();
    const a = await createRecord(app, as(AGENT), 'person', { emails: first });
    const b = await createRecord(app, as(AGENT), 'person', { emails: email() });
    await expect(
      upsertRecord(app, as(AGENT), 'person', {
        id: b.id,
        values: { emails: first },
        ifMissing: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'unique_conflict', details: { candidates: [a.id] } });
    expect((await readRecord(app, as(AGENT), b.id)).fields.emails).not.toEqual({
      primary: first,
      additional: [],
    });
  });
});

describe('relations', () => {
  it('links a person to a company and shows both sides', async () => {
    const company = await createRecord(app, as(AGENT), 'company', {
      name: 'Acme',
      domain: 'https://www.acme.com',
    });
    const person = await createRecord(app, as(AGENT), 'person', {
      emails: email(),
      company: company.id,
    });
    expect(person.record.fields.company).toBe(company.id);
    const companyRecord = await readRecord(app, as(AGENT), company.id);
    expect(companyRecord.fields.people).toEqual([person.id]);

    const domains = await db.owner`select kind, value from record_identifiers
      where record_id = ${company.id}`;
    expect(domains).toEqual([{ kind: 'domain', value: 'acme.com' }]);
  });

  it('rejects links to missing records and records of the wrong object', async () => {
    const task = await createRecord(app, as(AGENT), 'task', { title: 'Call back' });
    await expect(
      createRecord(app, as(AGENT), 'person', { emails: email(), company: task.id }),
    ).rejects.toMatchObject({
      code: 'invalid_values',
      details: { errors: [{ field: 'company', message: `record ${task.id} is not a company` }] },
    });
  });

  it('stops resolving a link once its target is deleted', async () => {
    const company = await createRecord(app, as(AGENT), 'company', { name: 'Gone Inc' });
    const person = await createRecord(app, as(AGENT), 'person', {
      emails: email(),
      company: company.id,
    });
    await deleteRecord(app, as(AGENT), company.id);
    expect((await readRecord(app, as(AGENT), person.id)).fields.company).toBeUndefined();
  });

  it('cascades a soft delete through relations marked cascade', async () => {
    await schemaChange([
      {
        op: 'create_object',
        object: {
          nameSingular: 'visitNote',
          namePlural: 'visitNotes',
          labelSingular: 'Visit note',
          labelPlural: 'Visit notes',
          labelField: 'title',
          fields: [
            { name: 'title', label: 'Title', type: 'text' },
            {
              name: 'patient',
              label: 'Patient',
              type: 'relation',
              settings: { targetObject: 'person', inverseField: 'visitNotes', onDelete: 'cascade' },
            },
          ],
        },
      },
    ]);
    const person = await createRecord(app, as(USER), 'person', { emails: email() });
    const note = await createRecord(app, as(USER), 'visitNote', {
      title: 'First visit',
      patient: person.id,
    });
    const deleted = await deleteRecord(app, as(USER), person.id);
    expect(deleted.deletedRecordIds.sort()).toEqual([person.id, note.id].sort());
    await expect(readRecord(app, as(USER), note.id)).rejects.toMatchObject({
      code: 'record_deleted',
    });
  });
});

describe('deleted and merged records', () => {
  it('keeps uniqueness claims after a soft delete', async () => {
    const address = email();
    const { id } = await createRecord(app, as(AGENT), 'person', { emails: address });
    await deleteRecord(app, as(AGENT), id);
    await expect(readRecord(app, as(AGENT), id)).rejects.toMatchObject({ status: 404 });
    await expect(createRecord(app, as(AGENT), 'person', { emails: address })).rejects.toMatchObject(
      { code: 'unique_conflict', details: { recordId: id } },
    );
    await expect(
      upsertRecord(app, as(AGENT), 'person', {
        match: { emails: address },
        values: { jobTitle: 'x' },
        ifMissing: 'create',
      }),
    ).rejects.toMatchObject({ code: 'record_deleted' });
  });

  it('resolves a merged record ID to the surviving record', async () => {
    const survivor = await createRecord(app, as(AGENT), 'person', { emails: email() });
    const merged = await createRecord(app, as(AGENT), 'person', { emails: email() });
    // Set a merge's outcome directly to test resolution.
    await db.owner`update records set merged_into_id = ${survivor.id}, deleted_at = now()
      where id = ${merged.id}`;
    expect((await readRecord(app, as(AGENT), merged.id)).id).toBe(survivor.id);
    const patched = await patchRecord(app, as(AGENT), merged.id, {
      values: { jobTitle: 'Via old ID' },
    });
    expect(patched.id).toBe(survivor.id);
  });
});

describe('row-level security', () => {
  it('stops workspace A from reading or writing workspace B records', async () => {
    const other = await createWorkspace(db.owner, { name: 'Other', template: 'starter' });
    const secret = await createRecord(app, as(AGENT, other.id), 'person', { emails: email() });
    await expect(readRecord(app, as(AGENT), secret.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      patchRecord(app, as(AGENT), secret.id, { values: { jobTitle: 'x' } }),
    ).rejects.toMatchObject({ status: 404 });

    // Even a query that forgets the workspace filter sees only its own rows.
    const visible = await inWorkspace(app, workspaceId, (tx) => tx`select id from records`);
    expect(visible.map((r) => r.id)).not.toContain(secret.id);
  });
});

describe('schema checks against existing records (3)', () => {
  it('fails to make a field unique while records share values, listing them', async () => {
    const a = await createRecord(app, as(AGENT), 'person', { emails: email(), jobTitle: 'Twin' });
    const b = await createRecord(app, as(AGENT), 'person', { emails: email(), jobTitle: 'Twin' });
    const result = await schemaChange([
      { op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true },
    ]);
    expect(result.status).toBe('failed');
    // Other tests' records share titles too; these two must be among them.
    expect(result.recordIds).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('claims existing values atomically when a field becomes unique', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'task',
        field: { name: 'ticket', label: 'Ticket', type: 'text' },
      },
    ]);
    const task = await createRecord(app, as(AGENT), 'task', { title: 'T', ticket: 'T-1' });
    const result = await schemaChange([
      { op: 'update_field', object: 'task', field: 'ticket', isUnique: true },
    ]);
    expect(result.status).toBe('applied');
    await expect(
      createRecord(app, as(AGENT), 'task', { title: 'Dup', ticket: 'T-1' }),
    ).rejects.toMatchObject({ code: 'unique_conflict', details: { recordId: task.id } });
    const byMatch = await upsertRecord(app, as(AGENT), 'task', {
      match: { ticket: 'T-1' },
      values: { title: 'Found by ticket' },
      ifMissing: 'fail',
    });
    expect(byMatch.id).toBe(task.id);
  });

  it('fails to make a field required while records lack it', async () => {
    const empty = await createRecord(app, as(AGENT), 'appointment', { title: 'No time' });
    const result = await schemaChange([
      { op: 'update_field', object: 'appointment', field: 'startsAt', isNullable: false },
    ]);
    expect(result.status).toBe('failed');
    expect(result.recordIds).toContain(empty.id);
  });

  it('refuses to remove an option records still use', async () => {
    const used = await createRecord(app, as(AGENT), 'appointment', {
      title: 'Checkup',
      status: 'no_show',
    });
    const result = await schemaChange([
      { op: 'remove_option', object: 'appointment', field: 'status', value: 'no_show' },
    ]);
    expect(result.status).toBe('failed');
    expect(result.recordIds).toEqual([used.id]);
  });

  it('recomputes labels when the label field changes', async () => {
    const { id } = await createRecord(app, as(AGENT), 'board', {
      title: 'Old label',
      slot1: 'New',
    });
    await schemaChange([{ op: 'update_object', object: 'board', labelField: 'slot1' }]);
    expect((await rawRecord(id))?.label).toBe('New');
  });
});

describe('errors', () => {
  it('names the unknown object and lists the real ones', async () => {
    await expect(createRecord(app, as(AGENT), 'patient', {})).rejects.toMatchObject({
      status: 404,
      details: { objects: expect.arrayContaining(['person', 'appointment']) },
    });
    await expect(
      createRecord(app, as(AGENT), 'people', { emails: email() }),
    ).resolves.toBeDefined();
    expect(AppError).toBeDefined();
  });
});
