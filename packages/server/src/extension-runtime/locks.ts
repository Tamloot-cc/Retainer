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
export async function cancelRuns(tx: Tx, installationId: string) {
  await tx`delete from extension_schedules where installation_id=${installationId}`;
  await tx`update extension_attempts set status='cancelled',code='installation_disabled',finished_at=now()
    where finished_at is null and job_id in (select id from extension_jobs where installation_id=${installationId})`;
  await tx`update extension_jobs set status='cancelled',code='installation_disabled',lease_owner=null,lease_until=null,updated_at=now()
    where installation_id=${installationId} and status in ('queued','running')`;
}
