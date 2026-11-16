import type { FieldView, ObjectView } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import { clampWidth, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from '../../ui/data-grid.js';
import {
  addClause,
  aggregateLabel,
  columnsKey,
  describeClause,
  encodeFilter,
  type FilterClause,
  formatAggregate,
  isSortable,
  loadColumnPrefs,
  loadRowDensity,
  moveColumn,
  nextSort,
  operatorLabel,
  pageRange,
  parseListSearch,
  recordNextPage,
  resolveColumns,
  saveRowDensity,
  setColumnVisible,
  shiftColumn,
  shownColumnPrefs,
} from './list-state.js';

const field = (name: string, extra: Partial<FieldView> = {}) =>
  ({
    name,
    label: name[0]?.toUpperCase() + name.slice(1),
    type: 'text',
    readOnly: false,
    settings: {},
    ...extra,
  }) as FieldView;
const object = {
  nameSingular: 'person',
  labelField: 'name',
  fields: [
    field('name'),
    field('email'),
    field('metadata', { type: 'json' }),
    field('company'),
    field('employees', { readOnly: true }),
  ],
} as unknown as ObjectView;
const storage = (items: Record<string, string>) => () => ({
  getItem: (k: string) => items[k] ?? null,
});

const parseFilter = (filter: string | undefined) => parseListSearch({ filter });
const encodeClauses = (clauses: FilterClause[]) => encodeFilter({ clauses, custom: [] });
const parseSort = (sort: string | undefined) => parseListSearch({ sort }).sort;

describe('columns', () => {
  it('pins the label first and hides json and read-only fields by default', () => {
    expect(resolveColumns(object, undefined).map((f) => f.name)).toEqual([
      'name',
      'email',
      'company',
    ]);
  });

  it('follows the saved order and drops fields that left the schema', () => {
    const prefs = { order: ['company', 'gone', 'name', 'email', 'company'], widths: {} };
    expect(resolveColumns(object, prefs).map((f) => f.name)).toEqual(['name', 'company', 'email']);
  });

  it('keeps only what the grid shows of preferences that name removed fields', () => {
    const prefs = {
      order: ['company', 'gone', 'email', 'company'],
      widths: { name: 200, gone: 300 },
      aggregates: { email: 'countUnique' as const, gone: 'sum' as const, company: 'sum' as const },
    };
    expect(shownColumnPrefs(object, prefs)).toEqual({
      order: ['company', 'email'],
      widths: { name: 200 },
      aggregates: { email: 'countUnique' },
    });
    expect(shownColumnPrefs(object, undefined)).toEqual({
      order: ['email', 'company'],
      widths: {},
    });
  });

  it('migrates the v1 visible-columns list and ignores corrupt storage', () => {
    const v1 = storage({ 'retainer:columns:v1:w:person': '["email"]' });
    expect(loadColumnPrefs(v1, 'w', 'person')).toEqual({ order: ['email'], widths: {} });
    const bad = storage({ [columnsKey('w', 'person')]: '{nope' });
    expect(loadColumnPrefs(bad, 'w', 'person')).toBeUndefined();
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    expect(loadColumnPrefs(blocked, 'w', 'person')).toBeUndefined();
  });

  it('clamps saved widths', () => {
    const s = storage({
      [columnsKey('w', 'person')]: JSON.stringify({ order: [], widths: { a: 5, b: 9999, c: 'x' } }),
    });
    expect(loadColumnPrefs(s, 'w', 'person')?.widths).toEqual({
      a: MIN_COLUMN_WIDTH,
      b: MAX_COLUMN_WIDTH,
    });
    expect(clampWidth(200.4)).toBe(200);
  });

  it('shows, hides and moves columns', () => {
    expect(setColumnVisible(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(setColumnVisible(['a', 'b'], 'b', true)).toEqual(['a', 'b']);
    expect(setColumnVisible(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(moveColumn(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(moveColumn(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
    expect(moveColumn(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
    expect(shiftColumn(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(shiftColumn(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('filters', () => {
  it('round-trips one clause in the original single-condition shape', () => {
    const raw = encodeClauses([{ field: 'jobTitle', operator: 'eq', value: 'CTO' }]);
    expect(raw).toBe('{"jobTitle":{"eq":"CTO"}}');
    expect(parseFilter(raw).clauses).toEqual([{ field: 'jobTitle', operator: 'eq', value: 'CTO' }]);
  });

  it('ANDs several clauses and reads them back', () => {
    const clauses = [
      { field: 'a', operator: 'eq', value: 1 },
      { field: 'a', operator: 'lt', value: 5 },
    ];
    expect(parseFilter(encodeClauses(clauses)).clauses).toEqual(clauses);
    expect(encodeClauses([])).toBeUndefined();
  });

  it('reads bare values and multi-operator conditions', () => {
    expect(parseFilter('{"a":"x","b":{"gt":1,"lt":3}}').clauses).toEqual([
      { field: 'a', operator: 'eq', value: 'x' },
      { field: 'b', operator: 'gt', value: 1 },
      { field: 'b', operator: 'lt', value: 3 },
    ]);
  });

  it('flags filters chips cannot express, and invalid JSON', () => {
    expect(parseFilter('{"or":[{"a":1},{"b":2}]}')).toMatchObject({
      custom: [{ or: [{ a: 1 }, { b: 2 }] }],
      clauses: [],
    });
    expect(parseFilter('{"and":[{"not":{"a":1}},{"b":2}]}')).toMatchObject({
      custom: [{ not: { a: 1 } }],
      clauses: [{ field: 'b', operator: 'eq', value: 2 }],
    });
    expect(parseFilter('{nope').error).toMatch(/invalid filter/);
    expect(parseFilter('[1]').error).toMatch(/invalid filter/);
  });

  it('keeps custom parts beside chips, flat, as clauses are added, replaced and removed', () => {
    const or = { or: [{ a: 1 }, { b: 2 }] };
    let view = parseFilter(JSON.stringify(or));
    const add = (clause: FilterClause) =>
      parseFilter(encodeFilter({ clauses: addClause(view.clauses, clause), custom: view.custom }));
    view = add({ field: 'c', operator: 'gt', value: 10 });
    view = add({ field: 'c', operator: 'gt', value: 20 });
    view = add({ field: 'd', operator: 'eq', value: 'x' });
    expect(view.custom).toEqual([or]);
    expect(view.clauses).toEqual([
      { field: 'c', operator: 'gt', value: 20 },
      { field: 'd', operator: 'eq', value: 'x' },
    ]);
    expect(view.query.filter).toEqual({ and: [or, { c: { gt: 20 } }, { d: { eq: 'x' } }] });
    const withoutCustom = encodeFilter({ clauses: view.clauses, custom: [] });
    expect(parseFilter(withoutCustom).custom).toEqual([]);
    expect(encodeFilter({ clauses: [], custom: [or] })).toBe(JSON.stringify(or));
  });

  it('replaces a clause on the same field and operator', () => {
    const one = addClause([], { field: 'a', operator: 'eq', value: 1 });
    expect(addClause(one, { field: 'a', operator: 'eq', value: 2 })).toEqual([
      { field: 'a', operator: 'eq', value: 2 },
    ]);
    expect(addClause(one, { field: 'a', operator: 'neq', value: 2 })).toHaveLength(2);
  });

  it('describes clauses in words', () => {
    const stage = field('stage', {
      type: 'select',
      settings: { options: [{ value: 'won', label: 'Won' }] },
    } as Partial<FieldView>);
    expect(describeClause({ field: 'stage', operator: 'in', value: ['won', 'x'] }, stage)).toEqual({
      field: 'Stage',
      operator: 'is any of',
      value: 'Won, x',
    });
    expect(describeClause({ field: 'x', operator: 'isNull', value: false }, undefined)).toEqual({
      field: 'x',
      operator: 'is not empty',
    });
    const amount = field('amount', { type: 'money' });
    expect(
      describeClause({ field: 'amount', operator: 'gt', value: 2_500_000 }, amount).value,
    ).toBe('2.5');
    expect(describeClause({ field: 'amount', operator: 'gt', value: 2.5 }, amount).value).toBe(
      '2.5',
    );
  });
});

it('names operators in words', () => {
  expect(operatorLabel('eq')).toBe('is');
  expect(operatorLabel('isNull')).toBe('is empty / not empty');
  expect(operatorLabel('containsAny')).toBe('has any of');
  expect(operatorLabel('containsAll')).toBe('has all of');
  expect(operatorLabel('isEmpty')).toBe('is empty / not empty');
  expect(operatorLabel('unknown')).toBe('unknown');
});

describe('many-to-many relations', () => {
  const contacts = field('contacts', {
    type: 'relation',
    isFilterable: true,
    settings: { targetObject: 'person', relationCardinality: 'many_to_many' },
  });
  it('describes set filters with record labels where the list knows them', () => {
    const references = { a: { id: 'a', object: 'person', label: 'Dana' } };
    expect(
      describeClause(
        { field: 'contacts', operator: 'containsAll', value: ['a', 'b'] },
        contacts,
        references,
      ),
    ).toEqual({ field: 'Contacts', operator: 'has all of', value: 'Dana, b' });
    expect(
      describeClause({ field: 'contacts', operator: 'isEmpty', value: true }, contacts),
    ).toEqual({ field: 'Contacts', operator: 'is empty' });
    expect(
      describeClause({ field: 'contacts', operator: 'isEmpty', value: false }, contacts).operator,
    ).toBe('is not empty');
  });
  it('names the object of each record a polymorphic filter holds', () => {
    const customer = field('customer', {
      type: 'relation',
      isFilterable: true,
      settings: { targetObjects: ['company', 'person'], relationCardinality: 'many_to_one' },
    });
    const references = {
      a: { id: 'a', object: 'company', label: 'Acme' },
      b: { id: 'b', object: 'person', label: 'Acme' },
    };
    const objects = [
      { nameSingular: 'company', labelSingular: 'Company' },
    ] as unknown as ObjectView[];
    expect(
      describeClause(
        { field: 'customer', operator: 'in', value: ['a', 'b', 'c'] },
        customer,
        references,
        objects,
      ).value,
    ).toBe('Acme (Company), Acme (person), c');
    // One object needs no name.
    expect(
      describeClause(
        { field: 'contacts', operator: 'containsAny', value: ['a'] },
        contacts,
        references,
        objects,
      ).value,
    ).toBe('Acme');
  });
  it('never sorts by a set', () => {
    expect(isSortable(contacts)).toBe(false);
    expect(isSortable(field('stage', { type: 'select', isFilterable: true }))).toBe(true);
  });
});

describe('sort', () => {
  it('cycles ascending, descending, then off', () => {
    const asc = nextSort(undefined, 'name');
    expect(parseSort(asc)).toEqual({ field: 'name', direction: 'asc' });
    const desc = nextSort(parseSort(asc), 'name');
    expect(parseSort(desc)).toEqual({ field: 'name', direction: 'desc' });
    expect(nextSort(parseSort(desc), 'name')).toBeUndefined();
    expect(parseSort(nextSort(parseSort(desc), 'email'))?.field).toBe('email');
  });

  it('parses the URL once into chips, header state and API input', () => {
    const view = parseListSearch({
      filter: '{"jobTitle":{"eq":"CTO"}}',
      sort: '[{"field":"name","direction":"desc"},{"field":"email","direction":"asc"}]',
    });
    expect(view.error).toBe('');
    expect(view.sort).toEqual({ field: 'name', direction: 'desc' });
    expect(view.query).toEqual({
      filter: { jobTitle: { eq: 'CTO' } },
      sort: [
        { field: 'name', direction: 'desc' },
        { field: 'email', direction: 'asc' },
      ],
    });
    expect(parseListSearch({ sort: 'garbage' }).error).toMatch(/invalid sort/);
    expect(parseListSearch({ sort: '[{"field":"a","direction":"up"}]' }).error).toMatch(
      /invalid sort/,
    );
  });
});

describe('paging', () => {
  it('numbers pages it has seen and falls back to a count', () => {
    let trail = recordNextPage({}, undefined, 'c1');
    trail = recordNextPage(trail, 'c1', 'c2');
    expect(trail.c2).toEqual({ index: 2, previous: 'c1' });
    expect(pageRange(trail, undefined, 50, 50)).toBe('1–50');
    expect(pageRange(trail, 'c2', 7, 50)).toBe('101–107');
    expect(pageRange(trail, 'unknown', 1, 50)).toBe('1 record');
    expect(pageRange(trail, undefined, 0, 50)).toBe('No records');
    expect(pageRange(trail, 'c2', 7, 50, 107)).toBe('101–107 of 107');
    expect(pageRange(trail, 'unknown', 1, 50, 1)).toBe('1 record of 1');
  });
});

describe('column totals', () => {
  it('keeps only known footer operations from saved preferences', () => {
    const s = storage({
      [columnsKey('w', 'deal')]: JSON.stringify({
        order: [],
        widths: {},
        aggregates: { amount: 'sum', stage: 'median', name: 3 },
      }),
    });
    expect(loadColumnPrefs(s, 'w', 'deal')?.aggregates).toEqual({ amount: 'sum' });
  });

  it('reads like a sentence in the footer', () => {
    const amount = field('amount', { type: 'money' });
    const close = field('closeDate', { type: 'date' });
    const count = field('employees', { type: 'number' });
    const usd = (amountMicros: number) => ({ amountMicros, currency: 'USD' });
    expect(formatAggregate(count, { field: 'employees', op: 'percentEmpty', value: 100 / 3 })).toBe(
      'Empty 33%',
    );
    expect(formatAggregate(count, { field: 'employees', op: 'avg', value: 75.456 })).toBe(
      `Average ${(75.46).toLocaleString()}`,
    );
    expect(formatAggregate(amount, { field: 'amount', op: 'sum', value: usd(400_000_000) })).toBe(
      `Sum ${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(400)}`,
    );
    expect(
      formatAggregate(amount, { field: 'amount', op: 'sum', value: null, mixedCurrencies: true }),
    ).toBe('Sum: mixed currencies');
    expect(formatAggregate(close, { field: 'closeDate', op: 'max', value: '2026-05-15' })).toBe(
      `Latest ${new Date(2026, 4, 15).toLocaleDateString()}`,
    );
    expect(formatAggregate(close, { field: 'closeDate', op: 'min', value: null })).toBe(
      'Earliest —',
    );
    expect(aggregateLabel(count, 'countUnique')).toBe('Unique values');
  });
});

describe('row density', () => {
  it('defaults to compact and isolates persisted choices by workspace and object', () => {
    const items: Record<string, string> = {};
    const store = () => ({
      getItem: (k: string) => items[k] ?? null,
      setItem: (k: string, v: string) => {
        items[k] = v;
      },
    });
    expect(loadRowDensity(store, 'a', 'task')).toBe('compact');
    saveRowDensity(store, 'a', 'task', 'expanded');
    expect(loadRowDensity(store, 'a', 'task')).toBe('expanded');
    expect(loadRowDensity(store, 'a', 'person')).toBe('compact');
    expect(loadRowDensity(store, 'b', 'task')).toBe('compact');
    saveRowDensity(store, 'a', 'task', 'compact');
    expect(loadRowDensity(store, 'a', 'task')).toBe('compact');
  });
  it('tolerates blocked browser storage', () => {
    const blocked = () => {
      throw new Error('Storage blocked');
    };
    expect(loadRowDensity(blocked, 'a', 'task')).toBe('compact');
    expect(() => saveRowDensity(blocked, 'a', 'task', 'expanded')).not.toThrow();
  });
});
