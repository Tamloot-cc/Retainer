import type { Tx } from '../db/tx.js';

/** Called under the installation and queue locks, including expiration without a live executor. */
export async function failInstallation(
  tx: Tx,
  installation: { id: string; generation: number; release_digest: string; setup_kind: string },
  job: { generation: number; release_digest: string; trigger_kind: string },
  code: string,
) {
  if (
    job.generation !== installation.generation ||
    job.release_digest !== installation.release_digest
  )
    return;
  const health = ['connection_required', 'invalid_connection', 'provider_unauthorized'].includes(
    code,
  )
    ? 'needs_reconnect'
    : 'degraded';
  if (job.trigger_kind === 'install') {
    await tx`update extension_installations set state=${installation.setup_kind === 'upgrade' ? 'disabled' : 'setup_failed'},
      connection_health=${health},last_error=${code},updated_at=now()
      where id=${installation.id} and generation=${job.generation} and release_digest=${job.release_digest} and state in ('installing','upgrading')`;
  } else {
    await tx`update extension_installations set connection_health=${health},last_error=${code},updated_at=now()
      where id=${installation.id} and generation=${job.generation} and release_digest=${job.release_digest} and state in ('active','uninstalling')`;
  }
}
