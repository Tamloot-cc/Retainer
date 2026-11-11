import type { Tx } from '../db/tx.js';
import { eraseExtensionState } from '../privacy/extension-erasure.js';
import { tombstoneEventIdentity } from '../privacy/suppression.js';
import { sourceIdentityChannel } from './policy.js';

/** Called under the exclusive workspace privacy lock, before any record lock or cascade. */
export async function prepareSourceErasure(
  tx: Tx,
  workspace: string,
  eventIds: string[],
  handles: string[],
  recordIds: string[],
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
  const ids = items.map((i) => i.id),
    accounts = [...new Set(items.map((i) => i.account_id))];
  const revisions = ids.length
    ? await tx<
        { event_id: string }[]
      >`select event_id from source_revisions where item_id=any(${ids}::uuid[])`
    : [];
  const allEvents = [...new Set([...eventIds, ...revisions.map((v) => v.event_id)])];
  await eraseExtensionState(
    tx,
    workspace,
    [...new Set([...recordIds, ...allEvents])],
    ids,
    accounts,
  );
  if (!items.length) return { eventIds: allEvents, fileIds: [] as string[], count: 0 };
  await tombstoneEventIdentity(
    tx,
    workspace,
    items.map((i) => ({
      channel: sourceIdentityChannel(i.registration_id, i.provider, i.namespace),
      externalId: i.external_id,
    })),
  );
  const files = await tx<
    { id: string }[]
  >`select id from files where source_item_id=any(${ids}::uuid[]) and state<>'erased'`;
  await tx`delete from source_receipts where item_id=any(${ids}::uuid[])`;
  await tx`delete from source_participants where item_id=any(${ids}::uuid[])`;
  await tx`delete from source_revisions where item_id=any(${ids}::uuid[])`;
  await tx`update source_items set external_id=null,provider_revision=null,prepared_job_id=null,prepared_fence=null,state='erased',updated_at=clock_timestamp() where id=any(${ids}::uuid[])`;
  return {
    eventIds: allEvents,
    fileIds: files.map((f) => f.id),
    count: items.length,
  };
}
