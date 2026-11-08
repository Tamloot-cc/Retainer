import {
  EVENT_ATTACHMENTS,
  type EventPage,
  type EventRecord,
  type FieldType,
  FieldValueError,
  type FilterOperator,
  filterOperatorsFor,
  isCollectionRelation,
  isRecordId,
  type PresentedRecord,
  type RecordPage,
  type RecordReference,
  SORTABLE_TYPES,
  valueError,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import { jsonValue, type Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { directAttachments } from '../memory/events.js';
import { type CompiledObject, type CompiledSchema, objectNamed } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';
import { normalizeDomain, normalizeEmail, normalizePhone } from './derive.js';
import { presentRecords, RECORD_COLUMNS, type RecordRow } from './read.js';
import { relationReferences } from './references.js';
import { plainPrefixQuery } from './search-sql.js';
import { normalizeFieldValue } from './values.js';

/**
 * Structured filters over one object (5): `{ field: condition }` pairs are
 * ANDed, with `and`, `or` and `not` for nesting. A bare value means `eq`.
 * Only `is_filterable` fields can be filtered or sorted.
 */
export type Filter = { and?: Filter[]; or?: Filter[]; not?: Filter } & Record<string, unknown>;

type Operator = FilterOperator;
const SORTABLE: ReadonlySet<FieldType> = new Set(SORTABLE_TYPES);

export const queryInputSchema = z.strictObject({
  search: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Keywords within this object only, matched by Postgres full-text search over its label and ' +
        'searchable fields. Every word must match, as a whole word or the start of one ("Dan" ' +
        'finds "Dana"); accents are ignored.',
    ),
  filter: z.record(z.string(), z.unknown()).optional(),
  sort: z
    .array(z.strictObject({ field: z.string(), direction: z.enum(['asc', 'desc']).default('asc') }))
    .max(3)
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
  include: z.array(z.enum(['relationReferences'])).optional(),
  linked: z
    .strictObject({
      record: z.uuid(),
      link: z.enum(EVENT_ATTACHMENTS).optional(),
    })
    .optional()
    .describe(
      'Event types only: events directly attached to this record, as a participant, about it, ' +
        "or through one of the event's own relation fields (link: field).",
    ),
});
export type QueryInput = z.infer<typeof queryInputSchema>;

/** Record columns that filters and sorts take by name, beside the fields. */
export const BUILT_IN_COLUMNS: Record<string, 'created_at' | 'updated_at' | 'id'> = {
  id: 'id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
};

/** An event record's built-in columns (6.1), filterable and sortable like fields. */
const EVENT_COLUMN_NAMES: Record<string, 'occurred_at' | 'channel' | 'external_id'> = {
  occurredAt: 'occurred_at',
  channel: 'channel',
  externalId: 'external_id',
};

type BuiltIn = { expr: Fragment; type: 'uuid' | 'timestamptz' | 'text' };

/**
 * A built-in column by API name, as a SQL expression over `records r`.
 * Event columns come from `event_records`: read per row (`subselect`), or
 * from `e` when the query joins it (`joined`); `none` has no event columns.
 */
function columnOf(
  tx: Tx,
  name: string,
  events: 'none' | 'subselect' | 'joined',
): BuiltIn | undefined {
  const record = BUILT_IN_COLUMNS[name];
  if (record) {
    return { expr: tx`${tx(`r.${record}`)}`, type: record === 'id' ? 'uuid' : 'timestamptz' };
  }
  const event = events !== 'none' ? EVENT_COLUMN_NAMES[name] : undefined;
  if (event) {
    return {
      expr:
        events === 'joined'
          ? tx`${tx(`e.${event}`)}`
          : tx`(select ${tx(`e.${event}`)} from event_records e where e.record_id = r.id)`,
      type: event === 'occurred_at' ? 'timestamptz' : 'text',
    };
  }
  return undefined;
}

/** A built-in column of `object` by API name. */
function builtInColumn(tx: Tx, object: CompiledObject, name: string): BuiltIn | undefined {
  return columnOf(tx, name, object.isEvent ? 'subselect' : 'none');
}

/** Built-in column names an object's filters and sorts take. */
export function builtInNames(object: CompiledObject): string[] {
  return [
    ...Object.keys(BUILT_IN_COLUMNS),
    ...(object.isEvent ? Object.keys(EVENT_COLUMN_NAMES) : []),
  ];
}

const invalidFilter = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, 'invalid_filter', message, details);

/** Escapes LIKE wildcards in user text. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The SQL type a field's value is compared as. */
export function typed(tx: Tx, field: FieldState): Fragment {
  const text = tx`(r.data ->> ${field.key})`;
  switch (field.type) {
    case 'number':
      return tx`${text}::numeric`;
    case 'boolean':
      return tx`${text}::boolean`;
    case 'date':
      return tx`${text}::date`;
    case 'date_time':
      return tx`${text}::timestamptz`;
    case 'money':
      return tx`((r.data -> ${field.key}) ->> 'amountMicros')::numeric`;
    default:
      return text;
  }
}

function castParam(tx: Tx, field: FieldState, value: unknown): Fragment {
  switch (field.type) {
    case 'number':
    case 'money':
      return tx`${value as number}::numeric`;
    case 'date':
      return tx`${value as string}::date`;
    case 'date_time':
      return tx`${value as string}::timestamptz`;
    case 'boolean':
      return tx`${value as boolean}::boolean`;
    default:
      return tx`${value as string}`;
  }
}

/** A condition as operator to value: a bare value means `eq`. */
function conditionsOf(condition: unknown): Record<string, unknown> {
  return condition !== null && typeof condition === 'object' && !Array.isArray(condition)
    ? (condition as Record<string, unknown>)
    : { eq: condition };
}

/**
 * A built-in column's filter value, checked against the column's type before
 * Postgres casts it, so a malformed value is a 422 naming the column rather
 * than a failed cast. Timestamps follow the rule for `date_time` fields: ISO
 * 8601 with a UTC offset.
 */
function builtInValue(name: string, type: BuiltIn['type'], value: unknown): string {
  if (type === 'uuid') {
    if (isRecordId(value)) return value;
    throw invalidFilter(`invalid value for ${name}: expected a record ID (UUID)`, { field: name });
  }
  if (type === 'timestamptz') {
    return valueFor({ name, type: 'date_time', settings: {} }, value) as string;
  }
  if (typeof value === 'string') return value;
  throw invalidFilter(`invalid value for ${name}: expected text`, { field: name });
}

/** A condition on a built-in column: text takes eq, neq and in; the rest also compare. */
function builtInCondition(
  tx: Tx,
  name: string,
  builtIn: BuiltIn,
  conditions: Record<string, unknown>,
): Fragment {
  const parts: Fragment[] = [];
  const ordered = builtIn.type !== 'text';
  const allowed = ordered ? ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'] : ['eq', 'neq', 'in'];
  for (const [op, value] of Object.entries(conditions)) {
    const column = builtIn.expr;
    const type = tx.unsafe(builtIn.type);
    const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
    if (op === 'in' && Array.isArray(value)) {
      const values = value.map((v) => builtInValue(name, builtIn.type, v));
      parts.push(tx`${column} = any(${values}::${type}[])`);
    } else if (sqlOp && allowed.includes(op) && typeof value === 'string') {
      parts.push(
        tx`${column} ${tx.unsafe(sqlOp)} ${builtInValue(name, builtIn.type, value)}::${type}`,
      );
    } else {
      throw invalidFilter(`${name} does not support "${op}" with that value`, {
        field: name,
        allowed,
      });
    }
  }
  return and(tx, parts);
}

function compileCondition(
  tx: Tx,
  object: CompiledObject,
  name: string,
  condition: unknown,
): Fragment {
  const builtIn = builtInColumn(tx, object, name);
  const conditions = conditionsOf(condition);
  const parts: Fragment[] = [];

  if (builtIn) return builtInCondition(tx, name, builtIn, conditions);

  const field = object.fieldsByName.get(name);
  if (!field) {
    throw invalidFilter(`unknown field "${name}" on ${object.name}`, {
      field: name,
      allowed: filterableNames(object),
    });
  }
  if (!field.isFilterable) {
    throw invalidFilter(`${name} is not filterable`, {
      field: name,
      allowed: filterableNames(object),
    });
  }
  const allowed = filterOperatorsFor(field);

  for (const [op, raw] of Object.entries(conditions)) {
    if (!(allowed as string[]).includes(op)) {
      throw invalidFilter(`${name} (${field.type}) does not support "${op}"`, {
        field: name,
        allowed,
      });
    }
    parts.push(compileOperator(tx, field, op as Operator, raw));
  }
  return and(tx, parts);
}

function filterableNames(object: CompiledObject): string[] {
  return [
    ...builtInNames(object),
    ...object.activeFields.filter((f) => f.isFilterable).map((f) => f.name),
  ];
}

/**
 * Validates a filter value with the field's own rules. Errors carry what a
 * write's would (valueError), except the stored-value format: a filter on a
 * composite field is not written like its stored value (money compares a
 * number, emails a single address, a name or address matches text), so that
 * format would mislead. Money's message names its own.
 */
function valueFor(field: Pick<FieldState, 'name' | 'type' | 'settings'>, value: unknown): unknown {
  if (field.type === 'money') {
    if (typeof value === 'number') return value;
    throw invalidFilter(`invalid value for ${field.name}: expected amountMicros as a number`, {
      field: field.name,
      message: 'expected amountMicros as a number',
    });
  }
  try {
    return normalizeFieldValue(field, value);
  } catch (error) {
    if (!(error instanceof FieldValueError)) throw error;
    const { expected: _stored, ...details } = valueError(field.name, field.type, error);
    throw invalidFilter(`invalid value for ${field.name}: ${error.message}`, details);
  }
}

function compileOperator(tx: Tx, field: FieldState, op: Operator, raw: unknown): Fragment {
  const key = field.key;

  if (op === 'isNull') {
    if (typeof raw !== 'boolean') throw invalidFilter(`${field.name}.isNull takes true or false`);
    const empty = emptyValue(tx, field);
    return raw ? empty : tx`not ${empty}`;
  }

  if (isCollectionRelation(field)) {
    if (op === 'isEmpty') {
      if (typeof raw !== 'boolean')
        throw invalidFilter(`${field.name}.isEmpty takes true or false`);
      const empty = emptyValue(tx, field);
      return raw ? empty : tx`not ${empty}`;
    }
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isRecordId)) {
      throw invalidFilter(`${field.name}.${op} takes a non-empty array of record IDs`, {
        field: field.name,
      });
    }
    const ids = [...new Set(raw as string[])];
    if (op === 'containsAny') {
      return tx`exists (select 1 ${liveLinks(tx, field)} and l.target_record_id = any(${ids}::uuid[]))`;
    }
    return tx`(select count(distinct l.target_record_id) ${liveLinks(tx, field)}
      and l.target_record_id = any(${ids}::uuid[])) = ${ids.length}`;
  }

  if (field.type === 'relation') {
    const ids = op === 'in' ? raw : [raw];
    if (!Array.isArray(ids) || !ids.every(isRecordId)) {
      throw invalidFilter(`${field.name}.${op} takes record IDs`, { field: field.name });
    }
    return tx`exists (select 1 from record_links l
      where l.source_record_id = r.id and l.field_id = ${field.id as string}
        and l.target_record_id = any(${ids as string[]}::uuid[]))`;
  }

  if (field.type === 'emails' || field.type === 'phones' || field.type === 'links') {
    if (typeof raw !== 'string') throw invalidFilter(`${field.name}.eq takes a single value`);
    const value =
      field.type === 'emails'
        ? normalizeEmail(raw)
        : field.type === 'phones'
          ? normalizePhone(raw)
          : normalizeDomain(raw);
    return tx`exists (select 1 from record_identifiers i
      where i.record_id = r.id and i.field_id = ${field.id as string} and i.value = ${value ?? ''})`;
  }

  if (op === 'contains') {
    if (typeof raw !== 'string' || raw === '')
      throw invalidFilter(`${field.name}.contains takes text`);
    if (field.type === 'multi_select') {
      valueFor(field, [raw]);
      return tx`(r.data -> ${key}) ? ${raw}`;
    }
    if (field.type === 'full_name') {
      return tx`concat_ws(' ', r.data -> ${key} ->> 'first', r.data -> ${key} ->> 'last')
        ilike ${likePattern(raw)}`;
    }
    // text and address: match anywhere in the value's text.
    return tx`(r.data ->> ${key}) ilike ${likePattern(raw)}`;
  }

  if (op === 'in') {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw invalidFilter(`${field.name}.in takes a non-empty array`);
    }
    // Containment per value uses the GIN index on data.
    const alternatives = raw.map(
      (v) => tx`r.data @> ${tx.json(jsonValue({ [key]: valueFor(field, v) }))}`,
    );
    return tx`(${alternatives.reduce((a, b) => tx`${a} or ${b}`)})`;
  }

  const value = valueFor(field, raw);
  if (op === 'eq' && field.type !== 'date_time') {
    return tx`r.data @> ${tx.json(jsonValue({ [key]: value }))}`;
  }
  if (op === 'neq' && field.type !== 'date_time') {
    return tx`not (r.data @> ${tx.json(jsonValue({ [key]: value }))})`;
  }
  const sqlOp = (
    { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>
  )[op];
  if (!sqlOp) throw invalidFilter(`unsupported operator ${op}`);
  return tx`${typed(tx, field)} ${tx.unsafe(sqlOp)} ${castParam(tx, field, value)}`;
}

function and(tx: Tx, parts: Fragment[]): Fragment {
  if (parts.length === 0) return tx`true`;
  return tx`(${parts.reduce((a, b) => tx`${a} and ${b}`)})`;
}

function or(tx: Tx, parts: Fragment[]): Fragment {
  if (parts.length === 0) return tx`false`;
  return tx`(${parts.reduce((a, b) => tx`${a} or ${b}`)})`;
}

export function compileFilter(
  tx: Tx,
  object: CompiledObject,
  filter: unknown,
  depth = 0,
): Fragment {
  return compileTree(tx, filter, depth, (name, condition) =>
    compileCondition(tx, object, name, condition),
  );
}

/** `and`, `or` and `not` over a filter whose leaves `leaf` compiles. */
function compileTree(
  tx: Tx,
  filter: unknown,
  depth: number,
  leaf: (name: string, condition: unknown) => Fragment,
): Fragment {
  if (depth > 8) throw invalidFilter('filters nest at most 8 levels deep');
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw invalidFilter('a filter is an object of field conditions');
  }
  const parts: Fragment[] = [];
  for (const [name, condition] of Object.entries(filter)) {
    if (name === 'and' || name === 'or') {
      if (!Array.isArray(condition)) throw invalidFilter(`${name} takes an array of filters`);
      const nested = condition.map((f) => compileTree(tx, f, depth + 1, leaf));
      parts.push(name === 'and' ? and(tx, nested) : or(tx, nested));
    } else if (name === 'not') {
      parts.push(tx`not ${compileTree(tx, condition, depth + 1, leaf)}`);
    } else {
      parts.push(leaf(name, condition));
    }
  }
  return and(tx, parts);
}

export function compileSort(tx: Tx, object: CompiledObject, sort: QueryInput['sort']): Fragment {
  const parts: Fragment[] = [];
  for (const { field: name, direction } of sort ?? []) {
    const dir = tx.unsafe(direction === 'desc' ? 'desc' : 'asc');
    const builtIn = builtInColumn(tx, object, name);
    if (builtIn) {
      parts.push(tx`${builtIn.expr} ${dir} nulls last`);
      continue;
    }
    const field = object.fieldsByName.get(name);
    if (!field?.isFilterable || !SORTABLE.has(field.type)) {
      throw invalidFilter(`cannot sort by "${name}"`, {
        field: name,
        allowed: [
          ...builtInNames(object),
          ...object.activeFields
            .filter((f) => f.isFilterable && SORTABLE.has(f.type))
            .map((f) => f.name),
        ],
      });
    }
    parts.push(tx`${typed(tx, field)} ${dir} nulls last`);
  }
  // A stable order makes cursors deterministic.
  parts.push(tx`r.created_at asc`, tx`r.id asc`);
  return parts.reduce((a, b) => tx`${a}, ${b}`);
}

const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ offset })).toString('base64url');

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const { offset } = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (Number.isInteger(offset) && offset >= 0) return offset;
  } catch {}
  throw invalidFilter('invalid cursor; pass nextCursor from the previous page');
}

/**
 * The live records of one object that a filter and keyword search match, as
 * a `where` clause over `records r`. The list and its totals share it, so
 * they always count the same records.
 */
export function matchingRecords(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  object: CompiledObject,
  input: Pick<QueryInput, 'filter' | 'search' | 'linked'>,
): Fragment {
  const where = input.filter ? compileFilter(tx, object, input.filter) : tx`true`;
  return tx`r.workspace_id = ${workspaceId} and r.object_type_id = ${object.id}
    and r.deleted_at is null and ${where}
    ${input.search ? tx`and r.search @@ ${plainPrefixQuery(tx, input.search)}` : tx``}
    ${input.linked ? tx`and ${linkedTo(tx, workspaceId, schema, object, input.linked)}` : tx``}`;
}

/**
 * Events directly attached to a record (7.1): a merged record ID counts as
 * its survivor. A record that is deleted or of a hidden object links
 * nothing, as every read of it does. Only event types take `linked`.
 */
function linkedTo(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  object: CompiledObject,
  linked: NonNullable<QueryInput['linked']>,
): Fragment {
  if (!object.isEvent) {
    throw invalidFilter(`linked applies to event types; ${object.name} is an entity`, {
      field: 'linked',
    });
  }
  return attachedTo(tx, workspaceId, schema, linked);
}

/** Events, of any type, directly attached to a record (7.1), as a condition on `r`. */
function attachedTo(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  linked: NonNullable<QueryInput['linked']>,
): Fragment {
  const record = tx`(select s.id from records m
    join records s on s.id = coalesce(m.merged_into_id, m.id) and s.deleted_at is null
      and s.object_type_id = any(${schema.visibleObjectIds}::uuid[])
    where m.id = ${linked.record} and m.workspace_id = ${workspaceId})`;
  return tx`r.id in (select d.event_id from ${directAttachments(
    tx,
    schema,
    workspaceId,
    record,
    linked.link,
  )} d)`;
}

/** `from … where …` over the live targets record `r` links to through `field`. */
export function liveLinks(tx: Tx, field: FieldState): Fragment {
  return tx`from record_links l join records t
    on t.id = l.target_record_id and t.deleted_at is null
    where l.source_record_id = r.id and l.field_id = ${field.id as string}`;
}

/** Whether a field has no value, as the `isNull` filter decides it. */
export function emptyValue(tx: Tx, field: FieldState): Fragment {
  if (field.type === 'relation') return tx`not exists (select 1 ${liveLinks(tx, field)})`;
  return tx`coalesce(r.data -> ${field.key}, 'null'::jsonb) = 'null'::jsonb`;
}

/** Filters, sorts and pages live records of one object. */
export async function queryRecords(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  object: CompiledObject,
  input: QueryInput,
): Promise<RecordPage> {
  const offset = decodeCursor(input.cursor);
  const columns = RECORD_COLUMNS.map((c) => `r.${c}`);
  const rows = await tx<RecordRow[]>`
    select ${tx.unsafe(columns.join(', '))} from records r
    where ${matchingRecords(tx, workspaceId, schema, object, input)}
    order by ${compileSort(tx, object, input.sort)}
    limit ${input.limit + 1} offset ${offset}`;
  return pageOf(tx, schema, rows, input, offset, (records) => records);
}

/**
 * One page of rows fetched with `limit + 1` from `offset`: the records
 * presented and shaped by `shape`, their references if asked for, and the
 * cursor to the next page.
 */
async function pageOf<T extends PresentedRecord>(
  tx: Tx,
  schema: CompiledSchema,
  rows: RecordRow[],
  input: Pick<QueryInput, 'limit' | 'include'>,
  offset: number,
  shape: (records: PresentedRecord[]) => T[],
): Promise<{
  records: T[];
  nextCursor: string | null;
  relationReferences?: Record<string, RecordReference>;
}> {
  const records = shape(await presentRecords(tx, schema, rows.slice(0, input.limit)));
  const refs = input.include?.includes('relationReferences')
    ? await relationReferences(tx, schema, records)
    : undefined;
  return {
    records,
    ...(refs ? { relationReferences: refs } : {}),
    nextCursor: rows.length > input.limit ? encodeCursor(offset + input.limit) : null,
  };
}

/**
 * `query_records` with `object: "event"` and `POST /v1/events/query` (7.1):
 * events of every visible event type, never the hidden internal notes.
 * Filters and sorts take only what every event type shares; a type's own
 * fields, such as a conversation's medium, are returned but not filterable.
 */
export const EVENT_QUERY_OBJECT = 'event';

/** The columns every event type shares, as SQL over `records r` joined to `event_records e`. */
const eventQueryColumn = (tx: Tx, name: string) => columnOf(tx, name, 'joined');

const EVENT_SORT_NAMES = [...Object.keys(EVENT_COLUMN_NAMES), ...Object.keys(BUILT_IN_COLUMNS)];
const EVENT_FILTER_NAMES = ['type', ...EVENT_SORT_NAMES];

/** The event type IDs a `type` condition names; unknown names fail with the known ones. */
function eventTypeIds(schema: CompiledSchema, names: unknown): string[] {
  const list = Array.isArray(names) ? names : [names];
  if (list.length === 0 || list.some((n) => typeof n !== 'string')) {
    throw invalidFilter('type takes event type API names', { field: 'type' });
  }
  return (list as string[]).map((name) => {
    const type = objectNamed(schema, name);
    if (!type?.isEvent) {
      throw invalidFilter(`unknown event type "${name}"`, {
        field: 'type',
        allowed: [...schema.objectsByName.values()].filter((o) => o.isEvent).map((o) => o.name),
      });
    }
    return type.id;
  });
}

function eventCondition(
  tx: Tx,
  schema: CompiledSchema,
  name: string,
  condition: unknown,
): Fragment {
  const conditions = conditionsOf(condition);
  if (name === 'type') {
    const parts: Fragment[] = [];
    for (const [op, value] of Object.entries(conditions)) {
      if ((op === 'eq' || op === 'neq') && typeof value !== 'string') {
        throw invalidFilter(`type.${op} takes one event type API name; use in for several`, {
          field: 'type',
        });
      }
      if (op === 'eq' || op === 'in') {
        if (op === 'in' && !Array.isArray(value)) throw invalidFilter('type.in takes an array');
        parts.push(tx`r.object_type_id = any(${eventTypeIds(schema, value)}::uuid[])`);
      } else if (op === 'neq') {
        parts.push(tx`r.object_type_id <> all(${eventTypeIds(schema, value)}::uuid[])`);
      } else {
        throw invalidFilter(`type does not support "${op}"`, {
          field: 'type',
          allowed: ['eq', 'neq', 'in'],
        });
      }
    }
    return and(tx, parts);
  }
  const builtIn = eventQueryColumn(tx, name);
  if (!builtIn) {
    throw invalidFilter(
      `"${name}" is not a column every event type shares; to filter by a type's own ` +
        'fields, query that type with query_records',
      { field: name, allowed: EVENT_FILTER_NAMES },
    );
  }
  return builtInCondition(tx, name, builtIn, conditions);
}

/**
 * Newest first by default. `occurredAt` is never null and ties break on the
 * event's ID in the same direction, so the default order is the order of
 * `event_records_workspace_time_idx`.
 */
function eventSort(tx: Tx, sort: QueryInput['sort']): Fragment {
  const keys = sort?.length ? sort : [{ field: 'occurredAt', direction: 'desc' as const }];
  const parts: Fragment[] = [];
  for (const { field: name, direction } of keys) {
    const builtIn = eventQueryColumn(tx, name);
    if (!builtIn) {
      throw invalidFilter(`cannot sort events by "${name}"`, {
        field: name,
        allowed: EVENT_SORT_NAMES,
      });
    }
    const dir = tx.unsafe(direction === 'desc' ? 'desc' : 'asc');
    parts.push(
      name === 'occurredAt' ? tx`${builtIn.expr} ${dir}` : tx`${builtIn.expr} ${dir} nulls last`,
    );
  }
  // A stable order makes cursors deterministic.
  parts.push(tx`e.record_id ${tx.unsafe(keys[0]?.direction === 'desc' ? 'desc' : 'asc')}`);
  return parts.reduce((a, b) => tx`${a}, ${b}`);
}

/** Filters, sorts and pages live events across every visible event type. */
export async function queryEvents(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  input: QueryInput,
): Promise<EventPage> {
  const offset = decodeCursor(input.cursor);
  const where = input.filter
    ? compileTree(tx, input.filter, 0, (name, condition) =>
        eventCondition(tx, schema, name, condition),
      )
    : tx`true`;
  const columns = RECORD_COLUMNS.map((c) => `r.${c}`);
  const rows = await tx<RecordRow[]>`
    select ${tx.unsafe(columns.join(', '))}
    from records r
    join event_records e on e.record_id = r.id and e.workspace_id = r.workspace_id
    where r.workspace_id = ${workspaceId}
      and r.object_type_id = any(${schema.eventTypeIds}::uuid[])
      and r.deleted_at is null and ${where}
      ${input.search ? tx`and r.search @@ ${plainPrefixQuery(tx, input.search)}` : tx``}
      ${input.linked ? tx`and ${attachedTo(tx, workspaceId, schema, input.linked)}` : tx``}
    order by ${eventSort(tx, input.sort)}
    limit ${input.limit + 1} offset ${offset}`;
  return pageOf(tx, schema, rows, input, offset, (presented) =>
    presented.flatMap((record): EventRecord[] =>
      record.event ? [{ ...record, type: record.object, event: record.event }] : [],
    ),
  );
}
