import type {
  Actor,
  PresentedFact,
  ProfileAlias,
  ReviewQueue,
  UnresolvedParticipant,
} from '@retainer/shared';
import type { Fragment } from 'postgres';
import { after, page } from '../db/pagination.js';
import type { Tx } from '../db/tx.js';
import { liveFactSource } from '../memory/events.js';
import { factSources } from '../memory/facts.js';
import { references } from '../records/references.js';
import { type CompiledSchema, eventText } from '../schema/compiled.js';
import { assertions } from './records.js';

export async function reviewPage(
  tx: Tx,
  _workspaceId: string,
  schema: CompiledSchema,
  limit: number,
  cursors: Record<string, string>,
): Promise<ReviewQueue> {
  const pendingWhere = tx`a.status = 'pending_review' and r.deleted_at is null and a.field_id in (select id from fields where status = 'active')`;
  const unresolvedWhere = tx`p.unmatched_reason = 'deleted_record' and p.record_id is null and ev.deleted_at is null and ev.object_type_id = any(${schema.eventTypeIds}::uuid[])`;
  const [pending, suggestions, unresolved, totals] = await Promise.all([
    assertions(tx, schema, pendingWhere, limit, cursors.pendingAssertionsCursor),
    tx<
      {
        id: string;
        record_a_id: string;
        record_b_id: string;
        reason: string;
        created_at: Date;
        stamp: string;
      }[]
    >`select *, created_at::text as stamp from merge_suggestions where status = 'pending' and ${after(tx, tx`created_at`, tx`id`, cursors.mergeSuggestionsCursor)} order by created_at, id limit ${limit + 1}`,
    tx<
      {
        id: string;
        stamp: string;
        event_id: string;
        position: number;
        handle: string | null;
        role: string | null;
        occurred_at: Date;
        object_type_id: string;
        data: Record<string, unknown>;
      }[]
    >`select p.id, e.occurred_at::text as stamp, p.event_id, p.position, p.handle, p.role, e.occurred_at, ev.object_type_id, ev.data from event_links p join records ev on ev.id = p.event_id join event_records e on e.record_id = ev.id where ${unresolvedWhere} and ${after(tx, tx`e.occurred_at`, tx`p.id`, cursors.unresolvedParticipantsCursor)} order by e.occurred_at, p.id limit ${limit + 1}`,
    tx<{ pending: number; merges: number; unresolved: number }[]>`select
      (select count(*)::int from field_assertions a join records r on r.id = a.record_id where ${pendingWhere}) as pending,
      (select count(*)::int from merge_suggestions where status = 'pending') as merges,
      (select count(*)::int from event_links p join records ev on ev.id = p.event_id where ${unresolvedWhere}) as unresolved`,
  ]);
  const m = page(suggestions, limit),
    u = page(unresolved, limit);
  const handles = u.items.flatMap((r) => (r.handle ? [r.handle] : []));
  const [labels, deleted] = await Promise.all([
    references(
      tx,
      schema,
      m.items.flatMap((r) => [r.record_a_id, r.record_b_id]),
    ),
    handles.length
      ? tx<
          { value: string; record_id: string }[]
        >`select distinct x.value, x.record_id from record_identifiers x join records r on r.id = x.record_id where x.kind = 'email' and x.is_claim and x.value = any(${handles}) and r.deleted_at is not null and r.merged_into_id is null`
      : [],
  ]);
  return {
    pendingAssertions: pending.items,
    mergeSuggestions: m.items.map((r) => ({
      id: r.id,
      recordIds: [r.record_a_id, r.record_b_id],
      records: [r.record_a_id, r.record_b_id].flatMap((id) => {
        const reference = labels[id];
        return reference ? [reference] : [];
      }),
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    })),
    unresolvedParticipants: u.items.map(
      (r): UnresolvedParticipant => ({
        eventId: r.event_id,
        position: r.position,
        handle: r.handle,
        role: r.role,
        occurredAt: r.occurred_at.toISOString(),
        title: eventText(schema.objectsById.get(r.object_type_id), r.data).title,
        deletedRecordIds: deleted.filter((d) => d.value === r.handle).map((d) => d.record_id),
      }),
    ),
    totals: {
      pendingAssertions: totals[0]?.pending ?? 0,
      mergeSuggestions: totals[0]?.merges ?? 0,
      unresolvedParticipants: totals[0]?.unresolved ?? 0,
    },
    nextCursors: {
      pendingAssertions: pending.nextCursor,
      mergeSuggestions: m.nextCursor,
      unresolvedParticipants: u.nextCursor,
    },
  };
}
export async function factsPage(
  tx: Tx,
  schema: CompiledSchema,
  where: Fragment,
  limit: number,
  cursor?: string,
  history = false,
): Promise<{ facts: PresentedFact[]; nextCursor: string | null }> {
  const rows = await tx<
    {
      id: string;
      stamp: string;
      record_id: string;
      content: string;
      kind: 'stated' | 'inferred';
      valid_from: Date;
      valid_to: Date | null;
      actor: Actor;
      deleted_at: Date | null;
      superseded_by: string | null;
      replaced_at: Date | null;
      record_type: string;
    }[]
  >`select f.*, f.valid_from::text as stamp,
      (select r.object_type_id from records r where r.id = f.record_id) as record_type
    from facts f where ${where}
    ${history ? tx`` : tx`and f.deleted_at is null and f.superseded_by is null and f.replaced_at is null and f.valid_to is null and exists(${liveFactSource(tx, tx`f.id`)})`}
    and ${after(tx, tx`f.valid_from`, tx`f.id`, cursor, true)} order by f.valid_from desc, f.id desc limit ${limit + 1}`;
  const result = page(rows, limit);
  const ids = result.items.map((r) => r.id);
  const sources = await factSources(tx, schema, ids);
  return {
    facts: result.items.map((r) => ({
      id: r.id,
      ...(history
        ? {
            status: r.deleted_at
              ? ('retracted' as const)
              : // Replaced stays superseded even once its replacement is erased (4.9).
                r.superseded_by || r.replaced_at
                ? ('superseded' as const)
                : r.valid_to
                  ? ('ended' as const)
                  : ('current' as const),
          }
        : {}),
      // A profile's fact names it by alias (personal memory spec 4.4).
      ...(schema.objectsById.get(r.record_type)?.profile
        ? { profile: schema.objectsById.get(r.record_type)?.profile as ProfileAlias }
        : { record: r.record_id }),
      content: r.content,
      kind: r.kind,
      validFrom: r.valid_from.toISOString(),
      validTo: r.valid_to?.toISOString() ?? null,
      writtenBy: r.actor,
      sources: sources.get(r.id) ?? [],
    })),
    nextCursor: result.nextCursor,
  };
}
