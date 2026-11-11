import type { Tx } from '../db/tx.js';
import { lockExtension } from '../extension-runtime/locks.js';

/** Privacy already holds the workspace lock exclusively. Drain all run/KV admissions in sorted order. */
export async function eraseExtensionState(
  tx: Tx,
  workspace: string,
  records: string[],
  items: string[],
  accounts: string[],
) {
  const installations = await tx<
    { id: string; registration_id: string; generation: number; source_affected: boolean }[]
  >`select i.id,i.registration_id,i.generation,
    (exists(select 1 from source_bindings b where b.installation_id=i.id and b.account_id=any(${accounts}::uuid[]))
      or exists(select 1 from extension_jobs j where j.installation_id=i.id and j.source_item_id=any(${items}::uuid[]))) as source_affected
    from extension_installations i where i.workspace_id=${workspace} order by i.registration_id,i.id`;
  for (const installation of installations)
    await lockExtension(tx, workspace, installation.registration_id);
  const changes = await tx<
    { position: string }[]
  >`select position::text from record_changes where record_id=any(${records}::uuid[]) or related_record_ids ?| ${records}::text[]`;
  const positions = changes.map((c) => c.position),
    identities = [...new Set([...records, ...items])];
  for (const installation of installations) {
    const [current] = await tx<
      { generation: number }[]
    >`select generation from extension_installations where id=${installation.id}`;
    if (!current) continue;
    const generation = current.generation + (installation.source_affected ? 1 : 0);
    if (installation.source_affected) {
      await tx`update extension_installations set generation=${generation},
        state=case when state in ('installing','upgrading') then 'setup_failed' else state end,
        last_error=case when state in ('installing','upgrading') then 'privacy_setup_restart_required' else last_error end where id=${installation.id}`;
      await tx`update source_bindings set generation=${generation} where installation_id=${installation.id}`;
      await tx`update change_dispatch set generation=${generation} where installation_id=${installation.id}`;
      await tx`update webhook_bindings set generation=${generation} where installation_id=${installation.id} and state<>'retired'`;
    }
    await tx`update extension_attempts set status='cancelled',code='privacy_erased',finished_at=clock_timestamp()
      where finished_at is null and job_id in(select id from extension_jobs where installation_id=${installation.id})`;
    const erasedInput = tx`(source_item_id=any(${items}::uuid[]) or input->>'changePosition'=any(${positions}::text[])
      or exists(select 1 from unnest(${identities}::text[]) value where strpos(input::text,value)>0 or strpos(change_snapshot::text,value)>0))`;
    // Restart unrelated work with a new fence, so a process holding fetched content cannot resume it.
    // Other installations keep their grant generation; source-bound installs also advance identity generation.
    await tx`update extension_jobs set generation=${generation},
      status=case when ${erasedInput} or (${installation.source_affected} and trigger_kind='install' and status in ('queued','running')) then 'cancelled'
        when status='running' then 'queued' else status end,
      input=case when ${erasedInput} then '{}'::jsonb else input end,
      change_snapshot=case when ${erasedInput} then null else change_snapshot end,
      input_hash=case when ${erasedInput} then '' else input_hash end,
      dedupe_key=case when ${erasedInput} then 'erased:'||id::text else dedupe_key end,
      code=case when ${erasedInput} then 'privacy_erased' else code end,
      lease_owner=null,lease_until=null,run_until=null,fence=fence+1,updated_at=clock_timestamp()
      where installation_id=${installation.id} and generation=${current.generation}`;
    await tx`delete from extension_kv where installation_id=${installation.id}`;
  }
  // Retained diagnostics from prior generations must lose erased item/record inputs as well.
  await tx`update extension_jobs set input='{}'::jsonb,change_snapshot=null,input_hash='',dedupe_key='erased:'||id::text,status='cancelled',code='privacy_erased',
    lease_owner=null,lease_until=null,run_until=null where source_item_id=any(${items}::uuid[]) or input->>'changePosition'=any(${positions}::text[])
    or exists(select 1 from unnest(${identities}::text[]) value where strpos(input::text,value)>0 or strpos(change_snapshot::text,value)>0)`;
}
