import {
  type Actor,
  AGGREGATE_OPS,
  canGroupBy,
  canPlaceBy,
  SAVED_VIEW_KINDS,
  SAVED_VIEW_VISIBILITIES,
  type SavedView,
  sameActor,
  type ViewColumns,
} from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { StoredViewConfig } from '../db/schema.js';
import { inWorkspace, jsonValue, lockSchemaShared, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { admitCaller } from '../extension-runtime/admission.js';
import { checkAggregateOp } from '../records/aggregate.js';
import { builtInNames, compileFilter, compileSort, queryInputSchema } from '../records/query.js';
import { requireObject } from '../records/service.js';
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
const position = z.number().finite();

export const createViewSchema = z.strictObject({
  name,
  kind: z.enum(SAVED_VIEW_KINDS),
  visibility: z.enum(SAVED_VIEW_VISIBILITIES).default('workspace'),
  position: position.optional(),
  ...configShape,
});
export type CreateViewInput = z.infer<typeof createViewSchema>;

export const updateViewSchema = z.strictObject({
  name: name.optional(),
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
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === 'and' || k === 'or') {
      if (!Array.isArray(v)) continue;
      const parts = v
        .filter(isPlainObject)
        .map((f) => renameFilter(f, rename))
        .filter((f): f is Record<string, unknown> => !!f);
      if (parts.length) out[k] = parts;
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
  if (given('groupBy'))
    out.groupBy = input.groupBy
      ? kindField(
          input.groupBy,
          'groupBy',
          canGroupBy,
          'a board groups by a filterable select field',
        )
      : undefined;
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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

type ViewRow = {
  id: string;
  object_type_id: string;
  name: string;
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
  const groupBy = layoutField(
    config.groupBy,
    'The board grouping',
    canGroupBy,
    'filterable select',
  );
  const groupField = groupBy ? object.fieldsByName.get(groupBy) : undefined;
  const groupOptions = groupField && optionValues(groupField);
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
    hiddenGroups: (config.hiddenGroups ?? []).filter(
      (v) => v === null || !groupOptions || groupOptions.has(v),
    ),
    groupAggregate:
      aggregateField && config.groupAggregate
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
    issues: fields.issues,
  };
}

/** Views the caller may see: the workspace's, and their own private ones (rule 1.4.4). */
function visibleTo(tx: Tx, actor: Actor) {
  return tx`(v.visibility = 'workspace'
    or (v.created_by ->> 'type' = ${actor.type} and v.created_by ->> 'id' = ${actor.id}))`;
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
  return inWorkspace(sql, caller.workspaceId, async (tx) => {
    await lockSchemaShared(tx, caller.workspaceId);
    await admitCaller(tx, caller, write);
    return fn(tx, await getSchema(tx, caller.workspaceId));
  });
}

/** The view and its active object; `forUpdate` locks the row until commit. */
async function loadView(
  tx: Tx,
  schema: CompiledSchema,
  caller: Caller,
  id: string,
  forUpdate = false,
): Promise<{ row: ViewRow; object: CompiledObject }> {
  const [row] = await tx<ViewRow[]>`
    select v.* from views v where v.id = ${id} and ${visibleTo(tx, caller.actor)}
    ${forUpdate ? tx`for update` : tx``}`;
  const object = row && schema.objectsById.get(row.object_type_id);
  if (!row || !object || object.state.status !== 'active') throw notFound(`view ${id}`);
  return { row, object };
}

export async function listViews(
  sql: Sql,
  caller: Caller,
  objectName: string,
): Promise<{ views: SavedView[] }> {
  return withViews(sql, caller, async (tx, schema) => {
    const object = requireObject(schema, objectName);
    const rows = await tx<ViewRow[]>`
      select v.* from views v
      where v.object_type_id = ${object.id} and ${visibleTo(tx, caller.actor)}
      order by v.position, v.created_at, v.id`;
    return { views: rows.map((r) => presentView(tx, object, r)) };
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
  const config = merge({}, toStored(tx, object, input));
  requireKindField(input.kind, config);
  let { position } = input;
  if (position === undefined) {
    const [last] = await tx<{ max: number | null }[]>`
        select max(v.position) as max from views v
        where v.object_type_id = ${object.id} and ${visibleTo(tx, caller.actor)}`;
    position = (last?.max ?? 0) + 1;
  }
  const [row] = await tx<ViewRow[]>`
      insert into views (workspace_id, object_type_id, name, kind, visibility, position, config,
        created_by, updated_by)
      values (${caller.workspaceId}, ${object.id}, ${input.name}, ${input.kind}, ${input.visibility},
        ${position}, ${tx.json(jsonValue(config))}, ${tx.json(caller.actor)},
        ${tx.json(caller.actor)})
      returning *`;
  if (!row) throw new Error('view insert returned no row');
  return presentView(tx, object, row);
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
      const config = merge(row.config, toStored(tx, object, input));
      const kind = input.kind ?? row.kind;
      // Check the kind's field when the request changes either, so a view
      // whose field was removed can still be renamed or moved.
      if (input.kind !== undefined || input.groupBy === null || input.dateField === null)
        requireKindField(kind, presentView(tx, object, { ...row, config }));
      const [updated] = await tx<ViewRow[]>`
      update views set
        name = ${input.name ?? row.name},
        kind = ${kind},
        visibility = ${input.visibility ?? row.visibility},
        position = ${input.position ?? row.position},
        config = ${tx.json(jsonValue(config))},
        updated_by = ${tx.json(caller.actor)},
        updated_at = now()
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
          hiddenGroups: view.hiddenGroups,
          groupAggregate: view.groupAggregate,
          dateField: view.dateField,
        }),
      );
    } catch (e) {
      if (!(e instanceof AppError) || e.status >= 500) throw e;
      continue;
    }
    if (JSON.stringify(config) === JSON.stringify(row.config)) continue;
    await tx`
      update views set config = ${tx.json(jsonValue(config))}, updated_by = ${tx.json(actor)},
        updated_at = now()
      where id = ${row.id}`;
  }
}
