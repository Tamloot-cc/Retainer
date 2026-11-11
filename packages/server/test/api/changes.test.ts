import { randomUUID } from 'node:crypto';
import { RetainerClient } from '@retainer/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { requireObject, withWrite } from '../../src/records/service.js';
import { prepareValues } from '../../src/records/values.js';
import { insertRecord, writeFields } from '../../src/records/write.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
beforeAll(() => {
  t = startTestApp(db);
});
async function setup() {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Changes ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'research' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'user', id: 'reader' }, scopes: ['read'] },
    },
  );
  const list = (after?: string, limit = 100) =>
    t.request(
      `/v1/changes?limit=${limit}${after !== undefined ? `&after=${encodeURIComponent(after)}` : ''}`,
      { key: keys.reader },
    );
  const create = (name: string, more: Record<string, unknown> = {}) =>
    t.request('/v1/objects/person/records', {
      key: keys.admin,
      body: { values: { name, ...more } },
    });
  return { workspace, keys, list, create };
}
describe('commit-ordered minimal record changes with real Postgres', () => {
  it('publishes a slower transaction after a faster commit without letting a consumer skip it', async () => {
    const h = await setup(),
      initial = await h.list();
    let entered = () => {},
      release = () => {};
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      paused = new Promise<void>((r) => {
        release = r;
      });
    const slow = withWrite(
      t.sql,
      { workspaceId: h.workspace.id, actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      async (tx, context) => {
        const object = requireObject(context.schema, 'person'),
          record = await insertRecord(tx, context, object);
        await writeFields(
          tx,
          context,
          object,
          record,
          prepareValues(object, { name: 'Slow transaction' }, 'create'),
        );
        entered();
        await paused;
        return record.id;
      },
    );
    await started;
    let first = initial;
    try {
      const fast = await h.create('Fast transaction');
      expect(fast.status).toBe(201);
      first = await h.list(initial.body.nextCursor);
      expect(first.status).toBe(200);
      expect(first.body.changes.map((c: { recordId: string }) => c.recordId)).toEqual([
        fast.body.id,
      ]);
    } finally {
      release();
    }
    const slowId = await slow;
    const next = await h.list(first?.body.nextCursor);
    expect(next.body.changes.map((c: { recordId: string }) => c.recordId)).toEqual([slowId]);
    expect(next.body.nextCursor).not.toBe(first?.body.nextCursor);
  });
  it('emits permanent field keys only for effective changes, while review has its own operation', async () => {
    const h = await setup(),
      person = await h.create('Private label', { jobTitle: 'Human title' }),
      start = (await h.list()).body.nextCursor;
    const pending = await t.request(`/v1/records/${person.body.id}`, {
      key: h.keys.agent,
      method: 'PATCH',
      body: { values: { jobTitle: 'Unaccepted title' } },
    });
    expect(pending.status).toBe(200);
    expect(pending.body.fields.jobTitle).toBe('pending_review');
    await t.request(`/v1/records/${person.body.id}`, {
      key: h.keys.admin,
      method: 'PATCH',
      body: { values: { name: 'Private label' } },
    });
    expect((await h.list(start)).body.changes).toEqual([]);
    const [assertion] =
      await db.owner`select id,field_id from field_assertions where record_id=${person.body.id} and status='pending_review'`;
    const [field] = await db.owner`select key from fields where id=${assertion?.field_id}`;
    const decision = await t.request(`/v1/assertions/${assertion?.id}/reject`, {
      key: h.keys.admin,
      method: 'POST',
    });
    expect(decision.status).toBe(200);
    const reviewed = await h.list(start);
    expect(reviewed.body.changes).toMatchObject([
      { recordId: person.body.id, operation: 'review', changedKeys: [field?.key] },
    ]);
    expect(JSON.stringify(reviewed.body)).not.toContain('Private label');
    expect(JSON.stringify(reviewed.body)).not.toContain('Unaccepted title');
  });
  it('records event links and deletion with authorized related IDs without retaining handles or record bodies', async () => {
    const h = await setup(),
      person = await h.create('Secret attendee', { emails: 'secret-attendee@fixture.test' }),
      start = (await h.list()).body.nextCursor;
    const event = await t.request('/v1/events', {
      key: h.keys.admin,
      body: {
        type: 'conversation',
        channel: 'provider',
        occurredAt: '2026-11-10T10:00:00Z',
        title: 'Confidential meeting title',
        participants: [{ handle: 'secret-attendee@fixture.test' }],
      },
    });
    expect(event.status).toBe(201);
    const created = await h.list(start);
    expect(created.body.changes).toMatchObject([
      { recordId: event.body.id, operation: 'create', relatedRecordIds: [person.body.id] },
    ]);
    expect(JSON.stringify(created.body)).not.toContain('Confidential');
    expect(JSON.stringify(created.body)).not.toContain('secret-attendee');
    expect(
      (await t.request(`/v1/events/${event.body.id}`, { key: h.keys.admin, method: 'DELETE' }))
        .status,
    ).toBe(200);
    const erased = await h.list(created.body.nextCursor);
    expect(erased.body.changes).toMatchObject([
      { recordId: event.body.id, operation: 'retract', relatedRecordIds: [person.body.id] },
    ]);
  });
  it('retains merge tombstones and removes prior feed derivatives during privacy erasure', async () => {
    const h = await setup(),
      a = await h.create('Survivor'),
      b = await h.create('Merged person'),
      start = (await h.list()).body.nextCursor;
    expect(
      (
        await t.request(`/v1/records/${a.body.id}/merge`, {
          key: h.keys.admin,
          body: { recordId: b.body.id },
        })
      ).status,
    ).toBe(200);
    const merged = await h.list(start);
    expect(merged.body.changes).toContainEqual(
      expect.objectContaining({ recordId: b.body.id, operation: 'merge', mergedIntoId: a.body.id }),
    );
    expect(
      (await t.request(`/v1/records/${a.body.id}/forget`, { key: h.keys.admin, method: 'POST' }))
        .status,
    ).toBe(200);
    const rows =
      await db.owner`select record_id,operation,related_record_ids from record_changes where workspace_id=${h.workspace.id}`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.operation === 'forget')).toBe(true);
    expect(rows.every((r) => r.related_record_ids.length === 0)).toBe(true);
    const after = await h.list(merged.body.nextCursor);
    expect(after.status).toBe(200);
    expect(after.body.changes.every((c: { operation: string }) => c.operation === 'forget')).toBe(
      true,
    );
  });
  it('returns 410 for lost retained history and never calls privacy gaps cursor expiration', async () => {
    const h = await setup(),
      initial = (await h.list()).body.nextCursor;
    await h.create('Old');
    const old = (await h.list()).body.nextCursor;
    await db.owner`update record_changes set created_at=clock_timestamp()-interval '31 days' where workspace_id=${h.workspace.id}`;
    const current = await h.create('Current');
    const expired = await h.list(initial);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('cursor_expired');
    expect((await h.list(old)).body.changes.map((c: { recordId: string }) => c.recordId)).toEqual([
      current.body.id,
    ]);
    const fresh = await h.list();
    expect(fresh.body.changes.map((c: { recordId: string }) => c.recordId)).toEqual([
      current.body.id,
    ]);
  });
  it('captures a rescan head before concurrent writes without replaying retained history', async () => {
    const h = await setup();
    await h.create('Before scan');
    const head = (await h.list(undefined, 1)).body.headCursor;
    const during = await h.create('During scan');
    const replay = await h.list(head);
    expect(replay.body.changes.map((change: { recordId: string }) => change.recordId)).toEqual([
      during.body.id,
    ]);
    expect(replay.body.headCursor).toBe(replay.body.nextCursor);
  });
  it('isolates workspaces and matches REST, SDK and MCP cursor semantics', async () => {
    const h = await setup(),
      other = await setup();
    await h.create('Minimal feed');
    const rest = await h.list();
    expect(rest.status).toBe(200);
    expect((await other.list(rest.body.nextCursor)).status).toBe(400);
    const client = new RetainerClient({
      baseUrl: 'http://retainer.test',
      apiKey: h.keys.reader,
      fetch: t.inProcessFetch,
    });
    expect(await client.changes()).toEqual(rest.body);
    const mcp = await t.mcpClient(h.keys.reader);
    try {
      expect((await mcp.call('list_changes', {})).body).toEqual(rest.body);
    } finally {
      await mcp.close();
    }
  });
  it('rolls back a failed write together with its publication and keeps an empty cursor usable', async () => {
    const h = await setup(),
      start = (await h.list()).body.nextCursor;
    await expect(
      withWrite(
        t.sql,
        { workspaceId: h.workspace.id, actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
        async (tx, context) => {
          const object = requireObject(context.schema, 'person'),
            record = await insertRecord(tx, context, object);
          await writeFields(
            tx,
            context,
            object,
            record,
            prepareValues(object, { name: 'Rolled back' }, 'create'),
          );
          throw new Error('rollback fixture');
        },
      ),
    ).rejects.toThrow('rollback fixture');
    expect((await h.list(start)).body.changes).toEqual([]);
    expect((await h.create('Committed')).status).toBe(201);
    expect((await h.list(start)).body.changes).toHaveLength(1);
  });
  it('publishes schema-driven field removal and event-type deletion in the same transaction', async () => {
    const h = await setup();
    expect(
      (
        await t.request('/v1/schema/changes', {
          key: h.keys.admin,
          body: {
            operations: [
              {
                op: 'create_field',
                object: 'person',
                field: { name: 'obsolete', label: 'Obsolete', type: 'text' },
              },
              {
                op: 'create_object',
                object: {
                  nameSingular: 'feedEvent',
                  namePlural: 'feedEvents',
                  labelSingular: 'Feed event',
                  labelPlural: 'Feed events',
                  class: 'event',
                  fields: [],
                },
              },
            ],
          },
        })
      ).status,
    ).toBe(200);
    const person = await h.create('Field removal', { obsolete: 'Old value' });
    const event = await t.request('/v1/events', {
      key: h.keys.admin,
      body: {
        type: 'feedEvent',
        channel: 'fixture',
        occurredAt: '2026-11-10T10:00:00Z',
        title: 'Retired type',
      },
    });
    expect(event.status).toBe(201);
    const start = (await h.list()).body.nextCursor;
    const [field] =
      await db.owner`select key from fields where workspace_id=${h.workspace.id} and name='obsolete'`;
    expect(
      (
        await t.request('/v1/schema/changes', {
          key: h.keys.admin,
          body: {
            operations: [
              { op: 'delete_field', object: 'person', field: 'obsolete' },
              { op: 'delete_object', object: 'feedEvent' },
            ],
          },
        })
      ).status,
    ).toBe(200);
    const result = await h.list(start);
    expect(result.status).toBe(200);
    expect(result.body.changes).toContainEqual(
      expect.objectContaining({
        recordId: person.body.id,
        operation: 'update',
        changedKeys: [field?.key],
      }),
    );
    expect(result.body.changes).toContainEqual(
      expect.objectContaining({ recordId: event.body.id, operation: 'delete' }),
    );
  });
  it('publishes a type move as an old-type tombstone and a new-type creation', async () => {
    const h = await setup();
    for (const name of ['priorEvent', 'nextEvent']) {
      expect(
        (
          await t.request('/v1/schema/changes', {
            key: h.keys.admin,
            body: {
              operations: [
                {
                  op: 'create_object',
                  object: {
                    nameSingular: name,
                    namePlural: `${name}s`,
                    labelSingular: name,
                    labelPlural: `${name}s`,
                    class: 'event',
                    fields: [],
                  },
                },
              ],
            },
          })
        ).status,
      ).toBe(200);
    }
    const event = await t.request('/v1/events', {
      key: h.keys.admin,
      body: {
        type: 'priorEvent',
        channel: 'fixture',
        occurredAt: '2026-11-10T10:00:00Z',
        title: 'Moved event',
      },
    });
    expect(event.status).toBe(201);
    const start = (await h.list()).body.nextCursor;
    expect(
      (
        await t.request('/v1/events/move', {
          key: h.keys.admin,
          body: {
            from: 'priorEvent',
            to: 'nextEvent',
            events: [event.body.id],
          },
        })
      ).status,
    ).toBe(200);
    const [prior, next] = (await h.list(start)).body.changes;
    expect(prior).toMatchObject({ recordId: event.body.id, operation: 'delete' });
    expect(next).toMatchObject({ recordId: event.body.id, operation: 'create' });
    expect(prior.objectTypeId).not.toBe(next.objectTypeId);
  });
  it('never publishes private records even when the migration owner can see them', async () => {
    const h = await setup(),
      start = (await h.list()).body.nextCursor;
    const [user] = await db.owner<
      { id: string }[]
    >`insert into users(name,email,email_verified) values('Private owner',${`${randomUUID()}@fixture.test`},true) returning id`;
    if (!user) throw new Error('private owner missing');
    // Real private rows under an owner connection exercise the explicit feed exclusion as well as RLS.
    const privateId = await withWrite(
      db.owner,
      { workspaceId: h.workspace.id, actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      async (tx, context) => {
        const object = requireObject(context.schema, 'person'),
          record = await insertRecord(tx, context, object, user.id);
        await writeFields(
          tx,
          context,
          object,
          record,
          prepareValues(object, { name: 'Private memory fixture' }, 'create'),
        );
        return record.id;
      },
    );
    expect((await h.list(start)).body.changes).toEqual([]);
    expect(
      await db.owner`select position from record_changes where record_id=${privateId}`,
    ).toHaveLength(0);
  });
});
