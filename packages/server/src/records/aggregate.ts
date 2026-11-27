import {
  AGGREGATE_GRANULARITIES,
  AGGREGATE_MAX_GROUPS,
  AGGREGATE_OPS,
  type AggregateGroup,
  type AggregateOp,
  type AggregateResult,
  type AggregateValue,
  aggregateOps,
  canGroupBy,
  canPlaceBy,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import type { CompiledObject, CompiledSchema } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';
import {
  builtInColumn,
  compileEventFilter,
  compileFilter,
  emptyValue,
  eventQueryColumn,
  liveLinks,
  matchingEvents,
  matchingRecords,
  queryInputSchema,
  typed,
} from './query.js';
import { references } from './references.js';

export const aggregateInputSchema = queryInputSchema.pick({ search: true, filter: true }).extend({
  aggregates: z
    .array(
      z.strictObject({ field: z.string(), op: z.enum(AGGREGATE_OPS), as: z.string().optional() }),
    )
    .max(50)
    .default([]),
  groupBy: z
    .string()
    .optional()
    .describe(
      'Group by a filterable select, date or single relation, or by createdAt, updatedAt or occurredAt.',
    ),
  granularity: z.enum(AGGREGATE_GRANULARITIES).optional(),
  limit: z.number().int().min(1).max(AGGREGATE_MAX_GROUPS).optional(),
});
export type AggregateInput = z.infer<typeof aggregateInputSchema>;

const invalidAggregate = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, 'invalid_aggregate', message, details);

/** Throws `fail(…)` unless the field supports the op, listing the ops it does. */
export function checkAggregateOp(
  field: FieldState,
  op: AggregateOp,
  fail: (message: string, details: Record<string, unknown>) => Error,
): void {
  const allowed = aggregateOps(field);
  if (!allowed.includes(op))
    throw fail(`${field.name} (${field.type}) does not support "${op}"`, {
      field: field.name,
      allowed,
    });
}

/** One aggregate as named SQL columns; money also reports its currencies. */
function columns(tx: Tx, field: FieldState, op: AggregateOp, n: number): Fragment {
  const value = tx(`a${n}`),
    currencies = tx(`c${n}`),
    currency = tx(`u${n}`);
  const empty = emptyValue(tx, field);
  switch (op) {
    case 'countEmpty':
    case 'percentEmpty':
      return tx`count(*) filter (where ${empty})::int as ${value}`;
    case 'countNotEmpty':
    case 'percentNotEmpty':
      return tx`count(*) filter (where not ${empty})::int as ${value}`;
    case 'countUnique':
      return field.type === 'relation'
        ? // A many-to-one field links each record to at most one live target.
          tx`count(distinct (select l.target_record_id ${liveLinks(tx, field)}))::int as ${value}`
        : tx`count(distinct r.data -> ${field.key}) filter (where not ${empty})::int as ${value}`;
    default: {
      const fn = tx.unsafe(op);
      const result =
        field.type === 'date' || field.type === 'date_time'
          ? tx`to_json(${fn}(${typed(tx, field)})) #>> '{}' as ${value}`
          : tx`${fn}(${typed(tx, field)})::float8 as ${value}`;
      if (field.type !== 'money') return result;
      const code = tx`(r.data -> ${field.key} ->> 'currency')`;
      return tx`${result}, count(distinct ${code})::int as ${currencies}, min(${code}) as ${currency}`;
    }
  }
}

type AggregatePlanInput = Pick<AggregateInput, 'groupBy' | 'granularity'> & {
  aggregates?: AggregateInput['aggregates'];
};

function planAggregateRequests(
  object: CompiledObject | undefined,
  aggregates: AggregateInput['aggregates'] = [],
): AggregateRequest[] {
  return aggregates.map(({ field: name, op, as }) => {
    const field = object?.fieldsByName.get(name);
    if (!field)
      throw invalidAggregate(`unknown field "${name}" on ${object?.name ?? 'event'}`, {
        field: name,
        allowed:
          object?.activeFields.filter((f) => aggregateOps(f).length).map((f) => f.name) ?? [],
      });
    checkAggregateOp(field, op, invalidAggregate);
    return { field, op, as };
  });
}

function aggregateGrouping(
  tx: Tx,
  object: CompiledObject | undefined,
  input: Pick<AggregateInput, 'groupBy' | 'granularity'>,
) {
  const grouping = planAggregateGrouping(tx, object, input);
  if (input.granularity && grouping?.kind !== 'date')
    throw invalidAggregate('granularity requires a date grouping');
  return grouping;
}

function planAggregateGrouping(
  tx: Tx,
  object: CompiledObject | undefined,
  input: Pick<AggregateInput, 'groupBy' | 'granularity'>,
) {
  if (input.groupBy === undefined) return null;
  const name = input.groupBy;
  const field = object?.fieldsByName.get(name);
  const builtin = object ? builtInColumn(tx, object, name) : eventQueryColumn(tx, name);
  const dateColumn =
    builtin?.type === 'timestamptz'
      ? builtin.expr
      : field && canPlaceBy(field)
        ? typed(tx, field)
        : undefined;
  const relation =
    field?.type === 'relation' &&
    field.isFilterable &&
    field.settings.relationCardinality === 'many_to_one' &&
    !field.settings.isInverse;
  if (dateColumn) return { kind: 'date' as const, dateColumn, field };
  if (field && relation) return { kind: 'relation' as const, field };
  if (field && canGroupBy(field)) return { kind: 'select' as const, field };
  throw invalidAggregate(
    `groupBy requires a filterable select, date or single relation; "${name}" is not one`,
    { field: name },
  );
}

export function checkAggregate(
  tx: Tx,
  schema: CompiledSchema,
  object: CompiledObject | undefined,
  input: AggregatePlanInput & Pick<AggregateInput, 'filter'>,
): void {
  planAggregateRequests(object, input.aggregates);
  if (input.filter) {
    if (object) compileFilter(tx, object, input.filter);
    else compileEventFilter(tx, schema, input.filter);
  }
  aggregateGrouping(tx, object, input);
}

/**
 * The total of the records a filter and search match, and each requested
 * aggregate over them, in one query.
 */
export async function aggregateRecords(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  object: CompiledObject | undefined,
  input: AggregateInput,
): Promise<AggregateResult> {
  const requests = planAggregateRequests(object, input.aggregates);
  const selected = [
    tx`count(*)::int as total`,
    ...requests.map((r, n) => columns(tx, r.field, r.op, n)),
  ].reduce((a, b) => tx`${a}, ${b}`);
  const from = object
    ? tx`records r`
    : tx`records r join event_records e
    on e.record_id = r.id and e.workspace_id = r.workspace_id`;
  const where = object
    ? matchingRecords(tx, workspaceId, schema, object, input)
    : matchingEvents(tx, workspaceId, schema, input);
  const grouping = aggregateGrouping(tx, object, input);
  if (!grouping) {
    const [row] = await tx<AggregateRow[]>`select ${selected} from ${from} where ${where}`;
    return valuesOf(requests, row);
  }
  const { field } = grouping;
  const date = grouping.kind === 'date';
  const granularity = input.granularity ?? 'month';
  // A select's groups are bounded by its options; the others take a default limit.
  const limit = input.limit ?? (grouping.kind === 'select' ? null : 50);
  let expression: Fragment;
  if (grouping.kind === 'date') {
    const zone = tx`coalesce((select settings ->> 'timeZone' from workspaces
      where id = ${workspaceId}), 'UTC')`;
    const local =
      field?.type === 'date'
        ? grouping.dateColumn
        : tx`(${grouping.dateColumn} at time zone ${zone})`;
    expression = tx`date_trunc(${granularity}::text, ${local}::timestamp)::date`;
  } else if (grouping.kind === 'relation') {
    expression = tx`(select l.target_record_id ${liveLinks(tx, grouping.field)}
      and t.object_type_id = any(${schema.visibleObjectIds}::uuid[]) limit 1)`;
  } else {
    expression = tx`r.data ->> ${grouping.field.key}`;
  }
  const next = date ? tx`r.g desc nulls last` : tx`total desc, r.g asc nulls last`;
  // The overall row uses all matching records. Return one extra group to
  // detect truncation, and retain the earliest date for bounded gap filling.
  const rows = await tx<AggregateRow[]>`
    select r.g::text as g, grouping(r.g) as overall, ${selected},
      ${date ? tx`min(r.g) over ()::text` : tx`null::text`} as earliest
    from (select r.*, ${expression} as g from ${from} where ${where}) r
    group by grouping sets ((r.g), ())
    order by grouping(r.g) desc, ${next}
    ${limit === null ? tx`` : tx`limit ${limit + 2}`}`;
  const [overall, ...groupRows] = rows;
  const groups: AggregateGroup[] = groupRows.map((row) => ({
    value: row.g === null ? null : String(row.g),
    label: row.g === null ? 'No value' : String(row.g),
    ...valuesOf(requests, row),
  }));
  if (date)
    return {
      ...valuesOf(requests, overall),
      ...dateGroups(
        groups,
        typeof overall?.earliest === 'string' ? overall.earliest : null,
        granularity,
        limit ?? 50,
        requests,
      ),
    };
  const options = new Map(field?.settings.options?.map((option) => [option.value, option.label]));
  if (grouping.kind === 'relation') {
    const ids = groups.flatMap(({ value }) => (value ? [value] : []));
    const labels = await references(tx, schema, ids);
    for (const id of ids) options.set(id, labels[id]?.label ?? 'Unnamed record');
  }
  return {
    ...valuesOf(requests, overall),
    groups: groups.slice(0, limit ?? undefined).map((group) => ({
      ...group,
      label: group.value === null ? group.label : (options.get(group.value) ?? group.label),
    })),
    ...(limit !== null && groups.length > limit ? { tooManyGroups: true as const } : {}),
  };
}

type AggregateRow = Record<string, number | string | null>;
type AggregateRequest = { field: FieldState; op: AggregateOp; as?: string | undefined };
type Granularity = NonNullable<AggregateInput['granularity']>;

function stepBack(date: Date, granularity: Granularity) {
  if (granularity === 'day' || granularity === 'week')
    date.setUTCDate(date.getUTCDate() - (granularity === 'day' ? 1 : 7));
  else date.setUTCMonth(date.getUTCMonth() - { month: 1, quarter: 3, year: 12 }[granularity]);
}

function periodLabel(value: string, date: Date, granularity: Granularity): string {
  if (granularity === 'quarter')
    return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  if (granularity === 'year') return String(date.getUTCFullYear());
  if (granularity === 'month')
    return date.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
  return value;
}

function dateGroups(
  rows: AggregateGroup[],
  earliest: string | null,
  granularity: Granularity,
  limit: number,
  requests: AggregateRequest[],
): Pick<AggregateResult, 'groups' | 'tooManyGroups'> {
  const latest = rows[0]?.value;
  if (!latest || !earliest) return { groups: rows };
  const byDate = new Map(rows.map((row) => [row.value, row]));
  const date = new Date(`${latest}T00:00:00Z`);
  // An empty period's sum is zero; for money, in the currency the series uses.
  const zero = requests.map((_, n) => {
    const money = rows
      .map((row) => row.values[n]?.value)
      .find((value) => typeof value === 'object' && value !== null);
    return money ? { amountMicros: 0, currency: money.currency } : 0;
  });
  const groups: AggregateGroup[] = [];
  let value = latest;
  while (value >= earliest && groups.length < limit) {
    const entry = byDate.get(value) ?? {
      value,
      total: 0,
      values: valuesOf(requests, undefined).values.map((aggregate, n) => ({
        ...aggregate,
        value: aggregate.op.startsWith('count')
          ? 0
          : aggregate.op === 'sum'
            ? (zero[n] ?? 0)
            : null,
      })),
    };
    groups.push({ ...entry, label: periodLabel(value, date, granularity) });
    stepBack(date, granularity);
    value = date.toISOString().slice(0, 10);
  }
  groups.reverse();
  const empty = byDate.get(null);
  if (empty && groups.length < limit) groups.push(empty);
  return {
    groups,
    ...(value >= earliest || rows.length > limit || (empty && !groups.includes(empty))
      ? { tooManyGroups: true as const }
      : {}),
  };
}

/** One result row as the API's total and values. */
function valuesOf(
  requests: AggregateRequest[],
  row: Record<string, number | string | null> | undefined,
): AggregateResult {
  const total = Number(row?.total ?? 0);
  return {
    total,
    values: requests.map(({ field, op, as }, n): AggregateValue => {
      const measure = { field: field.name, op, ...(as === undefined ? {} : { as }) };
      const raw = row?.[`a${n}`] ?? null;
      if (op === 'percentEmpty' || op === 'percentNotEmpty')
        return { ...measure, value: total ? (Number(raw) / total) * 100 : null };
      if (field.type !== 'money' || raw === null || op.startsWith('count'))
        return { ...measure, value: raw };
      if (Number(row?.[`c${n}`]) > 1) return { ...measure, value: null, mixedCurrencies: true };
      return {
        ...measure,
        value: { amountMicros: Math.round(Number(raw)), currency: String(row?.[`u${n}`]) },
      };
    }),
  };
}
