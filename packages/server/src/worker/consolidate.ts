import type { Fragment } from 'postgres';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockPrivacyShared, type Tx, tryLockConsolidator } from '../db/tx.js';
import { liveFactSource } from '../memory/events.js';

/**
 * The consolidator (4.2), run per workspace on a schedule. It never calls a
 * model and never changes what a claim says:
 *
 * - Exact duplicate facts (same record, same normalized text, same validity
 *   interval) are superseded by the oldest of them, which gains every
 *   duplicate's source links. The duplicates are kept. Near-duplicates and
 *   contradictions are left alone.
 * - Duplicate records are suggested, never merged: two live records of one
 *   object that share an email, phone or website domain, or whose labels
 *   are trigram-similar. A person decides (`POST /v1/records/:id/merge` or
 *   dismiss). A decided pair is never suggested again. Events are never
 *   suggested: each is something that happened, logged from its own source.
 */

/** Labels at least this trigram-similar suggest a duplicate (pg_trgm `similarity`). */
export const NAME_SIMILARITY = 0.6;
/** Shorter labels are too generic to compare. */
const MIN_LABEL_LENGTH = 3;
/** At most this many new suggestions per kind and run, so one run cannot flood review. */
export const MAX_NEW_SUGGESTIONS = 500;
/**
 * The next run compares records changed since this long before this run
 * started, so a write that committed while this run was reading is not
 * missed. Comparing a pair twice is harmless.
 */
const COMPARE_OVERLAP = '5 minutes';

export type ConsolidationStats = { supersededFacts: number; mergeSuggestions: number };

export type ConsolidateOptions = {
  /** Skip the workspace when its last run started less than this long ago (Postgres interval). */
  minInterval?: string;
  /** Overrides MAX_NEW_SUGGESTIONS (tests). */
  maxNewSuggestions?: number;
};

/**
 * Runs the consolidator for one workspace in one transaction. Returns null
 * when another worker holds the workspace or ran it within `minInterval`.
 * It holds the privacy lock in shared mode, so `forget` never interleaves.
 */
export async function consolidateWorkspace(
  sql: Sql,
  workspaceId: string,
  options: ConsolidateOptions = {},
): Promise<ConsolidationStats | null> {
  return inWorkspace(sql, workspaceId, async (tx) => {
    if (!(await tryLockConsolidator(tx, workspaceId))) return null;
    const [last] = await tx<{ compared_until: Date | null; due: boolean }[]>`
      select compared_until,
        ${options.minInterval ?? null}::interval is null
          or started_at < now() - ${options.minInterval ?? null}::interval as due
      from consolidator_runs where workspace_id = ${workspaceId}`;
    if (last && !last.due) return null;
    await lockPrivacyShared(tx, workspaceId);

    const since = last?.compared_until ?? null;
    const supersededFacts = await supersedeDuplicateFacts(tx, workspaceId, since);
    const merges = await suggestMerges(
      tx,
      workspaceId,
      since,
      options.maxNewSuggestions ?? MAX_NEW_SUGGESTIONS,
    );
    const stats: ConsolidationStats = { supersededFacts, mergeSuggestions: merges.added };
    // A capped run leaves pairs unsuggested, so the next run compares the
    // same records again instead of moving on (all of them after a first run).
    const comparedUntil = merges.capped
      ? tx`coalesce(${since}::timestamptz, 'epoch')`
      : tx`now() - ${COMPARE_OVERLAP}::interval`;
    await tx`
      insert into consolidator_runs (workspace_id, started_at, compared_until, stats)
      values (${workspaceId}, now(), ${comparedUntil}, ${tx.json(stats)})
      on conflict (workspace_id) do update
        set started_at = excluded.started_at, compared_until = excluded.compared_until,
          stats = excluded.stats`;
    return stats;
  });
}

/**
 * Pairs of (duplicate, canonical) among current facts of live records: not
 * retracted, not superseded, resting on a live source. The canonical fact
 * of a group is its oldest. `scope` narrows which facts are compared.
 */
async function duplicatePairs(
  tx: Tx,
  workspaceId: string,
  scope: Fragment,
): Promise<{ id: string; canonical: string }[]> {
  return tx<{ id: string; canonical: string }[]>`
    with current as (
      select f.id, f.record_id, f.created_at, f.valid_from, f.valid_to,
        lower(regexp_replace(btrim(f.content), '\\s+', ' ', 'g')) as norm
      from facts f
      join records r on r.id = f.record_id and r.deleted_at is null
      where f.workspace_id = ${workspaceId} and f.deleted_at is null and f.superseded_by is null
        and f.replaced_at is null and ${scope}
        and exists (${liveFactSource(tx, tx`f.id`)})
    ),
    grouped as (
      select id, first_value(id) over (
        partition by record_id, norm, valid_from, valid_to order by created_at, id) as canonical
      from current
    )
    select id, canonical from grouped where id <> canonical order by canonical, id`;
}

/**
 * Supersedes exact duplicate facts with their canonical fact. Returns how
 * many. After the first run, only records that gained a fact or changed
 * (a merge moves facts) since `since` can have new duplicates.
 */
async function supersedeDuplicateFacts(
  tx: Tx,
  workspaceId: string,
  since: Date | null,
): Promise<number> {
  const changed =
    since === null
      ? tx`true`
      : tx`f.record_id in (
          select id from records where workspace_id = ${workspaceId} and updated_at > ${since}
          union
          select record_id from facts where workspace_id = ${workspaceId} and created_at > ${since})`;
  const found = await duplicatePairs(tx, workspaceId, changed);
  if (found.length === 0) return 0;
  // Lock the facts, then find the pairs again: a fact retracted meanwhile
  // must neither be superseded nor become a canonical fact.
  const ids = [...new Set(found.flatMap((p) => [p.id, p.canonical]))].sort();
  await tx`select id from facts where id = any(${ids}::uuid[]) order by id for update`;
  const pairs = await duplicatePairs(tx, workspaceId, tx`f.id = any(${ids}::uuid[])`);
  if (pairs.length === 0) return 0;

  const duplicates = pairs.map((p) => p.id);
  const canonicals = pairs.map((p) => p.canonical);
  await tx`
    insert into fact_sources (workspace_id, fact_id, source_record_id, quote)
    select distinct ${workspaceId}::uuid, p.canonical, s.source_record_id, s.quote
    from unnest(${duplicates}::uuid[], ${canonicals}::uuid[]) as p(id, canonical)
    join fact_sources s on s.fact_id = p.id and s.source_record_id is not null
    where not exists (
      select 1 from fact_sources c
      where c.fact_id = p.canonical and c.source_record_id = s.source_record_id
        and c.quote is not distinct from s.quote)`;
  await tx`
    update facts f set superseded_by = p.canonical
    from unnest(${duplicates}::uuid[], ${canonicals}::uuid[]) as p(id, canonical)
    where f.id = p.id`;
  return pairs.length;
}

/**
 * Suggests merges for live records changed since `since` (all records on a
 * first run): shared identifiers first, then similar labels, at most `cap`
 * new pairs of each kind. The pair is stored in sorted order. A pair that
 * already has a row (pending or decided) is skipped before the cap, so it
 * neither uses the budget nor is suggested again. `capped` is true when a
 * kind reached the cap and pairs may be left.
 */
async function suggestMerges(
  tx: Tx,
  workspaceId: string,
  since: Date | null,
  cap: number,
): Promise<{ added: number; capped: boolean }> {
  const changed = () => (since === null ? tx`true` : tx`a.updated_at > ${since}`);
  const entity = tx`a.object_type_id in (
    select id from object_types where workspace_id = ${workspaceId} and class = 'entity')`;
  const isNew = (a: Fragment, b: Fragment) => tx`not exists (
    select 1 from merge_suggestions m
    where m.workspace_id = ${workspaceId} and m.record_a_id = ${a} and m.record_b_id = ${b})`;
  const shared = await tx`
    insert into merge_suggestions (workspace_id, record_a_id, record_b_id, reason, status)
    select ${workspaceId}::uuid, pair.a, pair.b, 'shared ' || pair.kind, 'pending'
    from (
      select distinct on (least(x.record_id, y.record_id), greatest(x.record_id, y.record_id))
        least(x.record_id, y.record_id) as a, greatest(x.record_id, y.record_id) as b, x.kind
      from records a
      join record_identifiers x on x.record_id = a.id and x.kind in ('email', 'phone', 'domain')
      join record_identifiers y on y.workspace_id = x.workspace_id and y.kind = x.kind
        and y.value = x.value and y.record_id <> x.record_id
      join records b on b.id = y.record_id and b.deleted_at is null
        and b.object_type_id = a.object_type_id
      where a.workspace_id = ${workspaceId} and a.deleted_at is null and ${changed()}
        and ${entity}
        and ${isNew(tx`least(x.record_id, y.record_id)`, tx`greatest(x.record_id, y.record_id)`)}
      order by least(x.record_id, y.record_id), greatest(x.record_id, y.record_id),
        array_position(array['email', 'phone', 'domain'], x.kind)
      limit ${cap}
    ) pair
    on conflict (workspace_id, record_a_id, record_b_id) do nothing
    returning id`;

  await tx`select set_config('pg_trgm.similarity_threshold', ${String(NAME_SIMILARITY)}, true)`;
  const similar = await tx`
    insert into merge_suggestions (workspace_id, record_a_id, record_b_id, reason, status)
    select ${workspaceId}::uuid, pair.a, pair.b, 'similar names', 'pending'
    from (
      select distinct least(a.id, b.id) as a, greatest(a.id, b.id) as b
      from records a
      join records b on b.workspace_id = a.workspace_id and b.object_type_id = a.object_type_id
        and b.id <> a.id and b.deleted_at is null and b.label % a.label
        and length(btrim(b.label)) >= ${MIN_LABEL_LENGTH}
      where a.workspace_id = ${workspaceId} and a.deleted_at is null and ${changed()}
        and ${entity}
        and length(btrim(a.label)) >= ${MIN_LABEL_LENGTH}
        and ${isNew(tx`least(a.id, b.id)`, tx`greatest(a.id, b.id)`)}
      order by 1, 2
      limit ${cap}
    ) pair
    on conflict (workspace_id, record_a_id, record_b_id) do nothing
    returning id`;
  return {
    added: shared.length + similar.length,
    capped: shared.length >= cap || similar.length >= cap,
  };
}
