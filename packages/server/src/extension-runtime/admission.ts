import type { Caller, InstallationBinding, RunBinding } from '../caller.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { lockExtension } from './locks.js';

/** Called after schema (and privacy for CRM writes), before idempotency or record locks. */
export async function admitRun(
  tx: Tx,
  workspace: string,
  run: RunBinding,
  write = false,
  purpose: 'crm' | 'runtime' | 'authenticate' = 'crm',
): Promise<Pick<Caller, 'actor' | 'scopes'>> {
  // The registration ID comes from the signed binding; the workspace is the verified credential's.
  await lockExtension(tx, workspace, run.registrationId, true);
  const [installation] = await tx<
    {
      cleanup_live: boolean | null;
      deleting: boolean;
      generation: number;
      state: string;
      release_digest: string;
      granted_actor: 'agent' | 'integration';
      granted_scopes: ('read' | 'write')[];
    }[]
  >`
    select i.cleanup_deadline>clock_timestamp() as cleanup_live,w.deletion_scheduled_at is not null as deleting,
      i.generation,i.state,i.release_digest,i.granted_actor,i.granted_scopes
    from extension_installations i join workspaces w on w.id=i.workspace_id
    where i.id=${run.installationId} and i.registration_id=${run.registrationId}`;
  if (
    !installation ||
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
    await tx`select trigger_kind,connection_id,connection_generation from extension_jobs where id=${run.jobId} and installation_id=${run.installationId}
    and function_id=${run.functionId} and generation=${run.generation} and release_digest=${run.releaseDigest} and status='running'
    and lease_owner=${run.owner} and fence=${run.fence}::bigint
    and lease_until>clock_timestamp() and run_until>clock_timestamp() for share`;
  if (!job) throw new AppError(409, 'lease_expired', 'run lease expired or was replaced');
  if (
    (job.connection_id ?? null) !== (run.connectionId ?? null) ||
    (job.connection_generation ?? null) !== (run.connectionGeneration ?? null)
  )
    throw new AppError(409, 'connection_disconnected', 'run connection binding changed');
  const [connection] = run.connectionId
    ? await tx`
    select owner,state,generation,disconnected_at+interval '24 hours'>clock_timestamp() as cleanup_live
    from extension_connections where id=${run.connectionId} and installation_id=${run.installationId}`
    : [];
  if (run.connectionId && (!connection || connection.generation !== run.connectionGeneration))
    throw new AppError(409, 'connection_disconnected', 'connection was disconnected or replaced');
  const ordinary =
    !['install', 'uninstall', 'connect', 'disconnect'].includes(job.trigger_kind) &&
    installation.state === 'active' &&
    (!connection || connection.state === 'active');
  const setup = connection
    ? job.trigger_kind === 'connect' &&
      connection.state === 'connecting' &&
      installation.state === 'active'
    : job.trigger_kind === 'install' && ['installing', 'upgrading'].includes(installation.state);
  const cleanup = connection
    ? job.trigger_kind === 'disconnect' &&
      connection.state === 'disconnected' &&
      connection.cleanup_live === true &&
      installation.state !== 'uninstalled' &&
      (installation.state !== 'uninstalling' || installation.cleanup_live === true)
    : job.trigger_kind === 'uninstall' &&
      installation.state === 'uninstalling' &&
      installation.cleanup_live === true;
  // A workspace being deleted runs only its extensions' cleanup (extensions spec 7).
  if (installation.deleting && !cleanup)
    throw new AppError(409, 'installation_disabled', 'the workspace is being deleted');
  if (!ordinary && !(purpose !== 'crm' && (setup || cleanup)))
    throw new AppError(409, 'installation_disabled', 'this lifecycle run cannot access CRM data');
  if (run.scopes.some((scope) => !installation.granted_scopes.includes(scope)))
    throw new AppError(403, 'forbidden', 'run scopes exceed the current installation grant');
  if (write && !run.scopes.includes('write'))
    throw new AppError(403, 'forbidden', 'run credential requires write scope');
  if (write) {
    const [budget] =
      await tx`insert into extension_write_budgets(workspace_id,installation_id,connection_id,window_start,count)
      values(${workspace},${run.installationId},${run.connectionId ?? null},date_trunc('minute',clock_timestamp()),1)
      on conflict(workspace_id,installation_id,connection_id) do update set
        window_start=excluded.window_start,
        count=case when extension_write_budgets.window_start<>excluded.window_start then 1 else extension_write_budgets.count+1 end
      where extension_write_budgets.window_start<>excluded.window_start or extension_write_budgets.count<60 returning count`;
    if (!budget)
      throw new AppError(429, 'quota_exceeded', 'installation write budget exceeded', {
        retryAfterSeconds: 60,
      });
  }
  return {
    actor: {
      type: installation.granted_actor,
      id: run.installationId,
      // History shows the name, so a workspace run is labelled by its extension too.
      ...(connection
        ? {
            name: `${run.registrationName ?? 'Extension'} (${connection.owner.name ?? connection.owner.id}'s account)`,
          }
        : run.registrationName
          ? { name: run.registrationName }
          : {}),
    },
    scopes: run.scopes,
  };
}

/** Caller already holds schema (and privacy for writes); revocation takes the same installation lock exclusively. */
export async function admitInstallation(
  tx: Tx,
  workspace: string,
  binding: InstallationBinding,
  write = false,
) {
  await lockExtension(tx, workspace, binding.registrationId, true);
  const [installation] = await tx<
    {
      state: string;
      grant_generation: number;
      granted_actor: 'agent' | 'integration';
      granted_scopes: ('read' | 'write')[];
    }[]
  >`select i.state,i.grant_generation,i.granted_actor,i.granted_scopes from extension_installations i join workspaces w on w.id=i.workspace_id
    where i.id=${binding.installationId} and i.registration_id=${binding.registrationId} and w.deletion_scheduled_at is null`;
  // Bound to the grant, not the release: upgrades and settings changes keep the credential.
  if (installation?.state !== 'active' || installation.grant_generation !== binding.grantGeneration)
    throw new AppError(
      409,
      'installation_disabled',
      'installation is disabled or its grant changed',
    );
  const [credential] = await tx<
    { scopes: ('read' | 'write')[]; client_id: string | null; subject_id: string | null }[]
  >`
    select scopes,client_id,subject_id from extension_credentials where id=${binding.credentialId}
    and installation_id=${binding.installationId} and kind=${binding.kind} and generation=${binding.grantGeneration}
    and revoked_at is null and not pending for share`;
  if (
    !credential ||
    binding.scopes.some(
      (s) => !credential.scopes.includes(s) || !installation.granted_scopes.includes(s),
    )
  )
    throw new AppError(
      401,
      'unauthorized',
      'installation credential was revoked or no longer has access',
    );
  if (write && !binding.scopes.includes('write'))
    throw new AppError(403, 'forbidden', 'installation grant requires write scope');
  // OAuth additionally checks the registered client through a minimal privileged function.
  if (binding.kind === 'oauth') {
    const [client] = await tx<
      { allowed: boolean }[]
    >`select retainer_extension_oauth_client_active(${credential.client_id}) as allowed`;
    if (!client?.allowed) throw new AppError(401, 'unauthorized', 'standalone client is disabled');
  }
  if (write) {
    const [budget] =
      await tx`insert into extension_write_budgets(workspace_id,installation_id,window_start,count)
      values(${workspace},${binding.installationId},date_trunc('minute',clock_timestamp()),1)
      on conflict(workspace_id,installation_id,connection_id) do update set window_start=excluded.window_start,
        count=case when extension_write_budgets.window_start<>excluded.window_start then 1 else extension_write_budgets.count+1 end
      where extension_write_budgets.window_start<>excluded.window_start or extension_write_budgets.count<60 returning count`;
    if (!budget)
      throw new AppError(429, 'quota_exceeded', 'installation write budget exceeded', {
        retryAfterSeconds: 60,
      });
  }
  return {
    actor: { type: installation.granted_actor, id: binding.installationId },
    scopes: binding.scopes,
  };
}

/** Caller transaction admission, after its schema/privacy locks and before idempotency or file authorization. */
export async function admitCaller(
  tx: Tx,
  caller: Caller,
  write = false,
  purpose: 'crm' | 'runtime' = 'crm',
) {
  if (caller.run) await admitRun(tx, caller.workspaceId, caller.run, write, purpose);
  if (caller.installation)
    await admitInstallation(tx, caller.workspaceId, caller.installation, write);
}
