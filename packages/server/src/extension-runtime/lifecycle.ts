import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/tx.js';
import { requestHash } from '../idempotency.js';

/**
 * A partial release job: the `disconnect` hook with input `{ keep: 'current' }`,
 * queued when an OAuth connection's setup fails or it needs reconnecting
 * (Tamloot connect spec 4.7). The SQL twin is `retainer_partial_release_job`.
 * Everywhere else, "disconnect cleanup" means a `disconnect` job that is not this.
 */
export function isPartialReleaseJob(job: { trigger_kind: string; input?: unknown }): boolean {
  return (
    job.trigger_kind === 'disconnect' &&
    typeof job.input === 'object' &&
    job.input !== null &&
    (job.input as { keep?: unknown }).keep === 'current'
  );
}

/** Whether a partial job holds a release change. The SQL twin is `retainer_partial_release_blocking`. */
export function isPartialReleaseBlocking(
  job: {
    trigger_kind: string;
    input: unknown;
    status: string;
    expires_at: Date;
    lease_until: Date | null;
  },
  now: Date,
): boolean {
  return (
    isPartialReleaseJob(job) &&
    ['queued', 'running'].includes(job.status) &&
    (now < job.expires_at ||
      (job.status === 'running' && job.lease_until !== null && now < job.lease_until))
  );
}

/** At most 32 recorded incident IDs per connection, oldest dropped first. */
const MAX_INCIDENTS = 32;
/**
 * Records new release incidents on a connection, under its row lock. An ID
 * already recorded changes nothing; a new one stamps `release_incomplete_at`
 * later than the last incident and the last dismissal (spec 4.7).
 */
export async function recordReleaseIncidents(tx: Tx, connectionId: string, ids: string[]) {
  if (!ids.length) return;
  const [c] = await tx<
    { release_incidents: string[] }[]
  >`select release_incidents from extension_connections where id=${connectionId} for update`;
  if (!c) return;
  const fresh = [...new Set(ids)].filter((id) => !c.release_incidents.includes(id));
  if (!fresh.length) return;
  const incidents = [...c.release_incidents, ...fresh].slice(-MAX_INCIDENTS);
  await tx`update extension_connections set release_incidents=${incidents}::text[],
    release_incomplete_at=greatest(clock_timestamp(),release_incomplete_at+interval '1 microsecond',release_notice_dismissed_at+interval '1 microsecond')
    where id=${connectionId}`;
}

/** A `disconnect` job that held provider credentials and did not finish is an incident. */
export async function recordCleanupFailure(
  tx: Tx,
  job: { id: string; trigger_kind: string; connection_id: string | null },
) {
  if (job.trigger_kind !== 'disconnect' || !job.connection_id) return;
  const [held] =
    await tx`select 1 from extension_connections where id=${job.connection_id} and cardinality(disconnect_secrets)>0`;
  if (held)
    await recordReleaseIncidents(tx, job.connection_id, [`cleanup:${job.id.toLowerCase()}`]);
}

/** Retires the secrets a full disconnect hook kept, once that hook reaches a final state. */
export async function finishMemberCleanup(
  tx: Tx,
  installationId: string,
  job: { trigger_kind: string; input: unknown; connection_id: string | null },
) {
  if (job.trigger_kind !== 'disconnect' || !job.connection_id || isPartialReleaseJob(job)) return;
  await tx`select retainer_finish_member_cleanup(${installationId}::uuid,${job.connection_id}::uuid)`;
}

/**
 * The maintenance sweep's step for one installation, under its queue lock: each
 * partial job past its deadline that no live attempt holds is failed with
 * `cleanup_deadline_expired` and its incident recorded. Changes nothing else.
 */
export async function sweepPartialReleases(tx: Tx, installationId: string) {
  const jobs = await tx<
    { id: string; trigger_kind: string; connection_id: string | null }[]
  >`update extension_jobs set status='failed',code='cleanup_deadline_expired',lease_owner=null,lease_until=null,run_until=null,updated_at=now()
    where installation_id=${installationId} and retainer_partial_release_job(trigger_kind,input)
    and expires_at<=clock_timestamp() and (status='queued' or (status='running' and lease_until<=clock_timestamp()))
    returning id,trigger_kind,connection_id`;
  for (const job of jobs) {
    await tx`update extension_attempts set status='failed',code='cleanup_deadline_expired',finished_at=now()
      where job_id=${job.id} and finished_at is null`;
    await recordCleanupFailure(tx, job);
  }
  return jobs.length;
}

/** Cancels a connection's partial release job when a new connect takes over its sessions. */
export async function supersedePartialRelease(tx: Tx, connectionId: string) {
  const jobs = await tx<
    { id: string }[]
  >`update extension_jobs set status='cancelled',code='superseded',
    lease_owner=null,lease_until=null,run_until=null,updated_at=now()
    where connection_id=${connectionId} and retainer_partial_release_job(trigger_kind,input)
    and status in ('queued','running') returning id`;
  for (const job of jobs)
    await tx`update extension_attempts set status='cancelled',code='superseded',finished_at=now()
      where job_id=${job.id} and finished_at is null`;
}

/** Queues the `{ keep: 'current' }` hook for an OAuth connection that just failed. */
async function queuePartialRelease(
  tx: Tx,
  installation: { id: string; generation: number; release_digest: string },
  connectionId: string,
) {
  const [c] = await tx<
    { workspace_id: string; generation: number; disconnect_function_id: string | null }[]
  >`select workspace_id,generation,disconnect_function_id from extension_connections where id=${connectionId}
    and credential='oauth' and cardinality(disconnect_secrets)>0 and disconnect_function_id is not null`;
  if (!c?.disconnect_function_id) return;
  const fn = c.disconnect_function_id,
    input = { keep: 'current' as const },
    cause: string[] = [];
  await tx`insert into extension_jobs(id,workspace_id,installation_id,connection_id,connection_generation,generation,
    release_digest,function_id,input,input_hash,dedupe_key,cause,trigger_kind,run_secrets,expires_at)
    values(${randomUUID()},${c.workspace_id},${installation.id},${connectionId},${c.generation},${installation.generation},
      ${installation.release_digest},${fn},${tx.json(input)},${requestHash({ functionId: fn, input, cause })},
      ${`abandoned:${connectionId}:${c.generation}`},'[]','disconnect','{}',clock_timestamp()+interval '24 hours')
    on conflict do nothing`;
}

/** Called under the installation and queue locks, including expiration without a live executor. */
export async function failInstallation(
  tx: Tx,
  installation: { id: string; generation: number; release_digest: string; setup_kind: string },
  job: {
    generation: number;
    release_digest: string;
    trigger_kind: string;
    input?: unknown;
    connection_id?: string | null;
    connection_generation?: number | null;
  },
  code: string,
) {
  if (job.trigger_kind === 'configure') return;
  // A partial release job never changes its connection (spec 4.7).
  if (isPartialReleaseJob(job)) return;
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
      await tx`select generation,state from extension_connections where id=${job.connection_id} and installation_id=${installation.id}`;
    if (!c || c.generation !== connectionGeneration) return;
    if (job.trigger_kind === 'connect') {
      await tx`update extension_jobs set status='cancelled',code='connection_setup_failed',lease_owner=null,lease_until=null,run_until=null,updated_at=now()
        where connection_id=${job.connection_id} and connection_generation=${connectionGeneration} and status in ('queued','running')`;
      await tx`delete from extension_schedules where connection_id=${job.connection_id}`;
      await tx`update extension_connections set state='setup_failed',health=${health},last_error=${code},generation=generation+1 where id=${job.connection_id}`;
      await queuePartialRelease(tx, installation, job.connection_id);
    } else {
      if (health === 'needs_reconnect')
        await tx`delete from extension_schedules where connection_id=${job.connection_id}`;
      await tx`update extension_connections set state=case when ${health}='needs_reconnect' and state='active' then 'needs_reconnect' else state end,
        health=${health},last_error=${code} where id=${job.connection_id}`;
      if (health === 'needs_reconnect' && c.state === 'active')
        await queuePartialRelease(tx, installation, job.connection_id);
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
