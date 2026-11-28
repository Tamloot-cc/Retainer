import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'reader' | 'dana' | 'omer' | 'admin', string>;
let otherKey: string;

beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'user', id: 'viewer' }, scopes: ['read'] },
      dana: { actor: { type: 'user', id: 'dana' }, scopes: ['read', 'write'] },
      omer: { actor: { type: 'user', id: 'omer' }, scopes: ['read', 'write'] },
      admin: { actor: { type: 'user', id: 'root' }, scopes: ['admin'] },
    },
  ));
  otherKey = (
    await t.setupWorkspace(
      { name: 'Other', template: 'sales' },
      { dana: { actor: { type: 'user', id: 'dana' }, scopes: ['read', 'write'] } },
    )
  ).keys.dana;
});

const create = (body: unknown, key = keys.dana, object = 'deal') =>
  t.request(`/v1/objects/${object}/views`, { key, body });
const patch = (id: string, body: unknown, key = keys.dana) =>
  t.request(`/v1/views/${id}`, { key, method: 'PATCH', body });
const list = async (key = keys.dana, object = 'deal') =>
  (await t.request(`/v1/objects/${object}/views`, { key })).body.views as { id: string }[];
const schemaChange = (operations: unknown[]) =>
  t.request('/v1/schema/changes', { key: keys.admin, body: { operations } });

describe('saved views', () => {
  it('saves a table view by field name and reads it back', async () => {
    const res = await create({
      name: 'Big open deals',
      kind: 'table',
      filter: { and: [{ stage: { neq: 'lost' } }, { amount: { gte: 1_000_000_000 } }] },
      sort: [{ field: 'closeDate', direction: 'desc' }],
      columns: {
        order: ['stage', 'amount'],
        widths: { amount: 160 },
        aggregates: { amount: 'sum' },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: 'deal',
      name: 'Big open deals',
      kind: 'table',
      visibility: 'workspace',
      filter: { and: [{ stage: { neq: 'lost' } }, { amount: { gte: 1_000_000_000 } }] },
      sort: [{ field: 'closeDate', direction: 'desc' }],
      columns: {
        order: ['stage', 'amount'],
        widths: { amount: 160 },
        aggregates: { amount: 'sum' },
      },
      groupBy: null,
      hiddenGroups: [],
      dateField: null,
      createdBy: { type: 'user', id: 'dana' },
      issues: [],
    });

    const fetched = await t.request(`/v1/views/${res.body.id}`, { key: keys.reader });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(res.body);
    expect((await list(keys.reader)).map((v) => v.id)).toContain(res.body.id);
  });

  it('lists views in their saved order, new ones last', async () => {
    const a = await create({ name: 'A', kind: 'table' }, keys.dana, 'company');
    const b = await create({ name: 'B', kind: 'table' }, keys.dana, 'company');
    expect(b.body.position).toBeGreaterThan(a.body.position);
    await patch(b.body.id, { position: a.body.position - 1 });
    expect((await list(keys.dana, 'company')).map((v) => v.id)).toEqual([b.body.id, a.body.id]);
  });

  it('saves boards and calendars with the field they need', async () => {
    const board = await create({
      name: 'Pipeline',
      kind: 'board',
      groupBy: 'stage',
      hiddenGroups: ['lost', null],
      groupAggregate: { field: 'amount', op: 'sum' },
    });
    expect(board.status).toBe(201);
    expect(board.body).toMatchObject({
      groupBy: 'stage',
      hiddenGroups: ['lost', null],
      groupAggregate: { field: 'amount', op: 'sum' },
    });
    const calendar = await create({ name: 'Closing', kind: 'calendar', dateField: 'closeDate' });
    expect(calendar.status).toBe(201);
    expect(calendar.body.dateField).toBe('closeDate');
  });

  it('rejects views that would not run', async () => {
    const cases: [unknown, string][] = [
      [{ name: 'No group', kind: 'board' }, 'invalid_view'],
      [{ name: 'Text group', kind: 'board', groupBy: 'name' }, 'invalid_view'],
      [{ name: 'No date', kind: 'calendar' }, 'invalid_view'],
      [{ name: 'Not a date', kind: 'calendar', dateField: 'amount' }, 'invalid_view'],
      [{ name: 'Unknown', kind: 'table', columns: { order: ['nope'] } }, 'invalid_view'],
      [{ name: 'Twice', kind: 'table', columns: { order: ['stage', 'stage'] } }, 'invalid_view'],
      [
        { name: 'Bad op', kind: 'table', columns: { order: [], aggregates: { name: 'sum' } } },
        'invalid_view',
      ],
      [{ name: 'Bad filter', kind: 'table', filter: { stage: { gt: 'won' } } }, 'invalid_filter'],
      [{ name: 'Bad sort', kind: 'table', sort: [{ field: 'company' }] }, 'invalid_filter'],
    ];
    for (const [body, code] of cases) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe(code);
    }
    expect((await create({ name: '', kind: 'table' })).status).toBe(400);
    expect((await create({ name: 'X', kind: 'gantt' })).status).toBe(400);
  });

  it('changes only the keys a PATCH gives, and null clears one', async () => {
    const view = await create({
      name: 'Mine',
      kind: 'table',
      filter: { stage: 'won' },
      sort: [{ field: 'createdAt', direction: 'desc' }],
    });
    const renamed = await patch(view.body.id, { name: 'Won deals', filter: null });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      name: 'Won deals',
      filter: null,
      sort: [{ field: 'createdAt', direction: 'desc' }],
      updatedBy: { type: 'user', id: 'dana' },
    });
    // A table can become a board once it has a group field.
    expect((await patch(view.body.id, { kind: 'board' })).status).toBe(422);
    const board = await patch(view.body.id, { kind: 'board', groupBy: 'stage' }, keys.omer);
    expect(board.body).toMatchObject({ kind: 'board', groupBy: 'stage' });
    expect(board.body.updatedBy).toEqual({ type: 'user', id: 'omer' });
    expect((await patch(view.body.id, { groupBy: null })).status).toBe(422);
  });

  it('serializes updates, so two at once to different settings both land', async () => {
    const view = await create({ name: 'Busy', kind: 'table' });
    const updates = Array.from({ length: 6 }, (_, i) =>
      i % 2
        ? patch(view.body.id, { columns: { order: ['stage'], widths: { stage: 100 + i } } })
        : patch(view.body.id, { sort: [{ field: 'name', direction: 'asc' }] }),
    );
    const results = await Promise.all(updates);
    expect(results.map((r) => r.status)).toEqual(Array(6).fill(200));
    const final = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(final.body.sort).toEqual([{ field: 'name', direction: 'asc' }]);
    expect(final.body.columns.order).toEqual(['stage']);
  });

  it('keeps private views to the actor that made them', async () => {
    const mine = await create({ name: 'Just me', kind: 'table', visibility: 'private' });
    expect(mine.status).toBe(201);
    expect((await list(keys.dana)).map((v) => v.id)).toContain(mine.body.id);
    expect((await list(keys.omer)).map((v) => v.id)).not.toContain(mine.body.id);
    expect((await t.request(`/v1/views/${mine.body.id}`, { key: keys.omer })).status).toBe(404);
    expect((await patch(mine.body.id, { name: 'Hijacked' }, keys.omer)).status).toBe(404);
    expect(
      (await t.request(`/v1/views/${mine.body.id}`, { key: keys.omer, method: 'DELETE' })).status,
    ).toBe(404);

    // Only the creator decides who sees a view.
    const shared = await create({ name: 'Team', kind: 'table' });
    const res = await patch(shared.body.id, { visibility: 'private' }, keys.omer);
    expect(res.status).toBe(403);
    expect((await patch(shared.body.id, { visibility: 'private' })).body.visibility).toBe(
      'private',
    );
  });

  it('needs write to change views, and stays in its workspace', async () => {
    expect((await create({ name: 'Nope', kind: 'table' }, keys.reader)).status).toBe(403);
    const view = await create({ name: 'Ours', kind: 'table' });
    expect((await patch(view.body.id, { name: 'Read only' }, keys.reader)).status).toBe(403);
    expect((await t.request(`/v1/views/${view.body.id}`, { key: otherKey })).status).toBe(404);
    expect((await list(otherKey)).map((v) => v.id)).not.toContain(view.body.id);
    // Agents can save views too; the actor is theirs.
    const agents = await create({ name: 'Agent view', kind: 'table' }, keys.agent);
    expect(agents.body.createdBy).toEqual({ type: 'agent', id: 'inbox' });
  });

  it('deletes a view', async () => {
    const view = await create({ name: 'Gone soon', kind: 'table' });
    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana, method: 'DELETE' });
    expect(res.body).toEqual({ id: view.body.id, deleted: true });
    expect((await t.request(`/v1/views/${view.body.id}`, { key: keys.dana })).status).toBe(404);
    expect((await t.request('/v1/views/not-an-id', { key: keys.dana })).status).toBe(404);
  });
});

describe('views across schema changes', () => {
  it('follows a renamed field, because it stores keys', async () => {
    const created = await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'region', label: 'Region', type: 'text' },
      },
    ]);
    expect(created.status).toBe(200);
    const view = await create({
      name: 'By region',
      kind: 'table',
      filter: { region: { contains: 'EU' } },
      columns: { order: ['region'] },
    });
    expect(
      (await schemaChange([{ op: 'rename_field', object: 'deal', field: 'region', name: 'area' }]))
        .status,
    ).toBe(200);
    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(res.body).toMatchObject({
      filter: { area: { contains: 'EU' } },
      columns: { order: ['area'] },
      issues: [],
    });
  });

  // The schema change rewrites the stored view in its own transaction, so a
  // read after it includes the repair notice, and the
  // view was last updated by whoever changed the schema.
  const repaired = {
    issues: expect.arrayContaining([expect.any(String)]),
    updatedBy: { type: 'user', id: 'root' },
  };

  it('drops references to a removed field when the field is removed', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: {
          name: 'priority',
          label: 'Priority',
          type: 'select',
          settings: {
            options: [
              { value: 'high', label: 'High' },
              { value: 'low', label: 'Low' },
            ],
          },
        },
      },
    ]);
    const view = await create({
      name: 'By priority',
      kind: 'board',
      groupBy: 'priority',
      filter: { or: [{ priority: 'high' }, { stage: 'won' }], not: { priority: 'low' } },
      sort: [{ field: 'priority', direction: 'asc' }],
      columns: { order: ['priority', 'stage'], widths: { priority: 120 } },
    });
    expect(view.status).toBe(201);
    expect(
      (await schemaChange([{ op: 'delete_field', object: 'deal', field: 'priority' }])).status,
    ).toBe(200);

    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'board',
      groupBy: null,
      // The `or` keeps its other branch; the emptied `not` goes, rather than
      // turning into "not (true)".
      filter: { or: [{ stage: 'won' }] },
      sort: null,
      columns: { order: ['stage'], widths: {} },
      ...repaired,
    });
    // The view still runs as a query.
    const query = await t.request('/v1/objects/deal/query', {
      key: keys.dana,
      body: { view: view.body.id },
    });
    expect(query.status).toBe(200);
    expect(query.body.issues).toEqual(res.body.issues);
    // It can still be renamed; choosing a new group field fixes it.
    expect((await patch(view.body.id, { name: 'Renamed' })).body.issues).toEqual([]);
    expect((await patch(view.body.id, { groupBy: 'stage' })).body.groupBy).toBe('stage');
  });

  it('drops a board or calendar field that can no longer be used for it', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: {
          name: 'tier',
          label: 'Tier',
          type: 'select',
          settings: { options: [{ value: 'gold', label: 'Gold' }] },
        },
      },
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'renewsOn', label: 'Renews on', type: 'date' },
      },
    ]);
    const board = await create({ name: 'By tier', kind: 'board', groupBy: 'tier' });
    const calendar = await create({ name: 'Renewals', kind: 'calendar', dateField: 'renewsOn' });
    expect(
      (
        await schemaChange([
          { op: 'update_field', object: 'deal', field: 'tier', isFilterable: false },
          { op: 'update_field', object: 'deal', field: 'renewsOn', isFilterable: false },
        ])
      ).status,
    ).toBe(200);

    const read = async (id: string) =>
      (await t.request(`/v1/views/${id}`, { key: keys.dana })).body;
    // The views stay, waiting for a new field, rather than being deleted.
    expect(await read(board.body.id)).toMatchObject({ kind: 'board', groupBy: null, ...repaired });
    expect(await read(calendar.body.id)).toMatchObject({
      kind: 'calendar',
      dateField: null,
      ...repaired,
    });
  });

  it('drops conditions and sorts that no longer compile', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'source', label: 'Source', type: 'text' },
      },
    ]);
    const view = await create({
      name: 'From referrals',
      kind: 'table',
      filter: { and: [{ source: { eq: 'referral' } }, { stage: { neq: 'lost' } }] },
      sort: [{ field: 'source', direction: 'asc' }],
    });
    expect(view.status).toBe(201);
    // The field stays, but can no longer be filtered or sorted by.
    expect(
      (
        await schemaChange([
          { op: 'update_field', object: 'deal', field: 'source', isFilterable: false },
        ])
      ).status,
    ).toBe(200);

    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      filter: { and: [{ stage: { neq: 'lost' } }] },
      sort: null,
      ...repaired,
    });
    // What is left still runs as a query.
    const query = await t.request('/v1/objects/deal/query', {
      key: keys.dana,
      body: { filter: res.body.filter },
    });
    expect(query.status).toBe(200);
  });

  it('drops a removed option from filters and hidden columns', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: {
          name: 'segment',
          label: 'Segment',
          type: 'select',
          settings: {
            options: [
              { value: 'smb', label: 'SMB' },
              { value: 'mid', label: 'Mid-market' },
              { value: 'ent', label: 'Enterprise' },
            ],
          },
        },
      },
    ]);
    const board = await create({
      name: 'By segment',
      kind: 'board',
      groupBy: 'segment',
      hiddenGroups: ['mid', null],
      filter: { or: [{ segment: { in: ['smb', 'mid'] } }, { segment: { eq: 'mid' } }] },
    });
    expect(board.status).toBe(201);
    // No record holds "mid", so the engine lets it go.
    expect(
      (
        await schemaChange([
          { op: 'remove_option', object: 'deal', field: 'segment', value: 'mid' },
        ])
      ).status,
    ).toBe(200);

    const res = await t.request(`/v1/views/${board.body.id}`, { key: keys.dana });
    expect(res.body).toMatchObject({
      groupBy: 'segment',
      hiddenGroups: [null],
      // `in` keeps the options left; a condition naming only "mid" goes.
      filter: { or: [{ segment: { in: ['smb'] } }] },
      ...repaired,
    });
  });

  it('deletes the views of a deleted object', async () => {
    const created = await schemaChange([
      {
        op: 'create_object',
        object: {
          nameSingular: 'ticket',
          namePlural: 'tickets',
          labelSingular: 'Ticket',
          labelPlural: 'Tickets',
          labelField: 'title',
          fields: [{ name: 'title', label: 'Title', type: 'text' }],
        },
      },
    ]);
    expect(created.body.status).toBe('applied');
    const view = await create({ name: 'Open tickets', kind: 'table' }, keys.dana, 'ticket');
    expect(view.status).toBe(201);
    expect((await schemaChange([{ op: 'delete_object', object: 'ticket' }])).status).toBe(200);
    expect((await t.request(`/v1/views/${view.body.id}`, { key: keys.dana })).status).toBe(404);
    const [row] = await db.owner`select count(*)::int as n from views where id = ${view.body.id}`;
    expect(row?.n).toBe(0);
  });

  it('leaves views alone when a change gives them nothing to repair', async () => {
    const view = await create({
      name: 'Open deals',
      kind: 'table',
      filter: { stage: { neq: 'lost' } },
    });
    await schemaChange([
      {
        op: 'create_field',
        object: 'deal',
        field: { name: 'notes2', label: 'Side notes', type: 'text' },
      },
    ]);
    await schemaChange([{ op: 'delete_field', object: 'deal', field: 'notes2' }]);
    const res = await t.request(`/v1/views/${view.body.id}`, { key: keys.dana });
    expect(res.body).toMatchObject({
      updatedBy: { type: 'user', id: 'dana' },
      updatedAt: view.body.updatedAt,
    });
  });
});

describe('agent view drafts and saved reads', () => {
  it('checks a live draft without creating a view and refuses sharing settings', async () => {
    const existing = await list();
    const deal = 'Draft preview renewal';
    await t.request('/v1/objects/deal/records', {
      key: keys.dana,
      body: { values: { name: deal, stage: 'proposal' } },
    });
    const draft = {
      object: 'deal',
      name: 'Renewals',
      description: 'Review proposals',
      kind: 'table',
      groupBy: 'stage',
      search: deal,
      hideEmptyGroups: true,
    };
    const check = (body: unknown) =>
      t.request('/v1/objects/deal/views/check', { key: keys.reader, body });
    expect((await check(draft)).body).toMatchObject({
      ok: true,
      count: 1,
      groups: [{ value: 'proposal', total: 1 }],
    });
    expect((await check({ ...draft, visibility: 'workspace' })).body).toMatchObject({
      ok: false,
      problems: [{ path: 'draft' }],
    });
    expect((await check({ ...draft, granularity: 'month' })).body).toMatchObject({
      ok: false,
      problems: [{ path: 'granularity' }],
    });
    expect(await list()).toEqual(existing);
  });

  it('runs a saved view and applies additional filter and search without hiding groups', async () => {
    for (const [name, stage] of [
      ['North unique renewal priority', 'proposal'],
      ['North unique renewal warm', 'proposal'],
      ['North unique renewal priority lost', 'lost'],
      ['South unique priority', 'proposal'],
    ]) {
      const made = await t.request('/v1/objects/deal/records', {
        key: keys.dana,
        body: { values: { name, stage } },
      });
      expect(made.status).toBe(201);
    }
    const kept = await create({
      name: 'North renewals',
      description: 'Sales review',
      kind: 'table',
      search: 'north unique renewal',
      groupBy: 'stage',
      hiddenGroups: ['proposal'],
      groupAggregate: { field: 'name', op: 'countNotEmpty' },
      filter: { stage: { neq: 'lost' } },
      sort: [{ field: 'name', direction: 'desc' }],
    });
    expect(kept.status).toBe(201);
    const id = kept.body.id;
    const mcp = await t.mcpClient(keys.reader);
    try {
      expect((await mcp.call('list_views', { object: 'deal' })).body).toMatchObject({
        views: expect.arrayContaining([
          expect.objectContaining({ id, description: 'Sales review' }),
        ]),
      });
      expect((await mcp.call('check_view', { draft: { view: id } })).body).toMatchObject({
        ok: true,
        count: 2,
      });
      expect((await mcp.call('query_records', { view: id })).body).toMatchObject({
        records: [
          { label: 'North unique renewal warm' },
          { label: 'North unique renewal priority' },
        ],
      });
      expect(
        (
          await mcp.call('aggregate_records', {
            view: id,
            search: 'priority',
            filter: { stage: 'proposal' },
          })
        ).body,
      ).toMatchObject({
        total: 1,
        groups: [{ value: 'proposal', values: [{ op: 'countNotEmpty', value: 1 }] }],
      });
    } finally {
      await mcp.close();
    }
    const empty = await t.request('/v1/objects/deal/query', {
      key: keys.reader,
      body: { view: id, filter: { stage: 'lost' } },
    });
    expect(empty.body.records).toEqual([]);
  });

  it('accepts exactly one of two concurrent updates against the same revision', async () => {
    const kept = await create({ name: 'Concurrent changes', kind: 'table' });
    const id = kept.body.id;
    const results = await Promise.all(
      ['first', 'second'].map((description) =>
        patch(id, { description, expectedUpdatedAt: kept.body.updatedAt }),
      ),
    );
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    const current = await t.request(`/v1/views/${id}`, { key: keys.dana });
    expect(current.body.description).toBe(
      results.find(({ status }) => status === 200)?.body.description,
    );
  });

  it('pages sparse dates without losing records past the group limit', async () => {
    const fixture = await t.setupWorkspace(
      { name: 'Grouped dates', template: 'sales' },
      {
        writer: { actor: { type: 'user', id: 'grouped-dates' }, scopes: ['write', 'read'] },
      },
    );
    const key = fixture.keys.writer;
    const dates = Array.from({ length: 52 }, (_, index) =>
      new Date(Date.UTC(2020, index, 1)).toISOString().slice(0, 10),
    );
    const newest = dates.at(-1);
    const rows = [...dates, ...Array.from({ length: 25 }, () => newest)];
    const items = rows.map((closeDate, index) => ({
      object: 'deal',
      values: { name: `Group example ${index}`, closeDate },
    }));
    for (const batch of [items.slice(0, 50), items.slice(50)]) {
      const seed = await t.request('/v1/records/upsert', { key, body: { items: batch } });
      expect(seed.status, JSON.stringify(seed.body).slice(0, 400)).toBe(200);
    }
    const call = (action: 'query' | 'aggregate', body: unknown) =>
      t.request(`/v1/objects/deal/${action}`, { key, body });
    const grouped = await call('aggregate', {
      groupBy: 'closeDate',
      granularity: 'day',
      viewGroups: {},
    });
    expect(grouped.status).toBe(200);
    expect(grouped.body.groups).toHaveLength(51);
    expect(grouped.body.groups.at(-1)).toMatchObject({ label: 'Earlier', total: 2 });
    expect(
      grouped.body.groups.reduce(
        (total: number, group: { total: number }) => total + group.total,
        0,
      ),
    ).toBe(rows.length);
    const first = await call('query', { groupMatch: grouped.body.groups[0].match, limit: 25 });
    expect(first.body.records).toHaveLength(25);
    expect(
      (
        await call('query', {
          groupMatch: grouped.body.groups[0].match,
          cursor: first.body.nextCursor,
          limit: 25,
        })
      ).body.records,
    ).toHaveLength(1);
    const earlier = await call('query', { groupMatch: grouped.body.groups.at(-1).match });
    expect(
      earlier.body.records
        .map((record: { fields: { closeDate: string } }) => record.fields.closeDate)
        .sort(),
    ).toEqual(dates.slice(0, 2));
  });
});

it('groups by a single relation, pages by group, and removes deleted targets from hidden groups', async () => {
  const company = async (name: string) =>
    (
      await t.request('/v1/objects/company/records', {
        key: keys.dana,
        body: { values: { name } },
      })
    ).body.id as string;
  const [one, two] = await Promise.all([company('Relation One'), company('Relation Two')]);
  for (const [name, company] of [
    ['Grouped relationship A', one],
    ['Grouped relationship B', two],
  ]) {
    expect(
      (
        await t.request('/v1/objects/deal/records', {
          key: keys.dana,
          body: { values: { name, company } },
        })
      ).status,
    ).toBe(201);
  }
  const kept = await create({
    name: 'Relation board',
    kind: 'board',
    groupBy: 'company',
    hiddenGroups: [two],
  });
  expect(kept.status, JSON.stringify(kept.body)).toBe(201);
  const grouped = await t.request('/v1/objects/deal/aggregate', {
    key: keys.reader,
    body: { search: 'Grouped relationship', groupBy: 'company', viewGroups: { hidden: [two] } },
  });
  expect(grouped.body).toMatchObject({
    total: 2,
    groups: [{ value: one, total: 1, label: 'Relation One' }],
  });
  const page = await t.request('/v1/objects/deal/query', {
    key: keys.reader,
    body: { groupMatch: grouped.body.groups[0].match },
  });
  expect(page.body.records).toMatchObject([{ label: 'Grouped relationship A' }]);
  expect((await t.request(`/v1/records/${two}`, { key: keys.dana, method: 'DELETE' })).status).toBe(
    200,
  );
  expect(
    (await t.request(`/v1/views/${kept.body.id}`, { key: keys.dana })).body.hiddenGroups,
  ).toEqual([]);
  expect((await patch(kept.body.id, { hiddenGroups: [two] })).status).toBe(422);
});

it('uses relative dates in queries, aggregates and a saved view', async () => {
  const {
    workspace,
    keys: { writer },
  } = await t.setupWorkspace(
    { name: 'Date filters', template: 'sales' },
    {
      writer: { actor: { type: 'user', id: 'relative-view-dates' }, scopes: ['write', 'read'] },
    },
  );
  const [dates] =
    await db.owner`select current_date::text as today, (current_date-2)::text as past`;
  await db.owner`update workspaces set settings='{"timeZone":"UTC"}' where id=${workspace.id}`;
  const send = (route: string, body: unknown) =>
    t.request(`/v1/objects/deal/${route}`, { key: writer, body });
  for (const [name, closeDate] of [
    ['Current deal', dates?.today],
    ['Old deal', dates?.past],
  ])
    expect((await send('records', { values: { name, closeDate } })).status).toBe(201);
  const today = { closeDate: { within: 'today' } };
  expect((await send('query', { filter: today })).body.records).toMatchObject([
    { label: 'Current deal' },
  ]);
  expect((await send('aggregate', { filter: { closeDate: { lt: 'today' } } })).body.total).toBe(1);
  const view = await send('views', { name: 'Current closes', kind: 'table', filter: today });
  expect(view.status).toBe(201);
  expect((await send('query', { view: view.body.id })).body.records).toMatchObject([
    { label: 'Current deal' },
  ]);
  expect(
    (
      await send('aggregate', {
        view: view.body.id,
        filter: { createdAt: { within: { last: 1, unit: 'day' } } },
      })
    ).body.total,
  ).toBe(1);
  for (const value of [
    { last: 1001, unit: 'day' },
    { last: 1, next: 1, unit: 'day' },
    'since_today',
  ])
    expect((await send('query', { filter: { closeDate: { within: value } } })).status).toBe(422);
});
