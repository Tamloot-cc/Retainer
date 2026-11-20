import type { Tx } from '../db/tx.js';

/**
 * A merge and routines (routines spec §6.1): the merged-away record's
 * firings and `oncePerRecord` marks move to the survivor, which keeps its
 * own where both have one, so the merge fires nothing a second time. Its
 * queued and held runs run on the survivor; one that a queued, unstarted run
 * of the same routine version on the survivor already covers is discarded.
 */
export async function moveRoutineRecord(tx: Tx, workspace: string, from: string, to: string) {
  await tx`insert into routine_firings(workspace_id,routine_id,kind,record_id,due_at,run_id,created_at)
    select workspace_id,routine_id,kind,${to}::uuid,due_at,run_id,created_at from routine_firings
    where workspace_id=${workspace} and record_id=${from}
    on conflict do nothing`;
  await tx`delete from routine_firings where workspace_id=${workspace} and record_id=${from}`;
  await tx`update routine_runs f set status='discarded',code='merged',finished_at=clock_timestamp(),updated_at=clock_timestamp()
    where f.workspace_id=${workspace} and f.record_id=${from} and f.mode='run'
      and f.status in ('queued','held') and f.attempt=0
      and exists(select 1 from routine_runs s where s.workspace_id=${workspace} and s.routine_id=f.routine_id
        and s.version_id=f.version_id and s.record_id=${to} and s.mode='run'
        and s.status in ('queued','held') and s.attempt=0)`;
  await tx`update routine_runs set record_id=${to},updated_at=clock_timestamp()
    where workspace_id=${workspace} and record_id=${from} and mode='run' and status in ('queued','held')`;
}
