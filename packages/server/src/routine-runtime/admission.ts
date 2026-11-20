import type { Actor } from '@retainer/shared';
import type { Caller, RoutineCaller } from '../caller.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';

/**
 * Who may approve a routine or start a test run, as `retainer_routine_admin`
 * checks it later: a person's user ID in accounts mode, `key:<actor ID>` for
 * an admin API key. Null for anyone else, agents included (routines spec §5.3).
 */
export function adminIdentity(caller: Caller): string | null {
  if (caller.run || caller.installation || caller.routine || caller.actor.type !== 'user')
    return null;
  if (!caller.scopes.includes('admin')) return null;
  return caller.userId ?? `key:${caller.actor.id}`;
}

export async function stillAdmin(tx: Tx, workspace: string, who: string | null) {
  if (!who) return false;
  const [row] = await tx<
    { ok: boolean }[]
  >`select retainer_routine_admin(${workspace}::uuid,${who}) as ok`;
  return row?.ok === true;
}

/** Why an effect was refused, as the code the run ends with (routines spec §6.2). */
export const runRefused = (code: string, message: string) => new AppError(409, code, message);

/**
 * Admits a routine run's credential inside the caller's transaction, after
 * the schema lock (routines spec §3.3, §6.2). The run must be running under
 * this fence and not expired. A normal run's routine must still be active; a
 * test run's initiator must still be an admin. Only the effects path writes:
 * writes through the plain REST routes are refused, so every write is
 * numbered and recorded. A dry run, a check and the builder write nothing.
 */
export async function admitRoutine(
  tx: Tx,
  workspace: string,
  routine: RoutineCaller,
  write = false,
): Promise<Pick<Caller, 'actor' | 'scopes'>> {
  const [run] = await tx<
    {
      status: string;
      fence: string;
      live: boolean;
      mode: string;
      routine_status: string | null;
      routine_name: string | null;
      initiator_user_id: string | null;
      initiated_by: Actor | null;
      number: number | null;
      deleting: boolean;
    }[]
  >`select r.status,r.fence::text,coalesce(r.expires_at>clock_timestamp(),true) as live,r.mode,
      rt.status as routine_status,rt.name as routine_name,r.initiator_user_id,r.initiated_by,v.number,
      w.deletion_scheduled_at is not null as deleting
    from routine_runs r join workspaces w on w.id=r.workspace_id
    left join routines rt on rt.id=r.routine_id left join routine_versions v on v.id=r.version_id
    where r.id=${routine.runId} for share of r`;
  if (!run || run.deleting) throw runRefused('lease_expired', 'the routine run is not running');
  if (run.status === 'erased')
    throw runRefused('run_erased', 'workspace data was erased during this run');
  if (run.status === 'stopped') throw runRefused('routine_paused', 'the routine was paused');
  if (run.status !== 'running' || run.fence !== routine.fence || run.mode !== routine.mode)
    throw runRefused('lease_expired', 'the routine run is not running');
  if (!run.live) throw runRefused('run_expired', 'the run has expired');
  if (run.mode === 'run' && run.routine_status !== 'active')
    throw runRefused('routine_paused', 'the routine is not active');
  if (run.mode === 'test' && !(await stillAdmin(tx, workspace, run.initiator_user_id)))
    throw runRefused('routine_paused', 'the person who started this test is no longer an admin');
  const writes = run.mode === 'run' || run.mode === 'test';
  if (write && (!writes || !routine.effect))
    throw new AppError(
      403,
      'forbidden',
      writes
        ? 'routine code writes through the routine SDK, which numbers every effect'
        : 'a dry run, a check and the builder write nothing',
    );
  const by = run.initiated_by?.name ?? run.initiated_by?.id;
  const label = run.routine_name ?? 'Routine builder';
  return {
    actor: {
      type: 'agent',
      id: routine.routineId ?? routine.runId,
      name:
        run.mode === 'run' || run.mode === 'test'
          ? `${label} (routine${run.number ? `, version ${run.number}` : ''}${run.mode === 'test' ? ', test' : ''}${by && (run.mode === 'test' || run.initiated_by) ? `, started by ${by}` : ''})`
          : `${label} (routine ${run.mode})`,
    },
    scopes: writes ? ['read', 'write'] : ['read'],
  };
}

/**
 * `forget` and routines (routines spec §6.6): code can read any record and
 * reads are not tracked, so every stored tool and model result and every
 * run's output in the workspace is deleted, in the same transaction, and
 * each run in flight is fenced and ends as `erased`: its token is refused
 * from then on, so nothing it already read can be written anywhere.
 */
export async function eraseRoutineContent(tx: Tx, workspaceId: string) {
  await tx`update routine_run_results set result=null,updated_at=clock_timestamp()
    where workspace_id=${workspaceId} and result is not null`;
  await tx`update routine_runs set output=null where workspace_id=${workspaceId} and output is not null`;
  await tx`update routine_runs set status='erased',code='run_erased',fence=fence+1,finished_at=clock_timestamp(),
    lease_owner=null,lease_until=null where workspace_id=${workspaceId} and status='running'`;
}
