import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'reader' | 'user', string>;
let otherKey: string;
let workspaceId: string;
let acme: string;
let globex: string;

beforeAll(async () => {
  t = startTestApp(db);
  const setup = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write', 'schema:write'] },
      reader: { actor: { type: 'user', id: 'viewer' }, scopes: ['read'] },
      user: { actor: { type: 'user', id: 'dana' }, scopes: ['read', 'write'] },
    },
  );
  keys = setup.keys;
  workspaceId = setup.workspace.id;
  otherKey = (
    await t.setupWorkspace(
      { name: 'Other', template: 'sales' },
      { agent: { actor: { type: 'agent', id: 'other' }, scopes: ['read'] } },
    )
  ).keys.agent;
  acme = await create('company', { name: 'Acme', employeeCount: 120 });
  globex = await create('company', { name: 'Globex', employeeCount: 30 });
  await create('company', { name: 'Initech' });
  const usd = (n: number) => ({ amountMicros: n * 1_000_000, currency: 'USD' });
  await create('deal', {
    name: 'Renewal',
    stage: 'won',
    amount: usd(100),
    closeDate: '2026-03-01',
    company: acme,
  });
  await create('deal', {
    name: 'Upsell',
    stage: 'won',
    amount: usd(300),
    closeDate: '2026-05-15',
    company: acme,
  });
  await create('deal', { name: 'Pilot', stage: 'lead', amount: usd(50), company: globex });
  await create('deal', { name: 'Unsized', stage: 'lead' });
});

async function create(object: string, values: Record<string, unknown>) {
  const res = await t.request(`/v1/objects/${object}/records`, {
    key: keys.agent,
    body: { values },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}
const aggregate = (object: string, body: unknown, key = keys.reader) =>
  t.request(`/v1/objects/${object}/aggregate`, { key, body });

describe('POST /v1/objects/:object/aggregate', () => {
  it('counts the records a filter and search match', async () => {
    expect((await aggregate('deal', {})).body).toEqual({ total: 4, values: [] });
    expect((await aggregate('deal', { filter: { stage: 'won' } })).body.total).toBe(2);
    expect((await aggregate('company', { search: 'globex' })).body.total).toBe(1);
  });

  it('computes emptiness, unique counts and number totals', async () => {
    const res = await aggregate('company', {
      aggregates: [
        { field: 'employeeCount', op: 'countEmpty' },
        { field: 'employeeCount', op: 'percentNotEmpty' },
        { field: 'employeeCount', op: 'sum' },
        { field: 'employeeCount', op: 'avg' },
        { field: 'employeeCount', op: 'max' },
        { field: 'name', op: 'countUnique' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.values.map((v: { value: unknown }) => v.value)).toEqual([
      1,
      (2 / 3) * 100,
      150,
      75,
      120,
      3,
    ]);
  });

  it('adds money in one currency, and returns dates as dates', async () => {
    const res = await aggregate('deal', {
      filter: { stage: 'won' },
      aggregates: [
        { field: 'amount', op: 'sum' },
        { field: 'amount', op: 'avg' },
        { field: 'closeDate', op: 'min' },
        { field: 'closeDate', op: 'max' },
        { field: 'company', op: 'countUnique' },
        { field: 'company', op: 'countEmpty' },
      ],
    });
    expect(res.body.values).toEqual([
      { field: 'amount', op: 'sum', value: { amountMicros: 400_000_000, currency: 'USD' } },
      { field: 'amount', op: 'avg', value: { amountMicros: 200_000_000, currency: 'USD' } },
      { field: 'closeDate', op: 'min', value: '2026-03-01' },
      { field: 'closeDate', op: 'max', value: '2026-05-15' },
      { field: 'company', op: 'countUnique', value: 1 },
      { field: 'company', op: 'countEmpty', value: 0 },
    ]);
    // The same counts as the isNull filter, over every deal.
    const all = await aggregate('deal', { aggregates: [{ field: 'company', op: 'countEmpty' }] });
    const emptyFilter = await aggregate('deal', { filter: { company: { isNull: true } } });
    expect(all.body.values[0].value).toBe(emptyFilter.body.total);
  });

  it('counts distinct money values across currencies while refusing to add them up', async () => {
    await create('deal', {
      name: 'Euro deal',
      stage: 'won',
      amount: { amountMicros: 50_000_000, currency: 'EUR' },
    });
    await create('deal', {
      name: 'Another Euro deal',
      amount: { amountMicros: 50_000_000, currency: 'EUR' },
    });
    const res = await aggregate('deal', {
      aggregates: [
        { field: 'amount', op: 'sum' },
        { field: 'amount', op: 'countUnique' },
      ],
    });
    expect(res.body.values).toEqual([
      { field: 'amount', op: 'sum', value: null, mixedCurrencies: true },
      { field: 'amount', op: 'countUnique', value: 4 },
    ]);
  });

  it('names the field and the allowed operations on a bad request', async () => {
    const wrongOp = await aggregate('company', { aggregates: [{ field: 'name', op: 'sum' }] });
    expect(wrongOp.status).toBe(422);
    expect(wrongOp.body.error).toMatchObject({
      code: 'invalid_aggregate',
      details: { field: 'name', allowed: expect.arrayContaining(['countEmpty', 'countUnique']) },
    });
    const inverse = await aggregate('company', {
      aggregates: [{ field: 'deals', op: 'countEmpty' }],
    });
    expect(inverse.status).toBe(422);
    const unknown = await aggregate('company', {
      aggregates: [{ field: 'nope', op: 'countEmpty' }],
    });
    expect(unknown.body.error.code).toBe('invalid_aggregate');
    const badFilter = await aggregate('company', { filter: { nope: 1 } });
    expect(badFilter.body.error.code).toBe('invalid_filter');
  });

  it('splits the total and aggregates by a select field with groupBy', async () => {
    const sum = { field: 'amount', op: 'sum' } as const;
    const res = await aggregate('deal', {
      groupBy: 'stage',
      aggregates: [sum],
      filter: { name: { in: ['Renewal', 'Upsell', 'Pilot', 'Unsized'] } },
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    const byValue = Object.fromEntries(
      res.body.groups.map((g: { value: string; total: number; values: { value: unknown }[] }) => [
        g.value,
        { total: g.total, sum: g.values[0]?.value },
      ]),
    );
    expect(byValue).toEqual({
      won: { total: 2, sum: { amountMicros: 400_000_000, currency: 'USD' } },
      lead: { total: 2, sum: { amountMicros: 50_000_000, currency: 'USD' } },
    });

    // Records without a value are their own group, `null`.
    await create('deal', { name: 'Unstaged' });
    const withEmpty = await aggregate('deal', { groupBy: 'stage', filter: { name: 'Unstaged' } });
    expect(withEmpty.body).toEqual({
      total: 1,
      values: [],
      groups: [{ value: null, label: 'No value', total: 1, values: [] }],
    });

    // The filter applies to every group, and no match still has a total.
    const none = await aggregate('deal', { groupBy: 'stage', filter: { name: 'Nothing' } });
    expect(none.body).toEqual({ total: 0, values: [], groups: [] });

    const bad = await aggregate('deal', { groupBy: 'name' });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'invalid_aggregate', details: { field: 'name' } });
  });

  it('groups by dates with gaps and returns the latest periods at the limit', async () => {
    const input = {
      groupBy: 'closeDate',
      filter: { stage: 'won', closeDate: { isNull: false } },
      aggregates: [{ field: 'amount', op: 'sum', as: 'pipeline' }],
    };
    const monthly = await aggregate('deal', input);
    expect(monthly.status, JSON.stringify(monthly.body)).toBe(200);
    expect(monthly.body.groups).toMatchObject([
      {
        value: '2026-03-01',
        label: 'Mar 2026',
        total: 1,
        values: [{ as: 'pipeline', value: { amountMicros: 100_000_000, currency: 'USD' } }],
      },
      {
        value: '2026-04-01',
        label: 'Apr 2026',
        total: 0,
        values: [{ as: 'pipeline', value: { amountMicros: 0, currency: 'USD' } }],
      },
      { value: '2026-05-01', label: 'May 2026', total: 1 },
    ]);
    const limited = await aggregate('deal', { ...input, limit: 2 });
    expect(limited.body).toMatchObject({
      total: 2,
      tooManyGroups: true,
      groups: [{ value: '2026-04-01' }, { value: '2026-05-01' }],
    });
    const capped = await aggregate('deal', { ...input, granularity: 'day' });
    expect(capped.body.tooManyGroups).toBe(true);
    expect(capped.body.groups).toHaveLength(50);
    expect(capped.body.groups.at(-1).value).toBe('2026-05-15');
  });

  it('uses the workspace zone and Monday weeks for built-in record and event dates', async () => {
    await db.owner`update workspaces set settings = settings || '{"timeZone":"Asia/Jerusalem"}'::jsonb where id = ${workspaceId}`;
    const time = '2026-10-04T22:30:00Z'; // Monday locally.
    const company = await create('company', { name: 'Timezone Fixture' });
    await db.owner`update records set created_at = ${time} where id = ${company}`;
    const created = await aggregate('company', {
      groupBy: 'createdAt',
      granularity: 'week',
      filter: { id: company },
    });
    expect(created.body).toMatchObject({ groups: [{ value: '2026-10-05', total: 1 }] });
    expect(
      (
        await t.request('/v1/events', {
          key: keys.agent,
          body: {
            type: 'conversation',
            channel: 'calendar',
            externalId: 'timezone-fixture',
            title: 'Timezone Fixture',
            occurredAt: time,
          },
        })
      ).status,
    ).toBe(201);
    for (const object of ['conversation', 'event']) {
      const events = await aggregate(object, { groupBy: 'occurredAt', granularity: 'week' });
      expect(events.status, JSON.stringify(events.body)).toBe(200);
      expect(events.body).toMatchObject({ groups: [{ value: '2026-10-05', total: 1 }] });
    }
  });

  it('keeps the biggest relation groups and uses the related record labels', async () => {
    const res = await aggregate('deal', {
      groupBy: 'company',
      limit: 1,
      filter: { name: { in: ['Renewal', 'Upsell', 'Pilot'] } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      total: 3,
      tooManyGroups: true,
      groups: [{ value: acme, label: 'Acme', total: 2 }],
    });
    expect((await aggregate('company', { groupBy: 'deals' })).status).toBe(422);
  });

  it('sees only its own workspace', async () => {
    const res = await aggregate('company', {}, otherKey);
    expect(res.body.total).toBe(0);
  });
});

describe('POST /v1/records/delete-impact', () => {
  it('counts what deleting several records would take with them, once each', async () => {
    const change = await t.request('/v1/schema/changes', {
      key: keys.agent,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'person',
            field: {
              name: 'employer',
              label: 'Employer',
              type: 'relation',
              settings: { targetObject: 'company', inverseField: 'staff', onDelete: 'cascade' },
            },
          },
        ],
      },
    });
    expect(change.body).toMatchObject({ status: 'applied' });
    const one = await create('company', { name: 'One' });
    const two = await create('company', { name: 'Two' });
    await create('person', { name: 'Dana', employer: one });
    await create('person', { name: 'Avi', employer: two });
    await create('person', { name: 'Noa', employer: two });

    const res = await t.request('/v1/records/delete-impact', {
      key: keys.reader,
      body: { ids: [one, two, one] },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [one, two], records: [{ object: 'person', count: 3 }] });

    const missing = await t.request('/v1/records/delete-impact', {
      key: otherKey,
      body: { ids: [one] },
    });
    expect(missing.status).toBe(404);

    // A merged-away ID counts as the record it was merged into, once.
    const twin = await create('company', { name: 'Two (duplicate)' });
    const merge = await t.request(`/v1/records/${two}/merge`, {
      key: keys.user,
      body: { recordId: twin },
    });
    expect(merge.status).toBe(200);
    const merged = await t.request('/v1/records/delete-impact', {
      key: keys.reader,
      body: { ids: [twin, two] },
    });
    expect(merged.body).toEqual({ ids: [two], records: [{ object: 'person', count: 2 }] });

    const del = await t.request(`/v1/records/${one}`, { key: keys.user, method: 'DELETE' });
    expect(del.status).toBe(200);
    const deleted = await t.request('/v1/records/delete-impact', {
      key: keys.reader,
      body: { ids: [two, one] },
    });
    expect(deleted.status).toBe(404);
    expect(deleted.body.error.code).toBe('record_deleted');
  });
});
