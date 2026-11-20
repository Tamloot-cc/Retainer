import { ROUTINE_LIMITS, type RoutineManifest } from '@retainer/shared';
import { retainedFloor } from '../db/change-cursor.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockPrivacyShared, lockSchemaShared, type Tx } from '../db/tx.js';
import { log } from '../log.js';
import { matchingRecords } from '../records/query.js';
import { type CompiledSchema, getSchema } from '../schema/compiled.js';
import { nextInZone } from './cron.js';
import { manifestResolves, mapFilter, objectFor } from './manifest.js';
import { hourlyAllowance, NO_RECORD, pauseRoutine, queueRun, usedUp } from './runs.js';

type ChangeRow = {
  position: string;
  record_id: string | null;
  object_type_id: string;
  operation: string;
  field_keys: string[];
  cause: string[];
  cause_depth: number | null;
  merged_from_id?: string | null;
};

/** Whether a change concerns a `record` trigger: object, operation, watched fields (§6.1). */
export function triggerMatches(
  when: Extract<RoutineManifest['when'], { kind: 'record' }>,
  objectId: string,
  change: Pick<ChangeRow, 'object_type_id' | 'operation' | 'field_keys'>,
) {
  if (change.object_type_id !== objectId) return false;
  if (change.operation === 'create') return when.on.includes('created');
  if (change.operation === 'links') return when.on.includes('links');
  if (change.operation === 'update' || change.operation === 'supersede')
    return (
      when.on.includes('updated') &&
      (!when.fields?.length || when.fields.some((key) => change.field_keys.includes(key)))
    );
  return false;
}

/**
 * For a preview: how many changes of the last `days` the trigger would
 * have matched (the cost estimate) and the most recent distinct records.
 */
export async function matchingSince(
  tx: Tx,
  schema: CompiledSchema,
  manifest: RoutineManifest,
  days: number,
) {
  const when = manifest.when;
  if (when.kind !== 'record') return { matched: 0, records: [] as string[] };
  const object = objectFor(schema, when.object);
  if (!object) return { matched: 0, records: [] as string[] };
  // The trigger as SQL (`triggerMatches`), so every matching change is counted.
  const where = tx`object_type_id=${object.id} and created_at>clock_timestamp()-${days}*interval '1 day'
    and merged_from_id is null and (
      ${when.on.includes('created') ? tx`operation='create'` : tx`false`}
      or ${when.on.includes('links') ? tx`operation='links'` : tx`false`}
      or ${
        when.on.includes('updated')
          ? tx`(operation in ('update','supersede') ${when.fields?.length ? tx`and field_keys ?| ${when.fields}::text[]` : tx``})`
          : tx`false`
      })`;
  const [count] = await tx<
    { n: number }[]
  >`select count(*)::int as n from record_changes where ${where}`;
  // The five live records with the most recent matches: a record merged
  // since its change counts as its survivor (§6.1), and a deleted one or
  // repeated changes to one record take no extra slot.
  const live = await tx<{ id: string }[]>`
    with m as (select record_id,position from record_changes where ${where} and record_id is not null)
    select s.id from m join records r on r.id=m.record_id
    join records s on s.id=coalesce(r.merged_into_id,r.id)
    where s.deleted_at is null and s.merged_into_id is null
    group by s.id order by max(m.position) desc limit 5`;
  return { matched: count?.n ?? 0, records: live.map((row) => row.id) };
}

/** The records a schedule tick would fan out to, and how many there are. */
export async function scheduleTargets(
  tx: Tx,
  workspace: string,
  schema: CompiledSchema,
  manifest: RoutineManifest,
  limit: number,
) {
  const when = manifest.when;
  if (when.kind !== 'schedule' || !when.object) return { matched: 1, records: [] as string[] };
  const object = objectFor(schema, when.object);
  if (!object) return { matched: 0, records: [] as string[] };
  const filter = when.filter ? mapFilter(object, when.filter, 'name') : undefined;
  const where = matchingRecords(tx, workspace, schema, object, filter ? { filter } : {}, 'source');
  const [count] = await tx<
    { count: number }[]
  >`select count(*)::int as count from records r where ${where}`;
  const rows = await tx<{ id: string }[]>`
    select r.id from records r where ${where} order by r.updated_at desc,r.id limit ${limit}`;
  return { matched: count?.count ?? 0, records: rows.map((row) => row.id) };
}

type ActiveRoutine = {
  id: string;
  feed_position: string;
  version_id: string;
  source_id: string;
  manifest: RoutineManifest;
};

/**
 * Matches one workspace's new changes against its active `record` routines
 * (§6.1), each from its own cursor, and queues runs. Each routine's runs and
 * its cursor commit together. The `if` is not checked here; the run checks
 * it when it starts.
 */
export async function dispatchRoutines(
  sql: Sql,
  workspace: string,
  limit = 500,
  deadline = Number.POSITIVE_INFINITY,
) {
  const routines = await inWorkspace(
    sql,
    workspace,
    (tx) => tx<{ id: string }[]>`
    select id from routines where status='active' and feed_position is not null
      and feed_position<(select position from change_counters where workspace_id=${workspace})
    order by feed_position,id`,
  );
  const result = { queued: 0, held: 0, blocked: 0, failed: 0 };
  for (const { id } of routines) {
    if (Date.now() >= deadline) break;
    try {
      const dispatched = await dispatchRoutine(sql, workspace, id, limit, deadline);
      if (!dispatched) continue;
      result.queued += dispatched.queued;
      result.held += dispatched.held;
      result.blocked += dispatched.blocked;
      if (dispatched.cursorExpired)
        log.warn('Routine change cursor expired; resumed at the retained floor', {
          workspace,
          routineId: id,
        });
    } catch {
      result.failed++;
      log.error('Routine change dispatch failed', { workspace, routineId: id });
      // A broken routine keeps its cursor, but gives other workspaces their turn.
      await inWorkspace(
        sql,
        workspace,
        (tx) => tx`update routines set updated_at=clock_timestamp() where id=${id}`,
      ).catch(() => {});
    }
  }
  return result;
}

async function dispatchRoutine(
  sql: Sql,
  workspace: string,
  id: string,
  limit: number,
  deadline: number,
) {
  return inWorkspace(sql, workspace, async (tx) => {
    await lockPrivacyShared(tx, workspace);
    await lockSchemaShared(tx, workspace);
    const [routine] = await tx<ActiveRoutine[]>`
      select r.id,r.feed_position::text,v.id as version_id,v.source_id,s.manifest
      from routines r join routine_versions v on v.id=r.active_version_id
      join routine_sources s on s.id=v.source_id
      where r.id=${id} and r.status='active' and r.feed_position is not null
      for no key update of r skip locked`;
    if (!routine) return;
    // Workspace discovery serves the least recently dispatched routines first.
    await tx`update routines set updated_at=clock_timestamp() where id=${id}`;
    const schema = await getSchema(tx, workspace);
    const [counter] = await tx<{ position: string; retained_after: string }[]>`
      select position::text,retained_after::text from change_counters where workspace_id=${workspace}`;
    const head = counter?.position ?? '0';
    const floor = await retainedFloor(tx, workspace, head, counter?.retained_after ?? '0');
    let queued = 0,
      held = 0,
      blocked = 0;
    const when = routine.manifest.when;
    if (when.kind !== 'record') {
      await tx`update routines set feed_position=null where id=${routine.id}`;
      return { queued, held, blocked, cursorExpired: false };
    }
    const cursorExpired = BigInt(routine.feed_position) < BigInt(floor);
    if (cursorExpired) {
      await tx`update routines set feed_position=${floor}::bigint where id=${routine.id}`;
    }
    const object = objectFor(schema, when.object);
    // Its object or a watched field is gone: the routine needs repair, not silence (§5.3).
    if (!object || !manifestResolves(tx, schema, routine.manifest)) {
      await pauseRoutine(tx, routine.id, 'needs_attention', 'check_failed');
      return { queued, held, blocked, cursorExpired };
    }
    let paused = false,
      from = cursorExpired ? floor : routine.feed_position;
    const [outstanding] = await tx<{ count: number }[]>`
      select count(*)::int as count from routine_runs where routine_id=${routine.id}
        and mode='run' and status in ('queued','held')`;
    let remaining = ROUTINE_LIMITS.recordHeldMax - (outstanding?.count ?? 0);
    let scannedAfterPause = 0;
    // Once paused, keep collecting the burst up to the held and scan limits.
    // Resuming starts from the head.
    pages: for (;;) {
      const rows = await tx<ChangeRow[]>`
      select position::text,record_id,object_type_id,operation,field_keys,cause,cause_depth,merged_from_id
      from record_changes where position>${from}::bigint and position<=${head}::bigint
      order by record_changes.position limit ${limit}`;
      for (const row of rows) {
        if (
          Date.now() >= deadline ||
          (paused && scannedAfterPause++ >= ROUTINE_LIMITS.recordHeldMax)
        ) {
          await tx`update routines set
            paused_reason=case when ${paused} then 'record_backlog_over_limit' else paused_reason end,
            feed_position=${from}::bigint where id=${routine.id}`;
          break pages;
        }
        const previousPosition = from;
        from = row.position;
        // A merge is not a trigger (§6.1), whatever records it changed.
        if (row.merged_from_id) continue;
        if (!object || !row.record_id || !triggerMatches(when, object.id, row)) continue;
        // A routine is never triggered by a change it caused; chains stop at 8 hops (§6.5).
        if (
          row.cause.includes(routine.id) ||
          (row.cause_depth ?? row.cause.length) >= ROUTINE_LIMITS.chainDepth
        ) {
          blocked++;
          continue;
        }
        // A change made before a merge runs on the survivor, as every run does (§6.1).
        const [record] = await tx<{ id: string }[]>`
        select coalesce(merged_into_id,id) as id from records where id=${row.record_id}`;
        const recordId = record?.id ?? row.record_id;
        if (when.oncePerRecord && (await usedUp(tx, routine.id, recordId))) continue;
        // Rapid edits fold into the queued, unstarted run for the same record (§6.1).
        const [pending] = await tx<{ id: string; cause: string[]; cause_depth: number }[]>`
        select id,cause,cause_depth from routine_runs where routine_id=${routine.id} and record_id=${recordId}
          and mode='run' and status in ('queued','held') and attempt=0 and version_id=${routine.version_id}
        order by created_at desc limit 1 for update`;
        if (pending) {
          await tx`update routine_runs set change_position=${row.position}::bigint,
          cause=${tx.json([...new Set([...pending.cause, ...row.cause])])},
          cause_depth=greatest(cause_depth,${row.cause_depth ?? row.cause.length}),run_at=clock_timestamp()
          where id=${pending.id}`;
          continue;
        }
        if (remaining <= 0) {
          if (!paused)
            await pauseRoutine(tx, routine.id, 'needs_attention', 'record_backlog_over_limit');
          await tx`update routines set paused_reason='record_backlog_over_limit',
            feed_position=${previousPosition}::bigint where id=${routine.id}`;
          break pages;
        }
        if (!paused && !(await hourlyAllowance(tx, routine.id))) {
          await pauseRoutine(tx, routine.id, 'needs_attention', 'runs_held');
          paused = true;
        }
        await queueRun(tx, workspace, {
          mode: 'run',
          triggerKind: 'record',
          routineId: routine.id,
          versionId: routine.version_id,
          sourceId: routine.source_id,
          recordId,
          changePosition: row.position,
          cause: row.cause,
          causeDepth: row.cause_depth ?? row.cause.length,
          held: paused,
        });
        remaining--;
        if (paused) held++;
        else queued++;
      }
      const last = rows.at(-1)?.position;
      if (last) {
        await tx`update routines set feed_position=${last}::bigint where id=${routine.id}`;
        from = last;
      }
      if (!paused || rows.length < limit) break;
    }
    return { queued, held, blocked, cursorExpired };
  });
}

/**
 * Fires one routine's due schedule tick (§4.2, §6.5): each record matching
 * its filter gets a run, up to 200; above that the tick queues nothing and
 * the routine pauses until an admin decides. Above 2,000 it holds nothing
 * either, rather than some of them: the filter must be narrowed. Each tick
 * fires once.
 */
export async function fireSchedule(sql: Sql, workspace: string, routineId: string) {
  return inWorkspace(sql, workspace, async (tx) => {
    await lockSchemaShared(tx, workspace);
    const [routine] = await tx<(ActiveRoutine & { next_fire_at: Date })[]>`
      select r.id,r.next_fire_at,v.id as version_id,v.source_id,s.manifest from routines r
      join routine_versions v on v.id=r.active_version_id join routine_sources s on s.id=v.source_id
      where r.id=${routineId} and r.status='active' and r.next_fire_at<=clock_timestamp() for no key update of r skip locked`;
    if (!routine) return { queued: 0 };
    const when = routine.manifest.when;
    if (when.kind !== 'schedule') {
      await tx`update routines set next_fire_at=null where id=${routineId}`;
      return { queued: 0 };
    }
    const [zoneRow] = await tx<{ zone: string | null }[]>`
      select settings->>'timeZone' as zone from workspaces where id=${workspace}`;
    const due = routine.next_fire_at;
    await tx`update routines set next_fire_at=${nextInZone(when.cron, new Date(Math.max(Date.now(), due.getTime())), zoneRow?.zone ?? 'UTC')}
      where id=${routineId}`;
    const schema = await getSchema(tx, workspace);
    // A schedule whose object or filter no longer resolves needs repair, as
    // code that no longer type-checks does (§5.3).
    if (!manifestResolves(tx, schema, routine.manifest)) {
      await pauseRoutine(tx, routineId, 'needs_attention', 'check_failed');
      return { queued: 0 };
    }
    const { matched, records } = await scheduleTargets(
      tx,
      workspace,
      schema,
      routine.manifest,
      ROUTINE_LIMITS.scheduleFanOut + 1,
    );
    // Over the cap the tick starts nothing: its runs are held and the routine
    // pauses, so an admin runs the tick once, over the cap, or discards it.
    const over = !!when.object && matched > ROUTINE_LIMITS.scheduleFanOut;
    if (over && matched > ROUTINE_LIMITS.scheduleHeldMax) {
      await pauseRoutine(tx, routineId, 'needs_attention', 'schedule_too_large');
      return { queued: 0, held: 0, matched };
    }
    const targets = !when.object
      ? [NO_RECORD]
      : over
        ? (
            await scheduleTargets(
              tx,
              workspace,
              schema,
              routine.manifest,
              ROUTINE_LIMITS.scheduleHeldMax,
            )
          ).records
        : records;
    if (over) await pauseRoutine(tx, routineId, 'needs_attention', 'schedule_over_limit');
    let queued = 0,
      held = 0,
      paused = over;
    for (const recordId of targets) {
      const real = recordId === NO_RECORD ? null : recordId;
      if (real && when.oncePerRecord && (await usedUp(tx, routineId, real))) continue;
      const [fresh] =
        await tx`insert into routine_firings(workspace_id,routine_id,kind,record_id,due_at)
        values(${workspace},${routineId},'schedule',${recordId},${due}) on conflict do nothing returning 1`;
      if (!fresh) continue;
      // The hourly cap counts scheduled runs too (§4.6): past it the rest are held.
      const allowed = !paused && (await hourlyAllowance(tx, routineId));
      await queueRun(tx, workspace, {
        mode: 'run',
        triggerKind: 'schedule',
        routineId,
        versionId: routine.version_id,
        sourceId: routine.source_id,
        recordId: real,
        runAt: due,
        held: !allowed,
      });
      if (allowed) queued++;
      else {
        held++;
        if (!paused) await pauseRoutine(tx, routineId, 'needs_attention', 'runs_held');
        paused = true;
      }
    }
    return held ? { queued, held, matched } : { queued, matched };
  });
}
