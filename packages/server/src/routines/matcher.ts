import { ROUTINE_LIMITS, type RoutineManifest } from '@retainer/shared';
import { retainedFloor } from '../db/change-cursor.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockPrivacyShared, lockSchemaShared, type Tx } from '../db/tx.js';
import { matchingRecords } from '../records/query.js';
import { type CompiledSchema, getSchema } from '../schema/compiled.js';
import { nextInZone } from './cron.js';
import { mapFilter, objectFor } from './manifest.js';
import { hourlyAllowance, NO_RECORD, pauseRoutine, queueRun, usedUp } from './runs.js';

type ChangeRow = {
  position: string;
  record_id: string | null;
  object_type_id: string;
  operation: string;
  field_keys: string[];
  cause: string[];
  cause_depth: number | null;
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
  const rows = await tx<ChangeRow[]>`
    select position::text,record_id,object_type_id,operation,field_keys,cause,cause_depth from record_changes
    where object_type_id=${object.id} and created_at>clock_timestamp()-${days}*interval '1 day'
      and operation in ('create','update','supersede','links')
    order by position desc limit 5000`;
  const matched = rows.filter((row) => triggerMatches(when, object.id, row));
  const records: string[] = [];
  for (const row of matched)
    if (row.record_id && !records.includes(row.record_id) && records.length < 5)
      records.push(row.record_id);
  const live = records.length
    ? await tx<{ id: string }[]>`select id from records where id=any(${records}::uuid[])
        and deleted_at is null and merged_into_id is null`
    : [];
  return {
    matched: matched.length,
    records: records.filter((id) => live.some((row) => row.id === id)),
  };
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
  const where = matchingRecords(tx, workspace, schema, object, filter ? { filter } : {});
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
export async function dispatchRoutines(sql: Sql, workspace: string, limit = 500) {
  return inWorkspace(sql, workspace, async (tx) => {
    await lockPrivacyShared(tx, workspace);
    await lockSchemaShared(tx, workspace);
    const schema = await getSchema(tx, workspace);
    const routines = await tx<ActiveRoutine[]>`
      select r.id,r.feed_position::text,v.id as version_id,v.source_id,s.manifest from routines r
      join routine_versions v on v.id=r.active_version_id join routine_sources s on s.id=v.source_id
      where r.status='active' and r.feed_position is not null
        and r.feed_position<(select position from change_counters where workspace_id=${workspace})
      order by r.id for update of r skip locked`;
    const [counter] = await tx<{ position: string; retained_after: string }[]>`
      select position::text,retained_after::text from change_counters where workspace_id=${workspace}`;
    const head = counter?.position ?? '0';
    const floor = await retainedFloor(tx, workspace, head, counter?.retained_after ?? '0');
    let queued = 0,
      held = 0,
      blocked = 0;
    for (const routine of routines) {
      const when = routine.manifest.when;
      if (when.kind !== 'record') {
        await tx`update routines set feed_position=null where id=${routine.id}`;
        continue;
      }
      // History older than the feed keeps is gone: the routine goes on from the head.
      if (BigInt(routine.feed_position) < BigInt(floor)) {
        await tx`update routines set feed_position=${head}::bigint where id=${routine.id}`;
        continue;
      }
      const object = objectFor(schema, when.object);
      const rows = await tx<ChangeRow[]>`
        select position::text,record_id,object_type_id,operation,field_keys,cause,cause_depth from record_changes
        where position>${routine.feed_position}::bigint order by record_changes.position limit ${limit}`;
      let paused = false;
      for (const row of rows) {
        if (!object || !row.record_id || !triggerMatches(when, object.id, row)) continue;
        // A routine is never triggered by a change it caused; chains stop at 8 hops (§6.5).
        if (
          row.cause.includes(routine.id) ||
          (row.cause_depth ?? row.cause.length) >= ROUTINE_LIMITS.chainDepth
        ) {
          blocked++;
          continue;
        }
        if (when.oncePerRecord && (await usedUp(tx, routine.id, row.record_id))) continue;
        // Rapid edits fold into the queued, unstarted run for the same record (§6.1).
        const [pending] = await tx<{ id: string; cause: string[]; cause_depth: number }[]>`
          select id,cause,cause_depth from routine_runs where routine_id=${routine.id} and record_id=${row.record_id}
            and mode='run' and status in ('queued','held') and attempt=0 and version_id=${routine.version_id}
          order by created_at desc limit 1 for update`;
        if (pending) {
          await tx`update routine_runs set change_position=${row.position}::bigint,
            cause=${tx.json([...new Set([...pending.cause, ...row.cause])])},
            cause_depth=greatest(cause_depth,${row.cause_depth ?? row.cause.length}),run_at=clock_timestamp()
            where id=${pending.id}`;
          continue;
        }
        const allowed = !paused && (await hourlyAllowance(tx, routine.id));
        await queueRun(tx, workspace, {
          mode: 'run',
          triggerKind: 'record',
          routineId: routine.id,
          versionId: routine.version_id,
          sourceId: routine.source_id,
          recordId: row.record_id,
          changePosition: Number(row.position),
          cause: row.cause,
          causeDepth: row.cause_depth ?? row.cause.length,
          held: !allowed,
        });
        if (allowed) queued++;
        else {
          held++;
          if (!paused) await pauseRoutine(tx, routine.id, 'needs_attention', 'runs_held');
          paused = true;
        }
      }
      const last = rows.at(-1)?.position;
      if (last) await tx`update routines set feed_position=${last}::bigint where id=${routine.id}`;
    }
    return { queued, held, blocked };
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
      where r.id=${routineId} and r.status='active' and r.next_fire_at<=clock_timestamp() for update of r skip locked`;
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
    let queued = 0;
    for (const recordId of targets) {
      const real = recordId === NO_RECORD ? null : recordId;
      if (real && when.oncePerRecord && (await usedUp(tx, routineId, real))) continue;
      const [fresh] =
        await tx`insert into routine_firings(workspace_id,routine_id,kind,record_id,due_at)
        values(${workspace},${routineId},'schedule',${recordId},${due}) on conflict do nothing returning 1`;
      if (!fresh) continue;
      await queueRun(tx, workspace, {
        mode: 'run',
        triggerKind: 'schedule',
        routineId,
        versionId: routine.version_id,
        sourceId: routine.source_id,
        recordId: real,
        runAt: due,
        held: over,
      });
      queued++;
    }
    return over ? { queued: 0, held: queued, matched } : { queued, matched };
  });
}
