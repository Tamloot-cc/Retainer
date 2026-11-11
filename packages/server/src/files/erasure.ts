import type { Tx } from '../db/tx.js';
import {
  type LockedRecord,
  type RemovedClaim,
  releaseAndRecompute,
  type WriteContext,
} from '../records/write.js';

/** Collect before record/assertion cascades, including shared copies and historical references. */
export async function collectFileErasure(tx: Tx, erasedRecords: string[], sourceEvents: string[]) {
  const rows = await tx<
    { file_id: string }[]
  >`select distinct ref.file_id from file_references ref join field_assertions a on a.id=ref.assertion_id
    where a.record_id=any(${erasedRecords}::uuid[]) or a.source_record_id=any(${sourceEvents}::uuid[])`;
  const fileIds = rows.map((r) => r.file_id);
  const references = fileIds.length
    ? await tx<
        { record_id: string }[]
      >`select distinct a.record_id from file_references ref join field_assertions a on a.id=ref.assertion_id where ref.file_id=any(${fileIds}::uuid[])`
    : [];
  return { fileIds, recordIds: references.map((r) => r.record_id) };
}
export async function queueFileErasure(tx: Tx, workspace: string, fileIds: string[]) {
  if (!fileIds.length) return;
  await tx`insert into file_deletions(workspace_id,storage_id,object_key)
    select workspace_id,storage_id,object_key from files where workspace_id=${workspace} and id=any(${fileIds}::uuid[]) on conflict(object_key) do nothing`;
  // Remove identifying metadata immediately. Storage quota remains reserved until deletion succeeds.
  await tx`update files set state='erasing',metadata='{}'::jsonb,request_hash='' where workspace_id=${workspace} and id=any(${fileIds}::uuid[]) and state<>'erased'`;
}
export async function eraseFileReferences(
  tx: Tx,
  context: WriteContext,
  ids: string[],
  locked: readonly LockedRecord[],
) {
  if (!ids.length) return { deletionIds: [], recomputedRecordIds: [] };
  await queueFileErasure(tx, context.workspaceId, ids);
  const claims = await tx<RemovedClaim[]>`update field_assertions a set value=coalesce((
    select jsonb_agg(item.value order by item.ordinality) from jsonb_array_elements(a.value) with ordinality as item(value,ordinality)
    where (item.value #>> '{}')<>all(${ids}::text[])), '[]'::jsonb)
    where a.id in(select assertion_id from file_references where file_id=any(${ids}::uuid[]))
    returning a.record_id,a.field_id,a.status`;
  await tx`delete from file_references where file_id=any(${ids}::uuid[])`;
  const recomputedRecordIds = await releaseAndRecompute(tx, context, locked, claims);
  const jobs = await tx<
    { id: string }[]
  >`select d.id from file_deletions d join files f on f.object_key=d.object_key and f.storage_id=d.storage_id where f.id=any(${ids}::uuid[])`;
  return { deletionIds: jobs.map((j) => j.id), recomputedRecordIds };
}
