import type { Caller, RunBinding } from '../caller.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { lockExtension } from './locks.js';

/** Called after schema (and privacy for CRM writes), before idempotency or record locks. */
export async function admitRun(
  tx: Tx,
  workspace: string,
  run: RunBinding,
  write = false,
): Promise<Pick<Caller, 'actor' | 'scopes'>> {
  // The registration ID comes from the signed binding; the workspace is the verified credential's.
  await lockExtension(tx, workspace, run.registrationId, true);
  const [installation] = await tx<
    {
      generation: number;
      state: string;
      release_digest: string;
      granted_actor: 'agent' | 'integration';
      granted_scopes: ('read' | 'write')[];
    }[]
  >`
    select generation,state,release_digest,granted_actor,granted_scopes from extension_installations
    where id=${run.installationId} and registration_id=${run.registrationId}`;
  if (
    installation?.state !== 'active' ||
    installation.generation !== run.generation ||
    installation.release_digest !== run.releaseDigest
  )
    throw new AppError(
      409,
      'installation_disabled',
      'installation is disabled or its generation changed',
    );
  // Hold a shared row lock through commit so lease takeover cannot overtake an admitted write.
  const [job] =
    await tx`select id from extension_jobs where id=${run.jobId} and installation_id=${run.installationId}
    and generation=${run.generation} and release_digest=${run.releaseDigest} and status='running'
    and lease_owner=${run.owner} and fence=${run.fence}::bigint
    and lease_until>clock_timestamp() and run_until>clock_timestamp() for share`;
  if (!job) throw new AppError(409, 'lease_expired', 'run lease expired or was replaced');
  if (run.scopes.some((scope) => !installation.granted_scopes.includes(scope)))
    throw new AppError(403, 'forbidden', 'run scopes exceed the current installation grant');
  if (write) {
    const [budget] =
      await tx`insert into extension_write_budgets(workspace_id,installation_id,window_start,count)
      values(${workspace},${run.installationId},date_trunc('minute',clock_timestamp()),1)
      on conflict(workspace_id,installation_id) do update set
        window_start=excluded.window_start,
        count=case when extension_write_budgets.window_start<>excluded.window_start then 1 else extension_write_budgets.count+1 end
      where extension_write_budgets.window_start<>excluded.window_start or extension_write_budgets.count<60 returning count`;
    if (!budget)
      throw new AppError(429, 'quota_exceeded', 'installation write budget exceeded', {
        retryAfterSeconds: 60,
      });
  }
  return {
    actor: { type: installation.granted_actor, id: run.installationId },
    scopes: run.scopes,
  };
}
