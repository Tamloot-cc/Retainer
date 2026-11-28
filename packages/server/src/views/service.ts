import {
  type Actor,
  AGGREGATE_GRANULARITIES,
  AGGREGATE_OPS,
  canGroupBy,
  canPlaceBy,
  displayViewGroups,
  isRecordId,
  SAVED_VIEW_KINDS,
  SAVED_VIEW_VISIBILITIES,
  type SavedView,
  sameActor,
  type ViewCheckResult,
  type ViewColumns,
} from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { StoredViewConfig } from '../db/schema.js';
import { inWorkspace, jsonValue, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { admitCaller } from '../extension-runtime/admission.js';
import { aggregateRecords, checkAggregateOp } from '../records/aggregate.js';
import { builtInNames, compileFilter, compileSort, queryInputSchema } from '../records/query.js';
import { requireObject, withRead } from '../records/service.js';
import { relationTargets } from '../records/write.js';
import { type CompiledObject, type CompiledSchema, getSchema } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';

// ---------------------------------------------------------------------------
// Input shapes. Fields are named as in the schema; semantic checks follow.
// ---------------------------------------------------------------------------

// Filters and sorts take the same shapes as a query.
const filterSchema = queryInputSchema.shape.filter.unwrap();
const sortSchema = queryInputSchema.shape.sort.unwrap();
const columnsSchema = z.strictObject({
  order: z.array(z.string()).max(200),
  widths: z.record(z.string(), z.number().int().min(40).max(2000)).optional(),
  aggregates: z.record(z.string(), z.enum(AGGREGATE_OPS)).optional(),
});
const configShape = {
  search: z.string().trim().min(1).max(200).nullable().optional(),
  granularity: z.enum(AGGREGATE_GRANULARITIES).nullable().optional(),
  groupOrder: z.enum(['default', 'asc', 'desc']).nullable().optional(),
  hideEmptyGroups: z.boolean().nullable().optional(),
  filter: filterSchema.nullable().optional(),
  sort: sortSchema.nullable().optional(),
  columns: columnsSchema.nullable().optional(),
  groupBy: z.string().nullable().optional(),
  hiddenGroups: z.array(z.string().nullable()).max(200).nullable().optional(),
  groupAggregate: z
    .strictObject({ field: z.string(), op: z.enum(AGGREGATE_OPS) })
    .nullable()
    .optional(),
  dateField: z.string().nullable().optional(),
};
const name = z.string().trim().min(1).max(100);
const description = z.string().trim().max(500).nullable().optional();
const position = z.number().finite();

export const createViewSchema = z.strictObject({
  name,
  description,
  kind: z.enum(SAVED_VIEW_KINDS),
  visibility: z.enum(SAVED_VIEW_VISIBILITIES).default('workspace'),
  position: position.optional(),
  ...configShape,
});
export type CreateViewInput = z.infer<typeof createViewSchema>;

export const updateViewSchema = z.strictObject({
  name: name.optional(),
  description,
  expectedUpdatedAt: z.iso.datetime().optional(),
  kind: z.enum(SAVED_VIEW_KINDS).optional(),
  visibility: z.enum(SAVED_VIEW_VISIBILITIES).optional(),
  position: position.optional(),
  ...configShape,
});
export type UpdateViewInput = z.infer<typeof updateViewSchema>;

type ConfigInput = Pick<CreateViewInput, keyof typeof configShape>;

const invalidView = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, 'invalid_view', message, details);

/** An event type's calendar may be placed by when its events happened (7.1). */
const OCCURRED_AT = 'occurredAt';
const NESTING = new Set(['and', 'or', 'not']);

// ---------------------------------------------------------------------------
// Names and keys (rule 1.4.1)
// ---------------------------------------------------------------------------

/** An event's participants and `about` records, shown as table columns. */
const EVENT_LINK_COLUMNS = ['participants', 'about'] as const;

/** An object's fields both ways, plus every key it has ever used for the issue messages. */
class FieldNames {
  private readonly byName: Map<string, FieldState>;
  private readonly byKey: Map<string, FieldState>;
  private readonly allByKey: Map<string, FieldState>;
  /** Built-in columns, stored under their own names. */
  private readonly builtIn: Set<string>;
  /**
   * An event's links, which a table shows as columns (FRONTEND.md 5.3) but
   * cannot filter, sort or total: only a column's order and width take them.
   */
  private readonly displayOnly: Set<string>;
  readonly issues: string[] = [];

  constructor(readonly object: CompiledObject) {
    this.builtIn = new Set(builtInNames(object));
    this.displayOnly = new Set(object.isEvent ? EVENT_LINK_COLUMNS : []);
    this.byName = object.fieldsByName;
    this.byKey = new Map(object.activeFields.map((f) => [f.key, f]));
    this.allByKey = new Map(object.state.fields.map((f) => [f.key, f]));
  }

  field(fieldName: string, path: string): FieldState {
    const field = this.byName.get(fieldName);
    if (!field) {
      throw invalidView(`unknown field "${fieldName}" on ${this.object.name} (${path})`, {
        path,
        field: fieldName,
        allowed: this.object.activeFields.map((f) => f.name),
      });
    }
    return field;
  }

  key(fieldName: string, path: string): string {
    return this.builtIn.has(fieldName) ? fieldName : this.field(fieldName, path).key;
  }

  /** A shown column's stored key: a field, a built-in column or an event's links. */
  columnKey(fieldName: string, path: string): string {
    return this.displayOnly.has(fieldName) ? fieldName : this.key(fieldName, path);
  }

  /** A shown column's name for a stored key, as `name` reads it. */
  columnName(key: string, where: string): string | undefined {
    return this.displayOnly.has(key) ? key : this.name(key, where);
  }

  /** The active field's name for a stored key, or undefined (recording why). */
  name(key: string, where: string): string | undefined {
    if (this.builtIn.has(key)) return key;
    const field = this.byKey.get(key);
    if (field) return field.name;
    const gone = this.allByKey.get(key);
    this.issues.push(
      `${where} referred to ${gone ? `"${gone.label}", a field that was removed` : `an unknown field (${key})`}; it was dropped`,
    );
    return undefined;
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A filter with each field renamed, between names and keys, and its
 * condition as `rename` returns it. A condition `rename` drops is left out,
 * and a group left empty goes with it: an empty part would otherwise match
 * every record (or none, inside `or`).
 */
function renameFilter(
  filter: Record<string, unknown>,
  rename: (field: string, condition: unknown) => [string, unknown] | undefined,
): Record<string, unknown> | undefined {
  if (Object.keys(filter).length === 0) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === 'and' || k === 'or') {
      if (!Array.isArray(v)) continue;
      const parts = v
        .filter(isPlainObject)
        .map((f) => renameFilter(f, rename))
        .filter((f): f is Record<string, unknown> => !!f);
      if (parts.length || v.length === 0) out[k] = parts;
    } else if (k === 'not') {
      const part = isPlainObject(v) ? renameFilter(v, rename) : undefined;
      if (part) out[k] = part;
    } else if (!NESTING.has(k)) {
      const renamed = rename(k, v);
      if (renamed) out[renamed[0]] = renamed[1];
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function renameKeys<T>(
  record: Record<string, T> | undefined,
  rename: (key: string) => string | undefined,
): Record<string, T> | undefined {
  if (!record) return undefined;
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(record)) {
    const next = rename(k);
    if (next !== undefined) out[next] = v;
  }
  return out;
}

const optionValues = (field: FieldState) => new Set(field.settings.options?.map((o) => o.value));

/**
 * A select condition without the values that are no longer options, or
 * undefined when none are left. Removing an option is refused while records
 * hold it (3), so `in` loses nothing it matched.
 */
function withoutRemovedOptions(
  field: FieldState | undefined,
  condition: unknown,
): { condition: unknown; removed: string[] } {
  if (
    !field ||
    (field.type !== 'select' && field.type !== 'multi_select') ||
    !isPlainObject(condition)
  )
    return { condition, removed: [] };
  const options = optionValues(field);
  const gone = (v: unknown): v is string => typeof v === 'string' && !options.has(v);
  const removed: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [op, raw] of Object.entries(condition)) {
    if (op === 'in' && Array.isArray(raw)) {
      removed.push(...raw.filter(gone));
      const kept = raw.filter((v) => !gone(v));
      if (kept.length) out[op] = kept;
    } else if (op !== 'isNull' && gone(raw)) removed.push(raw);
    else out[op] = raw;
  }
  return { condition: Object.keys(out).length ? out : undefined, removed };
}

// ---------------------------------------------------------------------------
// Validation and storage
// ---------------------------------------------------------------------------

/**
 * Checks the config keys the input sets and returns them in stored form.
 * A key set to null is returned as undefined, clearing it.
 */
function toStored(
  tx: Tx,
  object: CompiledObject,
  input: ConfigInput,
): Partial<Record<keyof StoredViewConfig, unknown>> {
  const fields = new FieldNames(object);
  const out: Partial<Record<keyof StoredViewConfig, unknown>> = {};
  const given = (k: keyof ConfigInput) => input[k] !== undefined;
  /** The key of the field a board or calendar needs, checked against its rule. */
  const kindField = (
    fieldName: string,
    path: 'groupBy' | 'dateField',
    fits: (field: FieldState) => boolean,
    needs: string,
  ) => {
    const field = fields.field(fieldName, path);
    if (!fits(field))
      throw invalidView(`${needs}; ${fieldName} is not one`, {
        field: fieldName,
        allowed: object.activeFields.filter(fits).map((f) => f.name),
      });
    return field.key;
  };

  if (given('filter')) {
    if (input.filter) compileFilter(tx, object, input.filter);
    // The filter compiled, so every name exists.
    out.filter = input.filter
      ? renameFilter(input.filter, (n, condition) => [fields.key(n, 'filter'), condition])
      : undefined;
  }
  if (given('sort')) {
    if (input.sort?.length) compileSort(tx, object, input.sort);
    out.sort = input.sort?.length
      ? input.sort.map((s) => ({ field: fields.key(s.field, 'sort'), direction: s.direction }))
      : undefined;
  }
  if (given('columns')) {
    const columns = input.columns;
    if (columns) {
      if (new Set(columns.order).size !== columns.order.length)
        throw invalidView('columns.order lists a field twice');
      for (const [fieldName, op] of Object.entries(columns.aggregates ?? {}))
        checkAggregateOp(fields.field(fieldName, 'columns.aggregates'), op, invalidView);
    }
    out.columns = columns
      ? {
          order: columns.order.map((n) => fields.columnKey(n, 'columns.order')),
          ...(columns.widths
            ? {
                widths: renameKeys(columns.widths, (n) => fields.columnKey(n, 'columns.widths')),
              }
            : {}),
          ...(columns.aggregates
            ? {
                aggregates: renameKeys(columns.aggregates, (n) =>
                  fields.key(n, 'columns.aggregates'),
                ),
              }
            : {}),
        }
      : undefined;
  }
  for (const key of ['search', 'granularity', 'groupOrder', 'hideEmptyGroups'] as const)
    if (given(key)) out[key] = input[key] ?? undefined;
  if (given('groupBy'))
    out.groupBy = input.groupBy ? fields.key(input.groupBy, 'groupBy') : undefined;
  if (given('hiddenGroups'))
    out.hiddenGroups = input.hiddenGroups?.length ? input.hiddenGroups : undefined;
  if (given('groupAggregate')) {
    const aggregate = input.groupAggregate;
    if (aggregate) {
      const field = fields.field(aggregate.field, 'groupAggregate');
      checkAggregateOp(field, aggregate.op, invalidView);
      out.groupAggregate = { field: field.key, op: aggregate.op };
    } else out.groupAggregate = undefined;
  }
  if (given('dateField'))
    out.dateField = input.dateField
      ? object.isEvent && input.dateField === OCCURRED_AT
        ? OCCURRED_AT
        : kindField(
            input.dateField,
            'dateField',
            canPlaceBy,
            'a calendar is placed by a filterable date or date-time field',
          )
      : undefined;
  return out;
}

/** Applies stored changes to a config; an undefined value removes the key. */
function merge(
  config: StoredViewConfig,
  changes: Partial<Record<keyof StoredViewConfig, unknown>>,
): StoredViewConfig {
  const next: Record<string, unknown> = { ...config };
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as StoredViewConfig;
}

/** A board needs its group field and a calendar its date field. */
function requireKindField(
  kind: string,
  config: { groupBy?: string | null; dateField?: string | null },
): void {
  if (kind === 'board' && !config.groupBy)
    throw invalidView('a board needs groupBy: the select field whose options are its columns');
  if (kind === 'calendar' && !config.dateField)
    throw invalidView('a calendar needs dateField: the date field its records are placed by');
}

function groupingKind(object: CompiledObject, name: string) {
  if (name === 'createdAt' || name === 'updatedAt' || (object.isEvent && name === OCCURRED_AT))
    return 'date';
  const field = object.fieldsByName.get(name);
  if (!field?.isFilterable) return;
  if (canGroupBy(field)) return 'select';
  if (canPlaceBy(field)) return 'date';
  if (
    field.type === 'relation' &&
    field.settings.relationCardinality === 'many_to_one' &&
    !field.settings.isInverse
  )
    return 'relation';
}

function isPeriodStart(value: string, granularity: NonNullable<StoredViewConfig['granularity']>) {
  if (!z.iso.date().safeParse(value).success || value.startsWith('0000')) return false;
  const period = new Date(`${value}T00:00:00Z`);
  switch (granularity) {
    case 'day':
      return true;
    case 'week':
      return period.getUTCDay() === 1;
    case 'month':
      return period.getUTCDate() === 1;
    case 'quarter':
      return period.getUTCDate() === 1 && period.getUTCMonth() % 3 === 0;
    case 'year':
      return period.getUTCDate() === 1 && period.getUTCMonth() === 0;
  }
}

async function checkRelationGroups(
  tx: Tx,
  schema: CompiledSchema,
  object: CompiledObject,
  config: StoredViewConfig,
  write = false,
) {
  const name = config.groupBy && new FieldNames(object).name(config.groupBy, 'The grouping');
  const field = name && object.fieldsByName.get(name);
  if (field === '' || field?.type !== 'relation') return;
  const ids = [...new Set((config.hiddenGroups ?? []).filter((id): id is string => id !== null))];
  if (!ids.length) return;
  const targets = relationTargets(schema, field)
    .filter((target) => !target.hidden && target.state.status === 'active')
    .map((target) => target.id);
  try {
    const rows = await tx<{ id: string }[]>`
      select id from records where id = any(${ids}::uuid[]) and deleted_at is null
        and object_type_id = any(${targets}::uuid[])
      ${write ? tx`for share nowait` : tx``}`;
    if (rows.length !== ids.length)
      throw invalidView('Each hidden relation group must name a live related record', {
        path: 'hiddenGroups',
      });
  } catch (error) {
    // A deletion locks the record first and then prunes its view settings.
    // Releasing this view lock lets the deletion finish before a retry.
    if ((error as { code?: string }).code === '55P03')
      throw new AppError(
        409,
        'view_group_changed',
        'A hidden group is changing. Review the view and try again.',
      );
    throw error;
  }
}

function validateGrouping(
  object: CompiledObject,
  kind: SavedView['kind'],
  config: StoredViewConfig,
) {
  const fields = new FieldNames(object);
  const name = config.groupBy && fields.name(config.groupBy, 'The grouping');
  const grouping = name ? groupingKind(object, name) : undefined;
  const fail = (path: string, message: string) => {
    throw invalidView(message, { path });
  };
  if (
    config.groupBy &&
    (!grouping || kind === 'calendar' || (kind === 'board' && grouping === 'date'))
  )
    fail('groupBy', 'Choose a filterable select, single relation, or (for a table) a date field');
  if (config.granularity && grouping !== 'date')
    fail('granularity', 'Granularity requires a date grouping');
  if (config.hideEmptyGroups !== undefined && grouping !== 'select')
    fail('hideEmptyGroups', 'Hiding empty groups requires a select grouping');
  if ((config.groupOrder || config.groupAggregate || config.hiddenGroups?.length) && !grouping)
    fail('groupBy', 'Group settings require groupBy');
  const options = name && object.fieldsByName.get(name)?.settings.options;
  for (const value of config.hiddenGroups ?? []) {
    if (value === null) continue;
    const valid =
      grouping === 'select'
        ? !!options && options.some((option) => option.value === value)
        : grouping === 'relation'
          ? isRecordId(value)
          : isPeriodStart(value, config.granularity ?? 'month');
    if (!valid) fail('hiddenGroups', `Invalid hidden group "${value}"`);
  }
}

function nextConfig(
  tx: Tx,
  object: CompiledObject,
  before: StoredViewConfig,
  kind: SavedView['kind'],
  input: ConfigInput,
) {
  const changes = toStored(tx, object, input);
  if (Object.hasOwn(changes, 'groupBy') && changes.groupBy !== before.groupBy) {
    for (const key of ['granularity', 'hiddenGroups', 'hideEmptyGroups'] as const)
      if (!Object.hasOwn(changes, key)) changes[key] = undefined;
  }
  if (
    Object.hasOwn(changes, 'granularity') &&
    changes.granularity !== before.granularity &&
    !Object.hasOwn(changes, 'hiddenGroups')
  )
    changes.hiddenGroups = undefined;
  if (kind === 'calendar' || (changes.groupBy === undefined && Object.hasOwn(changes, 'groupBy'))) {
    for (const key of [
      'groupBy',
      'granularity',
      'hiddenGroups',
      'hideEmptyGroups',
      'groupOrder',
      'groupAggregate',
    ] as const)
      if (!Object.hasOwn(changes, key)) changes[key] = undefined;
  }
  const config = merge(before, changes);
  validateGrouping(object, kind, config);
  return config;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type ViewRow = {
  id: string;
  object_type_id: string;
  name: string;
  description: string | null;
  kind: SavedView['kind'];
  visibility: SavedView['visibility'];
  position: number;
  config: StoredViewConfig;
  created_by: Actor;
  updated_by: Actor;
  created_at: Date;
  updated_at: Date;
};

/** A stored view by field name, without references to fields that are gone (rule 1.4.2). */
export function presentView(tx: Tx, object: CompiledObject, row: ViewRow): SavedView {
  const fields = new FieldNames(object);
  const config = row.config;
  /**
   * Whether a filter condition or sort still compiles: a field can stay
   * active but stop being filterable, or lose the option a condition names.
   */
  const compiles = (what: string, fieldName: string, compile: () => unknown) => {
    try {
      compile();
      return true;
    } catch (e) {
      if (!(e instanceof AppError) || e.status >= 500) throw e;
      const label = object.fieldsByName.get(fieldName)?.label ?? fieldName;
      fields.issues.push(`${what} on "${label}" no longer applies (${e.message}); it was dropped`);
      return false;
    }
  };
  /** A board's or calendar's field, if it still exists and can still be used for it. */
  const layoutField = (
    key: string | undefined,
    what: string,
    fits: (field: FieldState) => boolean,
    needs: string,
  ): string | null => {
    if (key === OCCURRED_AT && object.isEvent && what === 'The calendar date') return OCCURRED_AT;
    const fieldName = key && fields.name(key, what);
    if (!fieldName) return null;
    const field = object.fieldsByName.get(fieldName);
    if (field && fits(field)) return fieldName;
    fields.issues.push(
      `${what} used "${field?.label ?? fieldName}", which is no longer a ${needs} field; it was dropped`,
    );
    return null;
  };
  const columns: ViewColumns | null = config.columns
    ? {
        order: config.columns.order
          .map((k) => fields.columnName(k, 'A column'))
          .filter((n): n is string => !!n),
        ...(config.columns.widths
          ? {
              widths: renameKeys(config.columns.widths, (k) =>
                fields.columnName(k, 'A column width'),
              ),
            }
          : {}),
        ...(config.columns.aggregates
          ? {
              aggregates: renameKeys(config.columns.aggregates, (k) =>
                fields.name(k, 'A column calculation'),
              ) as ViewColumns['aggregates'],
            }
          : {}),
      }
    : null;
  const groupName = config.groupBy && fields.name(config.groupBy, 'The grouping');
  const grouping = groupName ? groupingKind(object, groupName) : undefined;
  const groupBy =
    grouping && row.kind !== 'calendar' && !(row.kind === 'board' && grouping === 'date')
      ? (groupName ?? null)
      : null;
  if (groupName && !groupBy)
    fields.issues.push(`The grouping on "${groupName}" no longer applies; it was dropped`);
  const groupField = groupBy ? object.fieldsByName.get(groupBy) : undefined;
  const groupOptions = grouping === 'select' && groupField ? optionValues(groupField) : undefined;
  const sort =
    config.sort
      ?.map((s) => {
        const fieldName = fields.name(s.field, 'The sort');
        const entry = fieldName ? { field: fieldName, direction: s.direction } : undefined;
        return entry && compiles('The sort', entry.field, () => compileSort(tx, object, [entry]))
          ? entry
          : undefined;
      })
      .filter((s) => !!s) ?? [];
  const aggregateField = config.groupAggregate
    ? fields.name(config.groupAggregate.field, 'The column header calculation')
    : undefined;
  return {
    id: row.id,
    object: object.name,
    name: row.name,
    description: row.description,
    search: config.search ?? null,
    granularity: groupBy && grouping === 'date' ? (config.granularity ?? null) : null,
    groupOrder: groupBy ? (config.groupOrder ?? null) : null,
    hideEmptyGroups: groupBy && grouping === 'select' ? (config.hideEmptyGroups ?? null) : null,
    kind: row.kind,
    visibility: row.visibility,
    position: row.position,
    filter:
      (config.filter &&
        renameFilter(config.filter, (k, stored) => {
          const fieldName = fields.name(k, 'The filter');
          if (!fieldName) return undefined;
          const field = object.fieldsByName.get(fieldName);
          const { condition, removed } = withoutRemovedOptions(field, stored);
          if (removed.length)
            fields.issues.push(
              `The filter on "${field?.label ?? fieldName}" named ${removed.map((v) => `"${v}"`).join(', ')}, no longer ${removed.length > 1 ? 'options' : 'an option'}; ${condition === undefined ? 'the condition was dropped' : 'it was dropped from the condition'}`,
            );
          return condition !== undefined &&
            compiles('The filter', fieldName, () =>
              compileFilter(tx, object, { [fieldName]: condition }),
            )
            ? [fieldName, condition]
            : undefined;
        })) ??
      null,
    sort: sort.length ? sort : null,
    columns,
    groupBy,
    // A hidden column for an option that was removed has nothing left to hide.
    hiddenGroups: (groupBy ? (config.hiddenGroups ?? []) : []).filter(
      (v) => v === null || !groupOptions || groupOptions.has(v),
    ),
    groupAggregate:
      groupBy && aggregateField && config.groupAggregate
        ? {
            field: aggregateField,
            op: config.groupAggregate.op as NonNullable<SavedView['groupAggregate']>['op'],
          }
        : null,
    dateField: layoutField(
      config.dateField,
      'The calendar date',
      canPlaceBy,
      'filterable date or date-time',
    ),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    get issues() {
      return [...new Set([...(config.issues ?? []), ...fields.issues])];
    },
  };
}

/** Views the caller may see: the workspace's, and their own private ones (rule 1.4.4). */
function visibleTo(tx: Tx, actor: Actor, reader?: Actor) {
  return tx`(v.visibility = 'workspace'
    or (v.created_by ->> 'type' = ${actor.type} and v.created_by ->> 'id' = ${actor.id})
    ${reader ? tx`or (v.created_by ->> 'type' = ${reader.type} and v.created_by ->> 'id' = ${reader.id})` : tx``})`;
}

/**
 * A view schema changes and reads hold the schema lock shared, so the
 * schema a view is checked against stays current until commit (3).
 */
async function withViews<T>(
  sql: Sql,
  caller: Caller,
  fn: (tx: Tx, schema: CompiledSchema) => Promise<T>,
  write = false,
): Promise<T> {
  if (!write) return withRead(sql, caller, fn, { schema: true });
  return inWorkspace(sql, caller.workspaceId, async (tx) => {
    await lockSchemaShared(tx, caller.workspaceId);
    await admitCaller(tx, caller, write);
    return fn(tx, await getSchema(tx, caller.workspaceId));
  });
}

/** The view and its active object; `forUpdate` locks the row until commit. */
export async function loadView(
  tx: Tx,
  schema: CompiledSchema,
  caller: Caller,
  id: string,
  forUpdate = false,
): Promise<{ row: ViewRow; object: CompiledObject }> {
  const [row] = await tx<ViewRow[]>`
    select v.* from views v where v.id = ${id} and ${visibleTo(tx, caller.actor, forUpdate ? undefined : (caller.viewReader ?? (caller.person && { type: 'user', id: caller.person.id })))}
    ${forUpdate ? tx`for update` : tx``}`;
  const object = row && schema.objectsById.get(row.object_type_id);
  if (!row || !object || object.hidden || object.state.status !== 'active')
    throw notFound(`view ${id}`);
  return { row, object };
}

export async function listViews(
  sql: Sql,
  caller: Caller,
  objectName?: string,
): Promise<{ views: SavedView[] }> {
  return withViews(sql, caller, async (tx, schema) => {
    const ids = objectName ? [requireObject(schema, objectName).id] : schema.visibleObjectIds;
    const reader = caller.viewReader ?? (caller.person && { type: 'user', id: caller.person.id });
    const rows = await tx<ViewRow[]>`
      select v.* from views v
      where v.object_type_id = any(${ids}::uuid[]) and ${visibleTo(tx, caller.actor, reader)}
      order by v.position, v.created_at, v.id`;
    return {
      views: rows.flatMap((row) => {
        const object = schema.objectsById.get(row.object_type_id);
        return object ? [presentView(tx, object, row)] : [];
      }),
    };
  });
}

export async function readView(sql: Sql, caller: Caller, id: string): Promise<SavedView> {
  return withViews(sql, caller, async (tx, schema) => {
    const { row, object } = await loadView(tx, schema, caller, id);
    return presentView(tx, object, row);
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export async function createView(
  sql: Sql,
  caller: Caller,
  objectName: string,
  input: CreateViewInput,
): Promise<SavedView> {
  return withViews(
    sql,
    caller,
    (tx) => createViewInTransaction(tx, caller, objectName, input),
    true,
  );
}

/** Used by installation control so schema, views and ownership commit together. */
export async function createViewInTransaction(
  tx: Tx,
  caller: Caller,
  objectName: string,
  input: CreateViewInput,
): Promise<SavedView> {
  const schema = await getSchema(tx, caller.workspaceId);
  const object = requireObject(schema, objectName);
  const config = nextConfig(tx, object, {}, input.kind, input);
  requireKindField(input.kind, config);
  await checkRelationGroups(tx, schema, object, config, true);
  let { position } = input;
  if (position === undefined) {
    const [last] = await tx<{ max: number | null }[]>`
        select max(v.position) as max from views v
        where v.object_type_id = ${object.id} and ${visibleTo(tx, caller.actor)}`;
    position = (last?.max ?? 0) + 1;
  }
  const [row] = await tx<ViewRow[]>`
      insert into views (workspace_id, object_type_id, name, description, kind, visibility, position, config,
        created_by, updated_by)
      values (${caller.workspaceId}, ${object.id}, ${input.name}, ${input.description ?? null}, ${input.kind}, ${input.visibility},
        ${position}, ${tx.json(jsonValue(config))}, ${tx.json(caller.actor)},
        ${tx.json(caller.actor)})
      returning *`;
  if (!row) throw new Error('view insert returned no row');
  return presentView(tx, object, row);
}

/**
 * A view an extension contributes: a workspace table of these fields, named by
 * universal ID. Installation control stores it as the view's publisher base.
 */
export type ManagedView = { name: string; fieldIds: readonly string[] };

/** The stored row a managed view describes, or null when a field no longer exists. */
function managedRow(object: CompiledObject, view: ManagedView, activeOnly: boolean) {
  const keys = view.fieldIds.map(
    (id) =>
      object.state.fields.find(
        (f) => f.universalId === id && (!activeOnly || f.status === 'active'),
      )?.key,
  );
  if (keys.some((k) => !k)) return null;
  const config: StoredViewConfig = { columns: { order: keys as string[] } };
  return { name: view.name, kind: 'table' as const, visibility: 'workspace' as const, config };
}

/**
 * Whether the workspace changed a managed view since installation control
 * last stored it from `base`: its name, kind, visibility or any of its config
 * (columns, order, widths, filter, sort, grouping). A deleted view counts as
 * changed. With `lock`, the row stays locked until commit.
 */
export async function managedViewEdited(
  tx: Tx,
  workspaceId: string,
  id: string,
  base: ManagedView,
  lock = false,
): Promise<boolean> {
  const [row] = await tx<ViewRow[]>`select * from views where id = ${id}
    ${lock ? tx`for update` : tx``}`;
  const object = row && (await getSchema(tx, workspaceId)).objectsById.get(row.object_type_id);
  const expected = object && managedRow(object, base, false);
  if (!row || !expected) return true;
  const [same] = await tx<{ same: boolean }[]>`
    select ${tx.json(jsonValue(row.config))}::jsonb = ${tx.json(jsonValue(expected.config))}::jsonb as same`;
  return !(
    same?.same &&
    row.name === expected.name &&
    row.kind === expected.kind &&
    row.visibility === expected.visibility
  );
}

/**
 * Replaces a managed view with the publisher's next definition, but only while
 * the workspace has not edited it since `base` (checked under the row lock).
 * Returns false, changing nothing, when it has.
 */
export async function replaceManagedView(
  tx: Tx,
  caller: Caller,
  id: string,
  base: ManagedView,
  next: ManagedView,
): Promise<boolean> {
  if (await managedViewEdited(tx, caller.workspaceId, id, base, true)) return false;
  const [row] = await tx<ViewRow[]>`select * from views where id = ${id}`;
  const object =
    row && (await getSchema(tx, caller.workspaceId)).objectsById.get(row.object_type_id);
  const desired = object && managedRow(object, next, true);
  if (!row || !desired) throw invalidView('managed view fields are not active');
  await tx`update views set name = ${desired.name}, config = ${tx.json(jsonValue(desired.config))},
    updated_by = ${tx.json(caller.actor)}, updated_at = now() where id = ${id}`;
  return true;
}

/**
 * Changes only the keys the input gives. The row is locked first, so two
 * updates of different keys at once both land (rule 1.4).
 */
export async function updateView(
  sql: Sql,
  caller: Caller,
  id: string,
  input: UpdateViewInput,
): Promise<SavedView> {
  return withViews(
    sql,
    caller,
    async (tx, schema) => {
      const { row, object } = await loadView(tx, schema, caller, id, true);
      if (input.visibility !== undefined && input.visibility !== row.visibility) {
        if (!sameActor(row.created_by, caller.actor))
          throw forbidden('only the person or agent that created a view can change who sees it');
      }
      if (input.expectedUpdatedAt && input.expectedUpdatedAt !== row.updated_at.toISOString())
        throw new AppError(
          409,
          'view_changed',
          'This view changed. Review the latest version and try again.',
        );
      const kind = input.kind ?? row.kind;
      const config = nextConfig(tx, object, row.config, kind, input);
      delete config.issues;
      await checkRelationGroups(tx, schema, object, config, true);
      // Check the kind's field when the request changes either, so a view
      // whose field was removed can still be renamed or moved.
      if (input.kind !== undefined || input.groupBy === null || input.dateField === null)
        requireKindField(kind, presentView(tx, object, { ...row, config }));
      const [updated] = await tx<ViewRow[]>`
      update views set
        name = ${input.name ?? row.name},
        description = ${input.description === undefined ? row.description : input.description},
        kind = ${kind},
        visibility = ${input.visibility ?? row.visibility},
        position = ${input.position ?? row.position},
        config = ${tx.json(jsonValue(config))},
        updated_by = ${tx.json(caller.actor)},
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
      where id = ${id}
      returning *`;
      if (!updated) throw notFound(`view ${id}`);
      return presentView(tx, object, updated);
    },
    true,
  );
}

export async function deleteView(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<{ id: string; deleted: true }> {
  return withViews(
    sql,
    caller,
    async (tx, schema) => {
      await loadView(tx, schema, caller, id, true);
      await tx`delete from views where id = ${id}`;
      return { id, deleted: true };
    },
    true,
  );
}

/**
 * Rewrites the stored views of these objects without what a schema change
 * made unusable: removed fields, filters and sorts that no longer compile,
 * options that are gone, and a board or calendar field that no longer fits
 * (rule 1.4.2). Runs in the schema change's transaction, against the schema
 * it leaves, so a view is repaired once rather than on every read. A view the
 * repair can't store is left as it is; reading it still drops what it can't use.
 */
export async function repairViews(
  tx: Tx,
  schema: CompiledSchema,
  objectTypeIds: string[],
  actor: Actor,
): Promise<void> {
  if (objectTypeIds.length === 0) return;
  const rows = await tx<ViewRow[]>`
    select * from views where object_type_id = any(${objectTypeIds}::uuid[])`;
  for (const row of rows) {
    const object = schema.objectsById.get(row.object_type_id);
    if (object?.state.status !== 'active') continue;
    const view = presentView(tx, object, row);
    let config: StoredViewConfig;
    try {
      config = merge(
        row.config,
        toStored(tx, object, {
          filter: view.filter,
          sort: view.sort,
          columns: view.columns,
          groupBy: view.groupBy,
          granularity: view.granularity,
          groupOrder: view.groupOrder,
          hideEmptyGroups: view.hideEmptyGroups,
          hiddenGroups: view.hiddenGroups,
          groupAggregate: view.groupAggregate,
          dateField: view.dateField,
        }),
      );
    } catch (e) {
      if (!(e instanceof AppError) || e.status >= 500) throw e;
      continue;
    }
    if (view.issues.length) config.issues = view.issues;
    if (JSON.stringify(config) === JSON.stringify(row.config)) continue;
    await tx`
      update views set config = ${tx.json(jsonValue(config))}, updated_by = ${tx.json(actor)},
        updated_at = greatest(clock_timestamp(), updated_at + interval '1 millisecond')
      where id = ${row.id}`;
  }
}

const createDraftSchema = createViewSchema
  .omit({ visibility: true, position: true })
  .extend({ object: z.string().min(1).optional() });
const editDraftSchema = updateViewSchema
  .omit({ visibility: true, position: true, expectedUpdatedAt: true })
  .extend({ view: z.uuid() });

export const viewDraftSchema = z.union([createDraftSchema, editDraftSchema]);

/** Resolve a chat draft through the same config validation used by create and update. */
export async function checkView(
  sql: Sql,
  caller: Caller,
  draft: unknown,
  objectName?: string,
): Promise<ViewCheckResult> {
  const parsed =
    isPlainObject(draft) && Object.hasOwn(draft, 'view')
      ? editDraftSchema.safeParse(draft)
      : createDraftSchema.safeParse(draft);
  if (!parsed.success)
    return {
      ok: false as const,
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.') || 'draft',
        message: issue.message,
      })),
    };
  try {
    return await withRead(
      sql,
      caller,
      async (tx, schema) => {
        const input = parsed.data;
        const saved = 'view' in input ? await loadView(tx, schema, caller, input.view) : undefined;
        const name = 'object' in input ? (input.object ?? objectName) : objectName;
        const object = saved?.object ?? (name && requireObject(schema, name));
        if (!object) throw invalidView('A new draft requires object', { path: 'object' });
        if (name && requireObject(schema, name).id !== object.id)
          throw invalidView('The view belongs to a different object', { path: 'object' });
        const kind = input.kind ?? saved?.row.kind;
        if (!kind) throw invalidView('A draft requires a layout', { path: 'kind' });
        const before = saved?.row;
        const config = nextConfig(tx, object, before?.config ?? {}, kind, input);
        const unchanged = 'view' in input && Object.keys(input).length === 1;
        if (!unchanged) requireKindField(kind, config);
        await checkRelationGroups(tx, schema, object, config);
        const now = new Date();
        const preview = presentView(tx, object, {
          id: before?.id ?? '',
          object_type_id: object.id,
          kind,
          config,
          name: input.name ?? before?.name ?? '',
          description:
            input.description === undefined ? (before?.description ?? null) : input.description,
          visibility: before?.visibility ?? 'private',
          position: before?.position ?? 0,
          created_by: before?.created_by ?? caller.actor,
          updated_by: before?.updated_by ?? caller.actor,
          created_at: before?.created_at ?? now,
          updated_at: before?.updated_at ?? now,
        });
        const result = await aggregateRecords(
          tx,
          caller.workspaceId,
          schema,
          object,
          {
            filter: preview.filter ?? undefined,
            search: preview.search ?? undefined,
            groupBy: preview.groupBy ?? undefined,
            granularity: preview.granularity ?? undefined,
            aggregates: preview.groupAggregate ? [preview.groupAggregate] : [],
          },
          undefined,
          { hidden: preview.hiddenGroups },
        );
        return {
          ok: true as const,
          problems: [],
          count: result.total,
          groups:
            result.groups &&
            displayViewGroups(
              result.groups,
              preview,
              object.fieldsByName.get(preview.groupBy ?? ''),
            ),
          preview,
        };
      },
      { schema: true },
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.status >= 500) throw error;
    const details = error.details;
    const path =
      typeof details?.path === 'string'
        ? details.path
        : typeof details?.field === 'string'
          ? details.field
          : 'draft';
    return { ok: false as const, problems: [{ path, message: error.message }] };
  }
}
