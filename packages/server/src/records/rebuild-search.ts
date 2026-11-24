import type { Sql } from '../db/client.js';
import { lockPrivacyShared, lockSchemaShared, type Tx } from '../db/tx.js';
import { getSchema } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';
import { searchTextOf } from './derive.js';
import { searchVector } from './search-sql.js';

/** Session advisory lock: one process rebuilds at a time. */
const REBUILD_LOCK = 0x52544e02;

/**
 * Recomputes the label and search text of records from their data, in one
 * statement: after a schema change (3) and when rebuilding stale records.
 */
export async function rewriteSearchText(
  tx: Tx,
  fields: FieldState[],
  labelField: FieldState | undefined,
  records: { id: string; data: Record<string, unknown> }[],
): Promise<void> {
  if (records.length === 0) return;
  const texts = records.map((r) => searchTextOf(fields, labelField, r.data));
  await tx`
    update records r
    set label = v.label, search = ${searchVector(tx, tx`coalesce(v.label, '')`, tx`v.body`)}
    from unnest(${records.map((r) => r.id)}::uuid[], ${texts.map((t) => t.label)}::text[],
      ${texts.map((t) => t.body)}::text[]) as v(id, label, body)
    where r.id = v.id`;
}

/**
 * Rebuilds `records.search` that a migration left null because the way it
 * is built changed (5.1). Facts need no rebuild: their
 * search text depends only on their own columns, so such a migration
 * computes it in SQL.
 *
 * Runs on every boot as the migration role, which owns the tables (no
 * row-level security); with nothing stale it is one lookup on an empty
 * partial index. A process that finds another one rebuilding returns at
 * once: stale records only fail to match until they are rebuilt. Every
 * batch is its own transaction and takes the schema lock before locking its
 * rows, as writers do; a row a writer rebuilt meanwhile is no longer
 * selected (`search is null`). `sql` must have `max: 1`, so the session lock
 * and the batches share one connection. Returns how many records it rebuilt.
 */
export async function rebuildSearchText(sql: Sql, { batch = 500 } = {}): Promise<number> {
  const [lock] = await sql<{ locked: boolean }[]>`
    select pg_try_advisory_lock(${REBUILD_LOCK}) as locked`;
  if (!lock?.locked) return 0;
  try {
    let rebuilt = 0;
    const stale = await sql<{ workspace_id: string }[]>`
      select distinct workspace_id from records
      where search is null and merged_into_id is null`;
    for (const { workspace_id: workspaceId } of stale) {
      for (;;) {
        const count = (await sql.begin((tx) =>
          rebuildBatch(tx as unknown as Tx, workspaceId, batch),
        )) as number;
        rebuilt += count;
        if (count < batch) break;
      }
    }
    return rebuilt;
  } finally {
    await sql`select pg_advisory_unlock(${REBUILD_LOCK})`;
  }
}

/** One resumable batch while the workspace keeps serving. Locked rows remain pending. */
export async function backfillSearchTextBatch(tx: Tx, workspaceId: string, batch: number) {
  await lockPrivacyShared(tx, workspaceId);
  const rebuilt = await rebuildBatch(tx, workspaceId, batch, true);
  const [remaining] = await tx<{ pending: boolean }[]>`
    select exists(select 1 from records where workspace_id = ${workspaceId}
      and search is null and merged_into_id is null) as pending`;
  return { rebuilt, pending: remaining?.pending ?? true };
}

async function rebuildBatch(
  tx: Tx,
  workspaceId: string,
  batch: number,
  skipLocked = false,
): Promise<number> {
  await lockSchemaShared(tx, workspaceId);
  const rows = await tx<{ id: string; object_type_id: string; data: Record<string, unknown> }[]>`
    select id, object_type_id, data from records
    where workspace_id = ${workspaceId} and search is null and merged_into_id is null
    order by id limit ${batch} for update ${skipLocked ? tx`skip locked` : tx``}`;
  if (rows.length === 0) return 0;
  const schema = await getSchema(tx, workspaceId);
  const byObject = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const group = byObject.get(row.object_type_id);
    if (group) group.push(row);
    else byObject.set(row.object_type_id, [row]);
  }
  for (const [objectTypeId, records] of byObject) {
    const object = schema.objectsById.get(objectTypeId);
    if (!object) throw new Error(`object type ${objectTypeId} not found`);
    await rewriteSearchText(tx, object.state.fields, object.labelField, records);
  }
  return rows.length;
}
