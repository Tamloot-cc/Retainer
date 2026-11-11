import type { Tx } from '../db/tx.js';
import { lockExtension } from '../extension-runtime/locks.js';
import { tombstoneEventIdentity } from '../privacy/suppression.js';
import { sourceIdentityChannel } from './policy.js';

/** Called under the exclusive workspace privacy lock, before any record lock or cascade. */
export async function prepareSourceErasure(
  tx: Tx,
  workspace: string,
  eventIds: string[],
  handles: string[],
) {
  const items = await tx<
    {
      id: string;
      account_id: string;
      external_id: string;
      registration_id: string;
      provider: string;
      namespace: string;
    }[]
  >`
    select distinct s.id,s.account_id,s.external_id,a.registration_id,a.provider,a.namespace
    from source_items s join source_accounts a on a.id=s.account_id
    where s.state<>'erased' and (exists(select 1 from source_revisions v where v.item_id=s.id and v.event_id=any(${eventIds}::uuid[]))
      or exists(select 1 from source_participants p where p.item_id=s.id and p.email=any(${handles}::text[]))) order by s.id`;
  if (!items.length) return { eventIds, fileIds: [] as string[], count: 0 };
  const ids = items.map((i) => i.id),
    accounts = [...new Set(items.map((i) => i.account_id))];
  const installations = await tx<
    { id: string; registration_id: string }[]
  >`select i.id,i.registration_id from extension_installations i
    where exists(select 1 from source_bindings b where b.installation_id=i.id and b.account_id=any(${accounts}::uuid[]))
    or exists(select 1 from extension_jobs j where j.installation_id=i.id and j.source_item_id=any(${ids}::uuid[])) order by i.registration_id,i.id`;
  for (const i of installations) await lockExtension(tx, workspace, i.registration_id);
  for (const i of installations) {
    // Drain admitted writes, fence fetched in-memory content, and preserve unrelated durable work.
    const [next] = await tx<
      { generation: number }[]
    >`update extension_installations set generation=generation+1,
      state=case when state in ('installing','upgrading') then 'setup_failed' else state end,
      last_error=case when state in ('installing','upgrading') then 'privacy_setup_restart_required' else last_error end
      where id=${i.id} returning generation`;
    if (!next) continue;
    await tx`update extension_attempts set status='cancelled',code='privacy_erased',finished_at=clock_timestamp()
      where finished_at is null and job_id in(select id from extension_jobs where installation_id=${i.id})`;
    await tx`update extension_jobs set generation=${next.generation},
      status=case when source_item_id=any(${ids}::uuid[]) or (trigger_kind='install' and status in ('queued','running')) then 'cancelled'
        when status='running' then 'queued' else status end,
      input=case when source_item_id=any(${ids}::uuid[]) then '{}'::jsonb else input end,
      input_hash=case when source_item_id=any(${ids}::uuid[]) then '' else input_hash end,
      dedupe_key=case when source_item_id=any(${ids}::uuid[]) then 'erased:'||id::text else dedupe_key end,
      code=case when source_item_id=any(${ids}::uuid[]) then 'privacy_erased' else code end,
      lease_owner=null,lease_until=null,run_until=null,fence=fence+1,updated_at=clock_timestamp()
      where installation_id=${i.id} and generation=${next.generation - 1}`;
    await tx`delete from extension_kv where installation_id=${i.id}`;
    await tx`update source_bindings set generation=${next.generation} where installation_id=${i.id}`;
  }
  await tx`update extension_jobs set input='{}'::jsonb,input_hash='',dedupe_key='erased:'||id::text,
    status='cancelled',code='privacy_erased',lease_owner=null,lease_until=null,run_until=null
    where source_item_id=any(${ids}::uuid[])`;
  await tombstoneEventIdentity(
    tx,
    workspace,
    items.map((i) => ({
      channel: sourceIdentityChannel(i.registration_id, i.provider, i.namespace),
      externalId: i.external_id,
    })),
  );
  const revisions = await tx<
    { event_id: string }[]
  >`select event_id from source_revisions where item_id=any(${ids}::uuid[])`;
  const files = await tx<
    { id: string }[]
  >`select id from files where source_item_id=any(${ids}::uuid[]) and state<>'erased'`;
  await tx`delete from source_receipts where item_id=any(${ids}::uuid[])`;
  await tx`delete from source_participants where item_id=any(${ids}::uuid[])`;
  await tx`delete from source_revisions where item_id=any(${ids}::uuid[])`;
  await tx`update source_items set external_id=null,provider_revision=null,prepared_job_id=null,prepared_fence=null,state='erased',updated_at=clock_timestamp() where id=any(${ids}::uuid[])`;
  return {
    eventIds: [...new Set([...eventIds, ...revisions.map((v) => v.event_id)])],
    fileIds: files.map((f) => f.id),
    count: items.length,
  };
}
