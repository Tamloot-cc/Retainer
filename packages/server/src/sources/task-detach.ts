import type { Actor } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { type LockedRecord, type WriteContext, writeFields } from '../records/write.js';
import type { FieldState } from '../schema/types.js';

/** Called with task records locked. Human history permanently ends provider ownership. */
export async function detachEditedTasks(
  tx: Tx,
  context: WriteContext,
  locked: LockedRecord[],
  eventIds?: string[],
) {
  const records = new Map(locked.map((record) => [record.id, record]));
  const rows = await tx<
    {
      id: string;
      record_id: string;
      granted_actor: 'agent' | 'integration';
      installation_id: string;
      actor_name: string | null;
    }[]
  >`
    select t.id,t.record_id,i.granted_actor,t.installation_id,t.actor_name from source_tasks t
    join extension_installations i on i.id=t.installation_id
    where t.state='synced' and t.record_id=any(${[...records.keys()]}::uuid[])
    ${eventIds ? tx`and t.source_event_id=any(${eventIds}::uuid[])` : tx``}
    and exists(select 1 from field_assertions a where a.record_id=t.record_id and a.actor->>'type'='user') order by t.record_id`;
  for (const row of rows) {
    const record = records.get(row.record_id);
    const object = record && context.schema.objectsById.get(record.object_type_id);
    if (record && object && !record.deleted_at && !record.merged_into_id) {
      // Retain the provider's current winning values before its evidence is retracted.
      const claims = await tx<
        { field_id: string; value: unknown }[]
      >`select field_id,value from field_assertions where record_id=${record.id} and status='active' and source_record_id is not null`;
      const values = new Map<FieldState, unknown>();
      for (const claim of claims) {
        const field = object.fieldsById.get(claim.field_id);
        if (field?.status === 'active' && !field.settings.isInverse) values.set(field, claim.value);
      }
      const actor: Actor = {
        type: row.granted_actor,
        id: row.installation_id,
        ...(row.actor_name ? { name: row.actor_name } : {}),
      };
      if (values.size) await writeFields(tx, { ...context, actor }, object, record, values);
    }
    await tx`update source_tasks set state='detached',content_digest=null where id=${row.id}`;
  }
  return rows.length;
}
