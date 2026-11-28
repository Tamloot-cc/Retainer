import { type Actor, ROUTINE_LIMITS, type RoutineRunMode } from '@retainer/shared';
import { cancelRunTasks } from '../agent-runtime/tasks.js';
import { jsonValue, type Tx } from '../db/tx.js';

/** A run's lease outlasts its deadline by this much, to record the outcome. */
export const RUN_GRACE_SECONDS = 15;

/** The nil UUID: the record of a schedule tick that has none. */
export const NO_RECORD = '00000000-0000-0000-0000-000000000000';
/** The time of a `once` mark: it has no due time. */
export const ONCE = new Date(0);

export type QueueRun = {
  mode: RoutineRunMode;
  triggerKind: 'record' | 'schedule' | 'manual' | 'test' | 'preview' | 'check';
  routineId?: string | null;
  versionId?: string | null;
  sourceId?: string | null;
  recordId?: string | null;
  previewId?: string | null;
  input?: Record<string, unknown> | null;
  changePosition?: string | null;
  cause?: string[];
  causeDepth?: number;
  initiatedBy?: Actor | null;
  initiatorUserId?: string | null;
  runAt?: Date;
  /** Queued but not started: an admin runs or discards it (§6.5). */
  held?: boolean;
};

/** Inserts one run; the executor picks it up. Returns its ID. */
export async function queueRun(tx: Tx, workspace: string, run: QueueRun): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into routine_runs(workspace_id,routine_id,version_id,source_id,mode,trigger_kind,record_id,preview_id,
      input,change_position,cause,cause_depth,initiated_by,initiator_user_id,run_at,status)
    values(${workspace},${run.routineId ?? null},${run.versionId ?? null},${run.sourceId ?? null},${run.mode},
      ${run.triggerKind},${run.recordId ?? null},${run.previewId ?? null},
      ${run.input ? tx.json(jsonValue(run.input)) : null},${run.changePosition ?? null}::bigint,
      ${tx.json(run.cause ?? [])},${run.causeDepth ?? 0},
      ${run.initiatedBy ? tx.json(jsonValue(run.initiatedBy)) : null},${run.initiatorUserId ?? null},
      ${run.runAt ?? new Date()},${run.held ? 'held' : 'queued'})
    returning id`;
  if (!row) throw new Error('run insert returned no row');
  return row.id;
}

/**
 * Pauses a routine at once (§5.3). Started runs are fenced permanently so
 * a later resume cannot reactivate their credentials. Unstarted runs wait
 * for an admin to release or discard them. Lifecycle callers use FOR NO
 * KEY UPDATE on the routine so an effect holding a run can insert its
 * firing and acquire the routine's foreign-key lock before the pause.
 */
export async function pauseRoutine(
  tx: Tx,
  routineId: string,
  status: 'paused' | 'needs_attention',
  reason: string,
  versionId?: string | null,
) {
  const [paused] =
    await tx`update routines set status=${status},paused_reason=${reason},paused_at=clock_timestamp()
    where id=${routineId} and status='active'
      ${versionId === undefined ? tx`` : tx`and active_version_id=${versionId}`}
    returning id`;
  if (!paused) return false;
  await tx`update routine_runs set status='held',code=${reason}
    where routine_id=${routineId} and mode='run' and status='queued' and attempt=0`;
  const stopped = await tx<
    { id: string }[]
  >`update routine_runs set status='stopped',code=${reason},fence=fence+1,
    finished_at=clock_timestamp(),lease_owner=null,lease_until=null,
    input=nullif(input-'triggerRecord','{}'::jsonb)
    where routine_id=${routineId} and mode='run'
      and (status in ('running','waiting') or (status='queued' and attempt>0))
    returning id`;
  // A run waiting on an agent task stops, and so does its task (agent spec §9.2).
  await cancelRunTasks(
    tx,
    stopped.map((run) => run.id),
    'routine_paused',
  );
  return true;
}

/**
 * Whether the routine may queue another run this hour (§6.5). Past the
 * limit it pauses and the run is held, so a bulk import sends nothing until
 * an admin decides.
 */
export async function hourlyAllowance(tx: Tx, routineId: string) {
  const [row] = await tx<{ count: number }[]>`
    select count(*)::int as count from routine_runs where routine_id=${routineId} and mode='run'
      and trigger_kind<>'manual' and created_at>clock_timestamp()-interval '1 hour'`;
  return (row?.count ?? 0) < ROUTINE_LIMITS.runsPerHour;
}

/** Whether a `oncePerRecord` routine already acted on this record, or a record merged into it. */
export async function usedUp(tx: Tx, routineId: string, recordId: string) {
  const [row] =
    await tx`select 1 from routine_firings f where f.routine_id=${routineId} and f.kind='once'
    and (f.record_id=${recordId} or f.record_id in (select id from records where merged_into_id=${recordId}))
    limit 1`;
  return !!row;
}

/**
 * Marks a record used up by a run's first write or tool call (§4.2), in the
 * transaction of that effect. Returns false when another run got there first.
 */
export async function useUp(
  tx: Tx,
  workspace: string,
  routineId: string,
  recordId: string,
  runId: string,
) {
  const [row] =
    await tx`insert into routine_firings(workspace_id,routine_id,kind,record_id,due_at,run_id)
    values(${workspace},${routineId},'once',${recordId},${ONCE},${runId})
    on conflict do nothing returning 1`;
  if (row) return true;
  const [mine] =
    await tx`select 1 from routine_firings where routine_id=${routineId} and kind='once'
    and record_id=${recordId} and run_id=${runId}`;
  return !!mine;
}
