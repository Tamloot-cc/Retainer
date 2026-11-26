import type { Tx } from '../db/tx.js';
import { lockExtension } from '../extension-runtime/locks.js';

/**
 * Privacy already holds the workspace lock exclusively. Drain all run/KV admissions in sorted order.
 * Installations bound to an affected source account or item advance their generation and lose all KV
 * (§11). Every running job in the workspace is requeued with a new fence, because a run that only read
 * the erased record could otherwise write its content back. Unrelated queued jobs and KV survive, except
 * jobs and KV entries that name an erased record, item, change or handle.
 */
export async function eraseExtensionState(
  tx: Tx,
  workspace: string,
  records: string[],
  items: string[],
  accounts: string[],
  handles: string[],
) {
  const installations = await tx<
    { id: string; registration_id: string }[]
  >`select id,registration_id from extension_installations where workspace_id=${workspace} order by registration_id,id`;
  for (const installation of installations)
    await lockExtension(tx, workspace, installation.registration_id);
  // Suggestions may contain arbitrary copied CRM values or explanations. Erasure clears all of them.
  await tx`delete from extension_suggestions where workspace_id=${workspace}`;
  const changes = await tx<
    { position: string }[]
  >`select position::text from record_changes where record_id=any(${records}::uuid[]) or related_record_ids ?| ${records}::text[]`;
  const positions = changes.map((c) => c.position),
    // Handles are normalized lower-case emails or E.164 phones; match JSON text case-insensitively.
    identities = [
      ...new Set([...records, ...items, ...handles].map((v) => v.toLowerCase()).filter(Boolean)),
    ];
  const erasedInput = tx`(source_item_id=any(${items}::uuid[]) or input->>'changePosition'=any(${positions}::text[])
    or exists(select 1 from unnest(${identities}::text[]) erased
      where strpos(lower(input::text),erased)>0 or strpos(lower(change_snapshot::text),erased)>0))`;
  const affected = await tx<{ id: string; generation: number }[]>`select i.id,i.generation
    from extension_installations i where i.workspace_id=${workspace}
      and (exists(select 1 from source_bindings b where b.installation_id=i.id and b.account_id=any(${accounts}::uuid[]))
        or exists(select 1 from extension_jobs j where j.installation_id=i.id and j.source_item_id=any(${items}::uuid[])))
    order by i.registration_id,i.id`;
  for (const installation of affected) {
    const current = installation.generation,
      generation = current + 1;
    await tx`update extension_installations set generation=${generation},
      state=case when state in ('installing','upgrading') then 'setup_failed' else state end,
      last_error=case when state in ('installing','upgrading') then 'privacy_setup_restart_required' else last_error end where id=${installation.id}`;
    await tx`update source_bindings set generation=${generation} where installation_id=${installation.id}`;
    await tx`update change_dispatch set generation=${generation} where installation_id=${installation.id}`;
    await tx`update webhook_bindings set generation=${generation} where installation_id=${installation.id} and state<>'retired'`;
    // Source-linked KV (cursors, provider IDs) may name the erased item; reset it with the generation.
    await tx`delete from extension_kv where installation_id=${installation.id}`;
    await tx`update extension_attempts set status='cancelled',code='privacy_erased',finished_at=clock_timestamp()
      where finished_at is null and job_id in(select id from extension_jobs where installation_id=${installation.id})`;
    await tx`update extension_connections set generation=generation+1,state='setup_failed',health='degraded',last_error='privacy_setup_restart_required'
      where installation_id=${installation.id} and state='connecting'`;
    // Unrelated durable work moves to the new generation with a new fence; a setup run must be retried.
    await tx`update extension_jobs set generation=${generation},
      status=case when ${erasedInput} or (trigger_kind in ('install','connect') and status in ('queued','running')) then 'cancelled'
        when status='running' then 'queued' else status end,
      lease_owner=null,lease_until=null,run_until=null,fence=fence+1,updated_at=clock_timestamp()
      where installation_id=${installation.id} and generation=${current}`;
  }
  // Any other live run may hold content it read before erasure: cancel its attempt and requeue it with a new fence.
  await tx`update extension_attempts set status='cancelled',code='privacy_erased',finished_at=clock_timestamp()
    where finished_at is null and job_id in(select id from extension_jobs where workspace_id=${workspace} and status='running')`;
  await tx`update extension_jobs set status='queued',lease_owner=null,lease_until=null,run_until=null,fence=fence+1,updated_at=clock_timestamp()
    where workspace_id=${workspace} and status='running'`;
  // KV is for operational cursors/IDs; elsewhere, drop only entries that name an erased identity.
  await tx`delete from extension_kv where workspace_id=${workspace}
    and exists(select 1 from unnest(${identities}::text[]) erased where strpos(lower(key),erased)>0 or strpos(lower(value::text),erased)>0)`;
  // Jobs naming an erased identity are redacted and cancelled in every installation and generation.
  await tx`update extension_jobs set input='{}'::jsonb,change_snapshot=null,input_hash='',dedupe_key='erased:'||id::text,status='cancelled',code='privacy_erased',
    lease_owner=null,lease_until=null,run_until=null,updated_at=clock_timestamp() where workspace_id=${workspace} and ${erasedInput}`;
}
