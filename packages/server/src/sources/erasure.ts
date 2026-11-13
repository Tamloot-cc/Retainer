import type { Tx } from '../db/tx.js';
import { eraseExtensionState } from '../privacy/extension-erasure.js';
import { tombstoneEventIdentity } from '../privacy/suppression.js';
import { sourceIdentityChannel, taskIdentityChannel } from './policy.js';

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
  // A forgotten task suppresses that identity; erasing its meeting also erases detached copies.
  let tasks = await tx<
    {
      record_id: string;
      external_id: string;
      registration_id: string;
      provider: string;
      namespace: string;
      account_id: string;
    }[]
  >`
    select t.record_id,t.external_id,a.registration_id,a.provider,a.namespace,t.account_id from source_tasks t join source_accounts a on a.id=t.account_id
    where t.item_id=any(${ids}::uuid[]) or t.source_event_id=any(${allEvents}::uuid[])
      or t.record_id=any(${recordIds}::uuid[])
      or exists(select 1 from records r where r.id=t.record_id and r.merged_into_id=any(${recordIds}::uuid[]))`;
  let taskRecordIds = [...new Set(tasks.map((t) => t.record_id))];
  // Privacy erases a merged family and suppresses every bound alias in it.
  if (taskRecordIds.length) {
    const family = await tx<{ id: string }[]>`with recursive family(id,merged_into_id) as (
      select id,merged_into_id from records where id=any(${taskRecordIds}::uuid[])
      union select r.id,r.merged_into_id from records r join family f on r.id=f.merged_into_id or r.merged_into_id=f.id
    ) select id from family`;
    taskRecordIds = [...new Set(family.map((r) => r.id))];
    tasks = await tx<
      typeof tasks
    >`select t.record_id,t.external_id,a.registration_id,a.provider,a.namespace,t.account_id from source_tasks t join source_accounts a on a.id=t.account_id where t.record_id=any(${taskRecordIds}::uuid[])`;
  }
  if (tasks.length)
    await tombstoneEventIdentity(
      tx,
      workspace,
      tasks.map((t) => ({
        channel: taskIdentityChannel(t.registration_id, t.provider, t.namespace),
        externalId: t.external_id,
      })),
    );
  await eraseExtensionState(
    tx,
    workspace,
    [...new Set([...recordIds, ...allEvents, ...taskRecordIds])],
    ids,
    [...new Set([...accounts, ...tasks.map((t) => t.account_id)])],
    [...handles, ...tasks.map((t) => t.external_id)],
  );
  if (tasks.length)
    await tx`delete from source_tasks where record_id=any(${taskRecordIds}::uuid[])`;
  if (!items.length)
    return { eventIds: allEvents, taskRecordIds, fileIds: [] as string[], count: 0 };
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
  await tx`delete from webhook_receipts where source_item_id=any(${ids}::uuid[])`;
  await tx`delete from source_receipts where item_id=any(${ids}::uuid[])`;
  await tx`delete from source_participants where item_id=any(${ids}::uuid[])`;
  await tx`delete from source_revisions where item_id=any(${ids}::uuid[])`;
  await tx`update source_items set external_id=null,provider_revision=null,prepared_job_id=null,prepared_fence=null,state='erased',updated_at=clock_timestamp() where id=any(${ids}::uuid[])`;
  return {
    eventIds: allEvents,
    taskRecordIds,
    fileIds: files.map((f) => f.id),
    count: items.length,
  };
}
