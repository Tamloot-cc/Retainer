import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'reader' | 'user', string>;
let otherKey: string;
let acme: string;
let globex: string;

beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write', 'schema:write'] },
      reader: { actor: { type: 'user', id: 'viewer' }, scopes: ['read'] },
      user: { actor: { type: 'user', id: 'dana' }, scopes: ['read', 'write'] },
    },
  ));
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
      groups: [{ value: null, total: 1, values: [] }],
    });

    // The filter applies to every group, and no match still has a total.
    const none = await aggregate('deal', { groupBy: 'stage', filter: { name: 'Nothing' } });
    expect(none.body).toEqual({ total: 0, values: [], groups: [] });

    const bad = await aggregate('deal', { groupBy: 'name' });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'invalid_aggregate', details: { field: 'name' } });
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
