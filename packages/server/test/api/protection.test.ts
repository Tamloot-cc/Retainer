import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'admin', string>;

beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Protected' },
    {
      agent: {
        actor: { type: 'agent', id: 'bot' },
        scopes: ['read', 'write', 'schema:write'],
      },
      admin: { actor: { type: 'user', id: 'dana' }, scopes: ['admin'] },
    },
  ));
});

async function change(operations: unknown[], key = keys.admin) {
  return t.request('/v1/schema/changes', { key, body: { operations } });
}

describe('schema protection', () => {
  it('describes protected objects, fields and options', async () => {
    const res = await t.request('/v1/schema', { key: keys.agent });
    const task = res.body.objects.find((o: { nameSingular: string }) => o.nameSingular === 'task');
    expect(task).toMatchObject({ isProtected: true, baseObject: 'task' });
    const status = task.fields.find((f: { name: string }) => f.name === 'status');
    expect(status).toMatchObject({
      isProtected: true,
      baseField: 'taskStatus',
      protectedOptions: ['done'],
    });
    const title = task.fields.find((f: { name: string }) => f.name === 'title');
    expect(title.isProtected).toBe(false);
    expect(title.baseField).toBeUndefined();
  });

  it('does not let a caller assign protection', async () => {
    const res = await change(
      [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'vip', label: 'VIP', type: 'boolean', isProtected: true },
        },
      ],
      keys.agent,
    );
    expect(res.status).toBe(400);
  });

  it('refuses to delete or reshape protected elements, even for an admin', async () => {
    for (const operation of [
      { op: 'delete_object', object: 'company' },
      { op: 'delete_field', object: 'task', field: 'dueDate' },
      { op: 'update_field', object: 'task', field: 'status', isNullable: false },
      { op: 'remove_option', object: 'task', field: 'status', value: 'done' },
    ]) {
      const res = await change([operation]);
      expect(res.status, JSON.stringify(operation)).toBe(422);
      expect(JSON.stringify(res.body)).toContain('is protected');
    }
  });

  it('keeps context packs working after renaming the task object and its fields', async () => {
    const renamed = await change([
      { op: 'rename_object', object: 'task', nameSingular: 'todo', namePlural: 'todos' },
      { op: 'rename_field', object: 'todo', field: 'status', name: 'state' },
      { op: 'rename_field', object: 'todo', field: 'dueDate', name: 'deadline' },
      {
        op: 'add_option',
        object: 'todo',
        field: 'state',
        option: { value: 'blocked', label: 'Blocked' },
      },
      { op: 'update_option', object: 'todo', field: 'state', value: 'done', label: 'Finished' },
    ]);
    expect(renamed.status).toBe(200);

    const company = await t.request('/v1/objects/company/records', {
      key: keys.agent,
      body: { values: { name: 'Acme' } },
    });
    const companyId = company.body.record.id;
    for (const [title, state, deadline] of [
      ['Open', 'blocked', '2026-11-10'],
      ['Closed', 'done', '2026-11-01'],
    ] as const) {
      const res = await t.request('/v1/objects/todo/records', {
        key: keys.agent,
        body: { values: { title, state, deadline, company: companyId } },
      });
      expect(res.status).toBe(201);
    }

    const pack = await t.request(`/v1/records/${companyId}/context`, { key: keys.agent });
    expect(pack.status).toBe(200);
    expect(pack.body.linkedRecords).toEqual([
      {
        object: 'todo',
        total: 2,
        items: [
          {
            id: expect.any(String),
            title: 'Closed',
            via: { field: 'company', on: 'linked' },
            selects: { state: 'done' },
          },
          {
            id: expect.any(String),
            title: 'Open',
            via: { field: 'company', on: 'linked' },
            selects: { state: 'blocked' },
          },
        ],
      },
    ]);

    const schema = await t.request('/v1/schema', { key: keys.agent });
    const todo = schema.body.objects.find(
      (o: { nameSingular: string }) => o.nameSingular === 'todo',
    );
    expect(todo).toMatchObject({ baseObject: 'task', isProtected: true });
    expect(todo.fields.find((f: { name: string }) => f.name === 'state').baseField).toBe(
      'taskStatus',
    );
  });
});
