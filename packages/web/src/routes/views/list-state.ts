import type {
  AggregateOp,
  AggregateValue,
  FieldView,
  FilterOperator,
  MoneyValue,
  ObjectView,
  QueryInput,
  RecordReference,
} from '@retainer/shared';
import { AGGREGATE_OPS, aggregateOps, isPolymorphic, SORTABLE_TYPES } from '@retainer/shared';
import { dateText, microsToDecimal, moneyText } from '../../fields/common.js';
import { clampWidth } from '../../ui/data-grid.js';
import { eventColumnOrder } from '../events/event-list.js';
import { objectLabel, recordTitle } from '../state.js';

// ---------------------------------------------------------------------------
// Columns: which fields show, in what order, at what width. Saved per object.
// ---------------------------------------------------------------------------

/**
 * `order` lists the visible columns after the pinned label column;
 * `aggregates` is what each column's footer computes.
 */
export type ColumnPrefs = {
  order: string[];
  widths: Record<string, number>;
  aggregates?: Record<string, AggregateOp>;
};

export const columnsKey = (workspace: string, object: string) =>
  `retainer:columns:v2:${workspace}:${object}`;
const legacyColumnsKey = (workspace: string, object: string) =>
  `retainer:columns:v1:${workspace}:${object}`;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

export function parseColumnPrefs(raw: unknown): ColumnPrefs | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const { order, widths, aggregates } = raw as Record<string, unknown>;
  if (!isStringArray(order)) return undefined;
  const clean: Record<string, number> = {};
  if (widths && typeof widths === 'object' && !Array.isArray(widths))
    for (const [k, v] of Object.entries(widths))
      if (typeof v === 'number' && Number.isFinite(v)) clean[k] = clampWidth(v);
  const ops: Record<string, AggregateOp> = {};
  if (aggregates && typeof aggregates === 'object' && !Array.isArray(aggregates))
    for (const [k, v] of Object.entries(aggregates))
      if (AGGREGATE_OPS.includes(v as AggregateOp)) ops[k] = v as AggregateOp;
  return { order, widths: clean, ...(Object.keys(ops).length ? { aggregates: ops } : {}) };
}

/** Reads saved preferences, migrating the v1 list of visible columns. */
export function loadColumnPrefs(
  storage: () => Pick<Storage, 'getItem'>,
  workspace: string,
  object: string,
): ColumnPrefs | undefined {
  try {
    const current = parseColumnPrefs(
      JSON.parse(storage().getItem(columnsKey(workspace, object)) ?? 'null'),
    );
    if (current) return current;
    const legacy = JSON.parse(storage().getItem(legacyColumnsKey(workspace, object)) ?? 'null');
    if (isStringArray(legacy)) return { order: legacy, widths: {} };
  } catch {
    /* Fall back to schema defaults. */
  }
  return undefined;
}

/** Saves preferences; returns false when the browser refuses storage. */
export function saveColumnPrefs(
  storage: () => Pick<Storage, 'setItem'>,
  workspace: string,
  object: string,
  prefs: ColumnPrefs,
): boolean {
  try {
    storage().setItem(columnsKey(workspace, object), JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

export function defaultColumnOrder(object: ObjectView): string[] {
  // Event types lead with when it happened, and add their built-in columns (5.3).
  if (object.class === 'event') return eventColumnOrder(object);
  return object.fields
    .filter((f) => f.type !== 'json' && !f.readOnly && f.name !== object.labelField)
    .map((f) => f.name);
}

/** The label column first, then the saved order, skipping fields that no longer exist. */
export function resolveColumns(object: ObjectView, prefs: ColumnPrefs | undefined): FieldView[] {
  const byName = new Map(object.fields.map((f) => [f.name, f]));
  const label = object.labelField ? byName.get(object.labelField) : undefined;
  const rest = (prefs?.order ?? defaultColumnOrder(object))
    .filter((n, i, all) => n !== object.labelField && all.indexOf(n) === i)
    .map((n) => byName.get(n))
    .filter((f): f is FieldView => !!f);
  return label ? [label, ...rest] : rest;
}

/**
 * Preferences as the grid shows them: the resolved column order, and widths
 * and calculations only for fields the object has now (with ops they still
 * support). Stored preferences can name fields that were renamed or removed.
 */
export function shownColumnPrefs(object: ObjectView, prefs: ColumnPrefs | undefined): ColumnPrefs {
  const byName = new Map(object.fields.map((f) => [f.name, f]));
  const order = resolveColumns(object, prefs)
    .filter((f) => f.name !== object.labelField)
    .map((f) => f.name);
  const widths = Object.fromEntries(
    Object.entries(prefs?.widths ?? {}).filter(([name]) => byName.has(name)),
  );
  const aggregates = Object.fromEntries(
    Object.entries(prefs?.aggregates ?? {}).filter(([name, op]) => {
      const field = byName.get(name);
      return field && aggregateOps(field).includes(op);
    }),
  );
  return { order, widths, ...(Object.keys(aggregates).length ? { aggregates } : {}) };
}

export function setColumnVisible(order: string[], name: string, visible: boolean): string[] {
  if (!visible) return order.filter((n) => n !== name);
  return order.includes(name) ? order : [...order, name];
}

/** Moves `name` so it sits where `target` is now. */
export function moveColumn(order: string[], name: string, target: string): string[] {
  const from = order.indexOf(name),
    to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, name);
  return next;
}

/** Moves `name` one place left (-1) or right (+1). */
export function shiftColumn(order: string[], name: string, by: -1 | 1): string[] {
  const from = order.indexOf(name);
  const target = order[from + by];
  return from < 0 || target === undefined ? order : moveColumn(order, name, target);
}

const NARROW_TYPES = new Set(['boolean', 'number', 'money', 'date']);
export function defaultColumnWidth(field: FieldView, isLabel: boolean): number {
  if (isLabel) return 240;
  // An event's people and records, each with its object named.
  if (field.readOnly && (field.name === 'participants' || field.name === 'about')) return 240;
  if (NARROW_TYPES.has(field.type)) return 140;
  if (field.type === 'emails' || field.type === 'links' || field.type === 'address') return 220;
  return 180;
}

// ---------------------------------------------------------------------------
// Filters: the URL filter as one flat AND of parts. Parts the chips can
// express become clauses; the rest (`or`, `not`) are kept as opaque custom
// parts, so adding or removing a chip never disturbs them.
// ---------------------------------------------------------------------------

export type FilterClause = { field: string; operator: string; value: unknown };
export type FilterParts = { clauses: FilterClause[]; custom: Record<string, unknown>[] };

const NESTING = new Set(['and', 'or', 'not']);
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Splits a filter into its top-level ANDed parts, flattening nested `and`s. */
function splitFilter(filter: Record<string, unknown>, out: FilterParts): FilterParts {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === 'and' && Array.isArray(condition)) {
      for (const part of condition)
        if (isPlainObject(part)) splitFilter(part, out);
        else out.custom.push({ and: [part] });
    } else if (NESTING.has(key)) out.custom.push({ [key]: condition });
    else if (isPlainObject(condition)) {
      const entries = Object.entries(condition);
      if (!entries.length) out.custom.push({ [key]: condition });
      for (const [operator, value] of entries) {
        if (
          operator === 'within' ||
          (['gt', 'gte', 'lt', 'lte'].includes(operator) &&
            (isPlainObject(value) || ['today', 'tomorrow', 'yesterday'].includes(String(value))))
        ) {
          out.custom.push({ [key]: { [operator]: value } });
        } else out.clauses.push({ field: key, operator, value });
      }
    } else out.clauses.push({ field: key, operator: 'eq', value: condition });
  }
  return out;
}

/** The single writer of URL filters: one part as-is, several as one flat `and`. */
export function encodeFilter({ clauses, custom }: FilterParts): string | undefined {
  const parts = [...custom, ...clauses.map((c) => ({ [c.field]: { [c.operator]: c.value } }))];
  if (!parts.length) return undefined;
  return JSON.stringify(parts.length === 1 ? parts[0] : { and: parts });
}

/** Adds a clause, replacing one on the same field and operator. */
export function addClause(clauses: FilterClause[], clause: FilterClause): FilterClause[] {
  const i = clauses.findIndex((c) => c.field === clause.field && c.operator === clause.operator);
  if (i < 0) return [...clauses, clause];
  return clauses.map((c, j) => (j === i ? clause : c));
}

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  within: 'is within',
  eq: 'is',
  neq: 'is not',
  in: 'is any of',
  contains: 'contains',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  isNull: 'is empty / not empty',
  containsAny: 'has any of',
  containsAll: 'has all of',
  isEmpty: 'is empty / not empty',
};

/** Words for an operator in menus: `eq` reads "is". */
export const operatorLabel = (operator: string) =>
  Object.hasOwn(OPERATOR_LABELS, operator)
    ? OPERATOR_LABELS[operator as keyof typeof OPERATOR_LABELS]
    : operator;

/**
 * A filter chip's words. Related records read as their labels when
 * `references` (from the list's records) knows them, else as their IDs.
 */
export function describeClause(
  clause: FilterClause,
  field: FieldView | undefined,
  references?: Record<string, RecordReference>,
  /** Names the object of each record a polymorphic relation filter holds. */
  objects?: ObjectView[],
): { field: string; operator: string; value?: string } {
  const name = field?.label ?? clause.field;
  if (clause.operator === 'isNull' || clause.operator === 'isEmpty')
    return { field: name, operator: clause.value === false ? 'is not empty' : 'is empty' };
  return {
    field: name,
    operator: operatorLabel(clause.operator),
    value: formatFilterValue(clause.value, field, references, objects),
  };
}

function formatFilterValue(
  value: unknown,
  field: FieldView | undefined,
  references?: Record<string, RecordReference>,
  objects?: ObjectView[],
): string {
  if (Array.isArray(value))
    return value.map((v) => formatFilterValue(v, field, references, objects)).join(', ');
  const reference = typeof value === 'string' ? references?.[value] : undefined;
  if (field?.type === 'relation' && reference) {
    const name = recordTitle(reference);
    if (!isPolymorphic(field)) return name;
    return `${name} (${objectLabel({ objects: objects ?? [] }, reference.object)})`;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // Money filters are integer micros; anything else came from a hand-edited URL.
  if (field?.type === 'money' && Number.isSafeInteger(value))
    return microsToDecimal(value as number);
  if (field?.type === 'select' || field?.type === 'multi_select')
    return field.settings.options?.find((o) => o.value === value)?.label ?? String(value);
  if (isPlainObject(value)) return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Sort: one column at a time from the header; the URL keeps the API shape.
// ---------------------------------------------------------------------------

export type SortState = NonNullable<QueryInput['sort']>[number];

export const isSortable = (f: FieldView) => f.isFilterable && SORTABLE_TYPES.includes(f.type);

export const encodeSort = (sort: SortState | undefined) =>
  sort ? JSON.stringify([sort]) : undefined;

/** Header clicks cycle: unsorted → ascending → descending → unsorted. */
export function nextSort(current: SortState | undefined, field: string): string | undefined {
  if (current?.field !== field) return encodeSort({ field, direction: 'asc' });
  if (current.direction === 'asc') return encodeSort({ field, direction: 'desc' });
  return undefined;
}

const isSortEntry = (v: unknown): v is SortState =>
  isPlainObject(v) &&
  typeof v.field === 'string' &&
  (v.direction === 'asc' || v.direction === 'desc');

// ---------------------------------------------------------------------------
// The URL, read once: chips and header state for the screen, filter and sort
// for the API.
// ---------------------------------------------------------------------------

export type ListSearch = FilterParts & {
  sort: SortState | undefined;
  query: Pick<QueryInput, 'filter' | 'sort'>;
  error: string;
};

function readJson(raw: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return undefined;
  }
}

export function parseListSearch(search: { filter?: string; sort?: string }): ListSearch {
  const result: ListSearch = { clauses: [], custom: [], sort: undefined, query: {}, error: '' };
  if (search.filter) {
    const parsed = readJson(search.filter)?.value;
    if (!isPlainObject(parsed)) result.error = 'This address contains an invalid filter';
    else {
      result.query.filter = parsed;
      splitFilter(parsed, result);
    }
  }
  if (search.sort) {
    const parsed = readJson(search.sort)?.value;
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every(isSortEntry))
      result.error ||= 'This address contains an invalid sort';
    else {
      result.query.sort = parsed;
      result.sort = parsed[0];
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Paging: cursors only go forward, so remember where each page came from.
// ---------------------------------------------------------------------------

export type PageTrail = Record<string, { index: number; previous: string | undefined }>;

export function recordNextPage(
  trail: PageTrail,
  current: string | undefined,
  next: string,
): PageTrail {
  const index = (current ? trail[current]?.index : 0) ?? 0;
  return { ...trail, [next]: { index: index + 1, previous: current } };
}

export function pageRange(
  trail: PageTrail,
  cursor: string | undefined,
  count: number,
  pageSize: number,
  total?: number,
): string {
  const of = total === undefined ? '' : ` of ${total.toLocaleString()}`;
  const index = cursor ? trail[cursor]?.index : 0;
  if (index === undefined) return `${count === 1 ? '1 record' : `${count} records`}${of}`;
  if (!count) return 'No records';
  const start = index * pageSize + 1;
  return `${start.toLocaleString()}–${(start + count - 1).toLocaleString()}${of}`;
}

// ---------------------------------------------------------------------------
// Column totals: what a footer cell computes and how it reads.
// ---------------------------------------------------------------------------

/** Menu labels; dates read as earliest and latest rather than min and max. */
export const AGGREGATE_LABELS: Record<AggregateOp, string> = {
  countEmpty: 'Empty',
  countNotEmpty: 'Not empty',
  percentEmpty: 'Percent empty',
  percentNotEmpty: 'Percent not empty',
  countUnique: 'Unique values',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
};
const isDate = (f: FieldView) => f.type === 'date' || f.type === 'date_time';
export function aggregateLabel(field: FieldView, op: AggregateOp): string {
  if (isDate(field) && op === 'min') return 'Earliest';
  if (isDate(field) && op === 'max') return 'Latest';
  return AGGREGATE_LABELS[op];
}
/** "Empty 33%", "Sum $400.00", "Latest 5/15/2026": what a footer cell shows. */
export function formatAggregate(field: FieldView, result: AggregateValue): string {
  // The % sign says "percent", so the label drops it.
  const label =
    result.op === 'percentEmpty'
      ? AGGREGATE_LABELS.countEmpty
      : result.op === 'percentNotEmpty'
        ? AGGREGATE_LABELS.countNotEmpty
        : aggregateLabel(field, result.op);
  const { value } = result;
  if (result.mixedCurrencies) return `${label}: mixed currencies`;
  if (value === null) return `${label} —`;
  if (result.op === 'percentEmpty' || result.op === 'percentNotEmpty')
    return `${label} ${Math.round(Number(value))}%`;
  if (typeof value === 'object') return `${label} ${moneyText(value as MoneyValue)}`;
  if (typeof value === 'string') return `${label} ${dateText(value, field.type === 'date_time')}`;
  return `${label} ${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export type RowDensity = 'compact' | 'expanded';
const densityKey = (workspace: string, object: string) =>
  `retainer:row-density:${workspace}:${object}`;

export function loadRowDensity(
  storage: () => Pick<Storage, 'getItem'>,
  workspace: string,
  object: string,
): RowDensity {
  try {
    return storage().getItem(densityKey(workspace, object)) === 'expanded' ? 'expanded' : 'compact';
  } catch {
    return 'compact';
  }
}

export function saveRowDensity(
  storage: () => Pick<Storage, 'setItem'>,
  workspace: string,
  object: string,
  density: RowDensity,
): void {
  try {
    storage().setItem(densityKey(workspace, object), density);
  } catch {
    // Keep the preference for this visit when browser storage is unavailable.
  }
}
