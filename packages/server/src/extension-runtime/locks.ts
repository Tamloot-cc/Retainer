import type { Tx } from '../db/tx.js';

/** Shared by admitted runs, exclusive for control transitions. Always after schema. */
export async function lockExtension(
  tx: Tx,
  workspace: string,
  registration: string,
  shared = false,
) {
  const key = `${workspace}:${registration}`;
  if (shared) await tx`select pg_advisory_xact_lock_shared(21061::int4, hashtext(${key}))`;
  else await tx`select pg_advisory_xact_lock(21061::int4, hashtext(${key}))`;
}
/** Serializes quota checks, claims and checkpoint/KV changes within one installation. */
export async function lockQueue(tx: Tx, workspace: string, installation: string) {
  await tx`select pg_advisory_xact_lock(21062::int4, hashtext(${`${workspace}:${installation}`}))`;
}

/** Called with the installation lock exclusive, after admitted operations drain. */
export async function cancelRuns(tx: Tx, installationId: string, cleanupGeneration?: number) {
  if (cleanupGeneration !== undefined) {
    // Same-release transitions retain cleanup's job identity and retry budget.
    // A running attempt is replayed, as with a mapping change; its old lease
    // and credential are fenced. Provider side effects are at least once.
    await tx`update extension_attempts set status='cancelled',code='installation_changed',finished_at=now()
      where finished_at is null and job_id in(select id from extension_jobs where installation_id=${installationId}
      and trigger_kind='disconnect' and status in ('queued','running') and generation<>${cleanupGeneration})`;
    await tx`update extension_jobs set generation=${cleanupGeneration},
      available_at=case when status='running' then now() else available_at end,
      status='queued',lease_owner=null,lease_until=null,run_until=null,fence=fence+1,updated_at=now()
      where installation_id=${installationId} and trigger_kind='disconnect'
      and status in ('queued','running') and generation<>${cleanupGeneration}`;
  }
  await tx`delete from extension_schedules where installation_id=${installationId}`;
  await tx`update extension_attempts set status='cancelled',code='installation_disabled',finished_at=now()
    where finished_at is null and job_id in (select id from extension_jobs where installation_id=${installationId}
    and (${cleanupGeneration === undefined} or trigger_kind<>'disconnect'))`;
  await tx`update extension_jobs set status='cancelled',code='installation_disabled',lease_owner=null,lease_until=null,updated_at=now()
    where installation_id=${installationId} and status in ('queued','running')
    and (${cleanupGeneration === undefined} or trigger_kind<>'disconnect')`;
}

/** A terminal cleanup boundary records failure rather than cancelling the obligation. */
export async function failDisconnectCleanup(tx: Tx, installationId: string, code: string) {
  const jobs = await tx`update extension_jobs set status='failed',code=${code},lease_owner=null,
    lease_until=null,run_until=null,updated_at=now() where installation_id=${installationId}
    and trigger_kind='disconnect' and status in ('queued','running') returning id,connection_id`;
  for (const job of jobs) {
    await tx`update extension_attempts set status='failed',code=${code},finished_at=now()
      where job_id=${job.id} and finished_at is null`;
    await tx`update extension_connections set health='degraded',last_error=${code}
      where id=${job.connection_id} and installation_id=${installationId}`;
  }
  return jobs.length;
}
