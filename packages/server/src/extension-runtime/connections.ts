import { randomUUID } from 'node:crypto';
import type { Tx } from '../db/tx.js';
import { requestHash } from '../idempotency.js';
import { lockExtension, lockQueue } from './locks.js';

/** Caller holds schema and, when membership changes, privacy/member locks first. */
export async function disconnectConnection(tx: Tx, workspace: string, id: string) {
  const [candidate] =
    await tx`select c.installation_id,i.registration_id from extension_connections c
    join extension_installations i on i.id=c.installation_id where c.id=${id}`;
  if (!candidate) return false;
  await lockExtension(tx, workspace, candidate.registration_id);
  await lockQueue(tx, workspace, candidate.installation_id);
  const [connection] = await tx`select c.*,i.generation as installation_generation,i.release_digest
    from extension_connections c join extension_installations i on i.id=c.installation_id where c.id=${id} for update of c`;
  if (!connection || connection.state === 'disconnected') return false;
  await tx`update extension_attempts set status='cancelled',code='connection_disconnected',finished_at=clock_timestamp()
    where finished_at is null and job_id in(select id from extension_jobs where connection_id=${id})`;
  await tx`update extension_jobs set status='cancelled',code='connection_disconnected',lease_owner=null,lease_until=null,run_until=null,updated_at=now()
    where connection_id=${id} and status in ('queued','running')`;
  await tx`delete from extension_schedules where connection_id=${id}`;
  await tx`delete from source_bindings where connection_id=${id}`;
  await tx`delete from source_sync_state where connection_id=${id}`;
  await tx`delete from extension_kv where connection_id=${id}`;
  await tx`update extension_connections set generation=generation+1,state='disconnected',disconnected_at=clock_timestamp(),last_error=null where id=${id}`;
  await tx`select retainer_retire_member_secrets(${connection.installation_id}::uuid,${id}::uuid)`;
  if (connection.disconnect_function_id) {
    const fn = connection.disconnect_function_id,
      input = {},
      cause: string[] = [];
    await tx`insert into extension_jobs(id,workspace_id,installation_id,connection_id,connection_generation,generation,
      release_digest,function_id,input,input_hash,dedupe_key,cause,trigger_kind,run_secrets)
      values(${randomUUID()},${workspace},${connection.installation_id},${id},${connection.generation + 1},${connection.installation_generation},
        ${connection.release_digest},${fn},'{}',${requestHash({ functionId: fn, input, cause })},${`disconnect:${id}:${connection.generation + 1}`},'[]','disconnect','{}')`;
  }
  return true;
}

export async function disconnectMemberConnections(tx: Tx, workspace: string, owner: string) {
  const rows =
    await tx`select c.id from extension_connections c join extension_installations i on i.id=c.installation_id
    where c.owner_id=${owner} and c.state<>'disconnected' order by i.registration_id,i.id,c.id`;
  for (const row of rows) await disconnectConnection(tx, workspace, row.id);
}
