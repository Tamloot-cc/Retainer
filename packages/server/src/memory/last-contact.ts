import { BASE_EVENT_TYPE_IDS } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import {
  lockRecord,
  objectOf,
  recomputeFields,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import type { FieldState } from '../schema/types.js';
import { eventHistory, type HistoryRow, lockSource } from './events.js';

/** The caller holds the schema lock exclusively: evidence, links and target are one stable snapshot. */
export async function reconcileLastContact(
  tx: Tx,
  context: WriteContext,
  id: string,
  field: FieldState,
) {
  const fieldId = field.id;
  if (!fieldId) throw new Error('persisted derivation field required');
  const conversation = context.schema.objectsByUniversalId.get(BASE_EVENT_TYPE_IDS.conversation);
  const [latest] = await tx<HistoryRow[]>`select h.* from ${eventHistory(
    tx,
    context.schema,
    context.workspaceId,
    id,
    {
      limit: 1,
      eventTypeIds: conversation?.state.status === 'active' ? [conversation.id] : [],
      where: (time) => tx`${time}<=clock_timestamp()`,
    },
  )} h order by h.occurred_at desc,h.event_id desc limit 1`;
  const source = latest ? await lockSource(tx, context, latest.event_id) : null;
  const record = await lockRecord(tx, context.workspaceId, id),
    object = objectOf(context.schema, record);
  const [prior] = await tx<
    { id: string; value: string; source_record_id: string | null; status: string }[]
  >`
    select id,value,source_record_id,status from field_assertions
    where record_id=${record.id} and field_id=${fieldId} and actor->>'id'=${context.actor.id} and actor->>'type'=${context.actor.type}
    order by created_at desc,id desc limit 1`;
  const supports = latest
    ? [
        ...new Set([latest.event_id, ...(latest.via_record_id ? [latest.via_record_id] : [])]),
      ].sort()
    : [];
  if (
    source &&
    prior &&
    prior.status !== 'retracted' &&
    prior.source_record_id === source.id &&
    prior.value === source.occurredAt.toISOString()
  ) {
    const dependencies = await tx<
      { support_record_id: string }[]
    >`select support_record_id from assertion_dependencies where assertion_id=${prior.id} order by support_record_id`;
    if (
      JSON.stringify(dependencies.map((entry) => entry.support_record_id)) ===
      JSON.stringify(supports)
    )
      return { changed: false, value: prior.value };
  }
  const retired =
    await tx`update field_assertions set status='retracted' where record_id=${record.id} and field_id=${fieldId}
    and actor->>'id'=${context.actor.id} and actor->>'type'=${context.actor.type} and status in ('active','superseded','pending_review') returning id`;
  if (!source) {
    if (retired.length) await recomputeFields(tx, context, object, record, [fieldId]);
    return { changed: retired.length > 0, value: null };
  }
  await writeFields(
    tx,
    context,
    object,
    record,
    new Map([[field, source.occurredAt.toISOString()]]),
    {
      sourceRecordId: source.id,
      observedAt: source.occurredAt,
    },
  );
  const [assertion] = await tx<
    { id: string }[]
  >`select id from field_assertions where record_id=${record.id} and field_id=${fieldId}
    and actor->>'id'=${context.actor.id} and actor->>'type'=${context.actor.type} order by created_at desc,id desc limit 1`;
  if (!assertion) throw new Error('derived assertion missing');
  for (const support of supports)
    await tx`insert into assertion_dependencies(workspace_id,assertion_id,support_record_id) values(${context.workspaceId},${assertion.id},${support})`;
  return { changed: true, value: source.occurredAt.toISOString() };
}
