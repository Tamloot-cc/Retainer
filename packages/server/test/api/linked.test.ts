import type { ContextPack, LinkedRecordPage } from '@retainer/shared';
import postgres from 'postgres';
import { beforeAll, expect, it } from 'vitest';
import { createWorkspaceFor } from '../../src/accounts/people.js';
import { createApiKey } from '../../src/auth/keys.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { linkedRecordPage } from '../../src/reads/linked.js';
import { getSchema } from '../../src/schema/compiled.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { addPerson } from '../helpers/people.js';

const db = useTestDatabase();
let app: ReturnType<typeof startTestApp>;
let key: string;
let workspaceId: string;

beforeAll(async () => {
  app = startTestApp(db);
  const person = await addPerson(db, 'Owner');
  const workspace = await createWorkspaceFor(
    db.owner,
    person,
    { name: 'Custom CRM' },
    'https://retainer.test',
  );
  workspaceId = workspace.id;
  ({ key } = await createApiKey(db.owner, {
    workspace: workspaceId,
    name: 'Owner key',
    actor: { type: 'user', id: person.id },
    scopes: ['admin'],
  }));
  const schema = await app.request('/v1/schema', { key });
  expect(schema.body.objects).toEqual([]);
  await change([
    definition('contact'),
    definition('account', [relation('primaryContact', 'contact'), relation('parent', 'account')]),
  ]);
});

const relation = (name: string, targetObject: string) => ({
  name,
  label: name,
  type: 'relation',
  settings: { targetObject },
});
const definition = (name: string, fields: unknown[] = []) => ({
  op: 'create_object',
  object: {
    nameSingular: name,
    namePlural: `${name}s`,
    labelSingular: name,
    labelPlural: `${name}s`,
    labelField: 'name',
    fields: [{ name: 'name', label: 'Name', type: 'text' }, ...fields],
  },
});
async function change(operations: unknown[]) {
  const result = await app.request('/v1/schema/changes', { key, body: { operations } });
  expect(result.body).toMatchObject({ status: 'applied' });
}
async function create(object: string, values: Record<string, unknown>) {
  const res = await app.request<{ id: string }>(`/v1/objects/${object}/records`, {
    key,
    body: { values },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}
const linked = (id: string, query = '') =>
  app.request<LinkedRecordPage>(`/v1/records/${id}/linked${query}`, { key });

it('reads both directions once per entity and agrees with context, MCP and the record count', async () => {
  await change([
    definition('task', [
      relation('account', 'account'),
      relation('secondaryAccount', 'account'),
      {
        name: 'state',
        label: 'State',
        type: 'select',
        settings: { options: [{ value: 'completed', label: 'Completed' }] },
      },
      {
        name: 'tags',
        label: 'Tags',
        type: 'multi_select',
        settings: { options: [{ value: 'sales', label: 'Sales' }] },
      },
    ]),
    {
      op: 'create_object',
      object: {
        class: 'event',
        nameSingular: 'meeting',
        namePlural: 'meetings',
        labelSingular: 'Meeting',
        labelPlural: 'Meetings',
        fields: [relation('account', 'account')],
      },
    },
  ]);
  const contact = await create('contact', { name: 'Dana' });
  const account = await create('account', { name: 'Acme', primaryContact: contact });
  const self = await app.request(`/v1/records/${account}`, {
    key,
    method: 'PATCH',
    body: { values: { parent: account } },
  });
  expect(self.status).toBe(200);
  const task = await create('task', {
    name: 'Send renewal',
    account,
    secondaryAccount: account,
    state: 'completed',
    tags: ['sales'],
  });
  const deleted = await create('task', { name: 'Deleted', account });
  const merged = await create('task', { name: 'Merged', account });
  expect((await app.request(`/v1/records/${deleted}`, { key, method: 'DELETE' })).status).toBe(200);
  expect(
    (
      await app.request(`/v1/records/${task}/merge`, {
        key,
        body: { recordId: merged, values: { name: 'Send renewal' } },
      })
    ).status,
  ).toBe(200);
  const event = await app.request('/v1/events', {
    key,
    body: {
      type: 'meeting',
      title: 'Weekly sync',
      channel: 'zoom',
      occurredAt: '2026-11-21T12:00:00Z',
      fields: { account },
    },
  });
  expect(event.status, JSON.stringify(event.body)).toBe(201);

  // Stored edges can outlive a record. Include stale edges explicitly so the
  // read's live-record check is exercised even when a write cleans up its links.
  const person = await addPerson(db, 'Private');
  const [priv] = await db.owner<{ id: string }[]>`
    insert into records (workspace_id, object_type_id, label, private_to_user, created_by, updated_by)
    select workspace_id, object_type_id, 'Private task', ${person.id}, created_by, updated_by
    from records where id = ${task} returning id`;
  if (!priv) throw new Error('Expected a private record fixture');
  const privateId = priv.id;
  await db.owner`
    insert into record_links (workspace_id, field_id, source_record_id, target_record_id, created_by)
    select r.workspace_id, l.field_id, r.id, l.target_record_id, r.created_by
    from records r cross join lateral (
      select field_id, target_record_id from record_links where source_record_id = ${task}
    ) l where r.id = any(${[deleted, merged, privateId]}::uuid[])
    on conflict do nothing`;

  const result = await linked(account);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    items: [
      {
        id: task,
        title: 'Send renewal',
        object: 'task',
        via: { field: expect.stringMatching(/^(account|secondaryAccount)$/), on: 'linked' },
        selects: { state: 'completed', tags: ['sales'] },
      },
      {
        id: contact,
        title: 'Dana',
        object: 'contact',
        via: { field: 'primaryContact', on: 'anchor' },
        selects: {},
      },
    ],
    nextCursor: null,
    totals: { task: 1, contact: 1 },
  });
  const taskOnly = await linked(account, '?object=tasks&limit=1');
  expect(taskOnly.status).toBe(200);
  expect(taskOnly.body).toEqual({
    items: [result.body.items[0]],
    nextCursor: null,
    totals: { task: 1 },
  });
  expect((await linked(account, '?object=task')).body).toEqual(taskOnly.body);
  expect((await linked(account, '?object=typo')).status).toBe(404);
  const eventFilter = await linked(account, '?object=meeting');
  expect(eventFilter.status).toBe(400);
  expect(eventFilter.body).toMatchObject({
    error: { message: expect.stringContaining('entity object') },
  });
  expect((await linked(account, '?limit=201')).status).toBe(400);
  expect((await linked(account, '?cursor=broken')).status).toBe(400);
  expect((await linked(privateId)).status).toBe(404);
  expect((await linked(deleted)).status).toBe(404);
  expect((await linked(merged)).body).toEqual((await linked(task)).body);
  const record = await app.request(`/v1/records/${account}?include=counts`, { key });
  expect(record.body.counts.linked).toBe(2);
  // This event has an outgoing entity link, but has no Linked tab to count.
  expect((await linked(event.body.id)).body.totals).toEqual({ account: 1 });
  const eventRecord = await app.request(`/v1/records/${event.body.id}?include=counts`, { key });
  expect(eventRecord.body.counts.linked).toBe(0);
  const context = await app.request<ContextPack>(`/v1/records/${account}/context`, { key });
  expect(context.body.linkedRecords).toEqual(
    result.body.items.map(({ object, ...item }) => ({
      object,
      total: 1,
      items: [item],
    })),
  );
  expect(context.body.omitted.linkedRecords).toBe(0);
  expect(context.body.recentEvents.map((item) => item.id)).toEqual([event.body.id]);
  const client = await app.mcpClient(key);
  try {
    const mcp = await client.call<ContextPack>('get_context', { record: account });
    expect(mcp.isError).toBe(false);
    expect(mcp.body.linkedRecords).toEqual(context.body.linkedRecords);
  } finally {
    await client.close();
  }
});

it('identifies the owning side of a self-relation in both directions', async () => {
  const parent = await create('account', { name: 'Parent' });
  const child = await create('account', { name: 'Child', parent });
  expect((await linked(parent)).body.items).toEqual([
    {
      id: child,
      title: 'Child',
      object: 'account',
      via: { field: 'parent', on: 'linked' },
      selects: {},
    },
  ]);
  expect((await linked(child)).body.items).toEqual([
    {
      id: parent,
      title: 'Parent',
      object: 'account',
      via: { field: 'parent', on: 'anchor' },
      selects: {},
    },
  ]);
});

it('projects only select values in the linked rows returned by Postgres', async () => {
  await change([
    definition('noteset', [
      relation('account', 'account'),
      { name: 'body', label: 'Body', type: 'text' },
      {
        name: 'stage',
        label: 'Stage',
        type: 'select',
        settings: { options: [{ value: 'ready', label: 'Ready' }] },
      },
    ]),
  ]);
  const account = await create('account', { name: 'Projection' });
  const body = 'Large non-select field '.repeat(450);
  const note = await create('noteset', { name: 'Notes', account, body, stage: 'ready' });
  expect((await app.request(`/v1/records/${note}`, { key })).body.fields.body).toBe(body);

  const payloads: unknown[] = [];
  const sql = postgres(db.url, {
    max: 1,
    connection: { role: RUNTIME_ROLE },
    transform: {
      value: {
        from(value, column) {
          if (column.name === 'rows') payloads.push(value);
          return value;
        },
      },
    },
  });
  try {
    await inWorkspace(sql, workspaceId, async (tx) => {
      const schema = await getSchema(tx, workspaceId);
      const page = await linkedRecordPage(
        tx,
        { workspaceId, schema, recordId: account },
        { limit: 10 },
      );
      expect(page.items[0]?.selects).toEqual({ stage: 'ready' });
    });
    expect(payloads).toEqual([
      [
        expect.objectContaining({
          id: note,
          selects: { stage: 'ready' },
        }),
      ],
    ]);
    expect(JSON.stringify(payloads).length).toBeLessThan(300);
  } finally {
    await sql.end();
  }
});

it('keeps the page bounded across many objects and pages past equal timestamps', async () => {
  const names = Array.from({ length: 52 }, (_, index) => `category${index}`);
  await change(names.map((name) => definition(name, [relation('account', 'account')])));
  const account = await create('account', { name: 'Many links' });
  const ids = [];
  for (const object of names) ids.push(await create(object, { name: object, account }));
  // Sub-millisecond precision is retained by the cursor. Equal stamps use ID.
  const [newest] = ids;
  if (!newest) throw new Error('Expected records to page');
  await db.owner`update records set updated_at = '2026-11-21 00:00:00.000001Z'
    where id = any(${ids}::uuid[])`;
  await db.owner`update records set updated_at = '2026-11-21 00:00:00.000002Z'
    where id = ${newest}`;
  const first = await linked(account);
  expect(first.body.items).toHaveLength(50);
  expect(first.body.totals).toEqual(Object.fromEntries(names.map((name) => [name, 1])));
  expect(first.body.nextCursor).toBeTruthy();
  const next = await linked(account, `?cursor=${first.body.nextCursor}`);
  expect(next.body.totals).toEqual(first.body.totals);
  expect(next.body.nextCursor).toBeNull();
  expect([...first.body.items, ...next.body.items].map((item) => item.id)).toEqual([
    newest,
    ...ids.slice(1).sort().reverse(),
  ]);
  const context = await app.request<ContextPack>(`/v1/records/${account}/context?tokenBudget=250`, {
    key,
  });
  expect(context.body.linkedRecords.length).toBeGreaterThan(0);
  expect(context.body.linkedRecords.map((group) => group.items[0]?.id)).toEqual(
    first.body.items.slice(0, context.body.linkedRecords.length).map((item) => item.id),
  );
  expect(context.body.linkedRecords.length + context.body.omitted.linkedRecords).toBe(ids.length);
  expect(context.body.tokenEstimate).toBeLessThanOrEqual(250);
});
