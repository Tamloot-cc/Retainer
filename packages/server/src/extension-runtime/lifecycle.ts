import type { Tx } from '../db/tx.js';

/** Called under the installation and queue locks, including expiration without a live executor. */
export async function failInstallation(
  tx: Tx,
  installation: { id: string; generation: number; release_digest: string; setup_kind: string },
  job: {
    generation: number;
    release_digest: string;
    trigger_kind: string;
    connection_id?: string | null;
    connection_generation?: number | null;
  },
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
  if (job.connection_id) {
    const connectionGeneration = job.connection_generation ?? null;
    const [c] =
      await tx`select generation from extension_connections where id=${job.connection_id} and installation_id=${installation.id}`;
    if (!c || c.generation !== connectionGeneration) return;
    if (job.trigger_kind === 'connect') {
      await tx`update extension_jobs set status='cancelled',code='connection_setup_failed',lease_owner=null,lease_until=null,run_until=null,updated_at=now()
        where connection_id=${job.connection_id} and connection_generation=${connectionGeneration} and status in ('queued','running')`;
      await tx`delete from extension_schedules where connection_id=${job.connection_id}`;
      await tx`update extension_connections set state='setup_failed',health=${health},last_error=${code},generation=generation+1 where id=${job.connection_id}`;
    } else {
      if (health === 'needs_reconnect')
        await tx`delete from extension_schedules where connection_id=${job.connection_id}`;
      await tx`update extension_connections set state=case when ${health}='needs_reconnect' and state='active' then 'needs_reconnect' else state end,
        health=${health},last_error=${code} where id=${job.connection_id}`;
    }
    return;
  }
  if (job.trigger_kind === 'install') {
    await tx`update extension_installations set state=${installation.setup_kind === 'upgrade' ? 'disabled' : 'setup_failed'},
      connection_health=${health},last_error=${code},updated_at=now()
      where id=${installation.id} and generation=${job.generation} and release_digest=${job.release_digest} and state in ('installing','upgrading')`;
  } else {
    await tx`update extension_installations set connection_health=${health},last_error=${code},updated_at=now()
      where id=${installation.id} and generation=${job.generation} and release_digest=${job.release_digest} and state in ('active','uninstalling')`;
  }
}
