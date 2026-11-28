import { AGGREGATE_GRANULARITIES, type SavedView } from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { aggregateInputSchema, aggregateRecords, groupConstraint } from '../records/aggregate.js';
import { compileFilter, queryInputSchema, queryRecords } from '../records/query.js';
import { plainPrefixQuery } from '../records/search-sql.js';
import { aggregate, findRecords, requireObject, withRead } from '../records/service.js';
import { loadView, presentView } from './service.js';

const viewId = z.uuid().optional().describe('A saved view ID from list_views');
export const viewQuerySchema = queryInputSchema.extend({
  view: viewId,
  groupMatch: z
    .strictObject({
      field: z.string(),
      granularity: z.enum(AGGREGATE_GRANULARITIES).optional(),
      values: z.array(z.string().nullable()).max(250),
      exclude: z.boolean().optional(),
    })
    .optional(),
});
export const viewAggregateSchema = aggregateInputSchema.extend({
  view: viewId,
  aggregates: aggregateInputSchema.shape.aggregates.removeDefault().optional(),
  viewGroups: z
    .strictObject({ hidden: z.array(z.string().nullable()).max(200).optional() })
    .optional(),
});

function objectRequired(object: string | undefined) {
  if (!object) throw new AppError(422, 'invalid_input', 'Provide object or view');
  return object;
}

function viewConditions(
  tx: Tx,
  object: Parameters<typeof compileFilter>[1],
  view: SavedView | undefined,
) {
  const filter = view?.filter ? compileFilter(tx, object, view.filter) : tx`true`;
  return view?.search ? tx`${filter} and r.search @@ ${plainPrefixQuery(tx, view.search)}` : filter;
}

export async function queryWithView(
  sql: Sql,
  caller: Caller,
  name: string | undefined,
  input: z.infer<typeof viewQuerySchema>,
) {
  const { view: id, groupMatch, ...query } = input;
  if (!id && !groupMatch) return findRecords(sql, caller, objectRequired(name), query);
  return withRead(
    sql,
    caller,
    async (tx, schema) => {
      const saved = id ? await loadView(tx, schema, caller, id) : undefined;
      const object = saved?.object ?? requireObject(schema, objectRequired(name));
      if (saved && name && requireObject(schema, name).id !== object.id)
        throw new AppError(422, 'invalid_view', 'The view belongs to a different object');
      const view = saved && presentView(tx, object, saved.row);
      const group = groupMatch ? groupConstraint(tx, schema, object, groupMatch) : tx`true`;
      const result = await queryRecords(
        tx,
        caller.workspaceId,
        schema,
        object,
        {
          ...query,
          sort: query.sort ?? view?.sort ?? undefined,
        },
        tx`${viewConditions(tx, object, view)} and ${group}`,
      );
      return view?.issues.length ? { ...result, issues: view.issues } : result;
    },
    { schema: true },
  );
}

export async function aggregateWithView(
  sql: Sql,
  caller: Caller,
  name: string | undefined,
  input: z.infer<typeof viewAggregateSchema>,
) {
  const { view: id, viewGroups, ...query } = input;
  if (!id && !viewGroups)
    return aggregate(sql, caller, objectRequired(name), {
      ...query,
      aggregates: query.aggregates ?? [],
    });
  return withRead(
    sql,
    caller,
    async (tx, schema) => {
      const saved = id ? await loadView(tx, schema, caller, id) : undefined;
      const object = saved?.object ?? requireObject(schema, objectRequired(name));
      if (saved && name && requireObject(schema, name).id !== object.id)
        throw new AppError(422, 'invalid_view', 'The view belongs to a different object');
      const view = saved && presentView(tx, object, saved.row);
      const result = await aggregateRecords(
        tx,
        caller.workspaceId,
        schema,
        object,
        {
          ...query,
          groupBy: query.groupBy ?? view?.groupBy ?? undefined,
          granularity:
            query.granularity ?? (query.groupBy ? undefined : (view?.granularity ?? undefined)),
          aggregates: query.aggregates ?? (view?.groupAggregate ? [view.groupAggregate] : []),
        },
        viewConditions(tx, object, view),
        viewGroups,
      );
      return view?.issues.length ? { ...result, issues: view.issues } : result;
    },
    { schema: true },
  );
}
