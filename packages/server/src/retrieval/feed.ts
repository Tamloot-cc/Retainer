import { createHash } from 'node:crypto';
import {
  isoDateTimeSchema,
  type WorkspaceFeedItem,
  type WorkspaceFeedPage,
} from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { AppError, requireUser } from '../errors.js';
import { readOnlyFieldsFor, refuseOwnedWrite } from '../extension-runtime/owned-fields.js';
import { currentActivityEvidence } from '../memory/events.js';
import { presentRecords, type RecordRow, recordColumns } from '../records/read.js';
import { relationReferences } from '../records/references.js';
import { withRead, withWrite } from '../records/service.js';
import { lockRecordsForUpdate, releaseAndRecompute, resolveRecordId } from '../records/write.js';
import type { CompiledSchema } from '../schema/compiled.js';
import { presentValues } from './timeline.js';

export const feedInputSchema = z.strictObject({
  mode: z.enum(['all', 'events', 'records']).default('all'),
  types: z.array(z.string().min(1)).max(100).optional(),
  query: z.string().trim().max(200).optional(),
  channel: z.string().min(1).max(200).optional(),
  linked: z.uuid().optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  limit: z.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(2000).optional(),
});
const positionSchema = z.object({
  // Preserve Postgres microseconds: a JS Date would skip writes at page boundaries.
  at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/)
    .refine((value) => Number.isFinite(Date.parse(value))),
  id: z.uuid(),
  binding: z.string(),
});

function sharedActivityRecord(tx: Tx, workspaceId: string, typeIds: readonly string[]) {
  // Personal profiles/internal notes are excluded even when the caller can read them.
  return tx`r.workspace_id = ${workspaceId} and r.deleted_at is null
    and ${currentActivityEvidence(tx, tx`r.id`)}
    and r.private_to_user is null and r.object_type_id = any(${[...typeIds]}::uuid[])`;
}

function displayedUpdates(tx: Tx, schema: CompiledSchema) {
  const visibleFields = [...schema.fieldOwners].flatMap(([id, object]) =>
    object.fieldsById.get(id)?.status === 'active' ? [id] : [],
  );
  return tx`r.object_type_id <> all(${schema.eventTypeIds}::uuid[])
    and a.field_id=any(${visibleFields}::uuid[])
    and a.private_to_user is null and a.reviewed_at is null and a.status in ('active', 'superseded')
    and not a.is_initial and a.write_at is not null and a.write_at <> r.created_at
    and a.value is distinct from (
      select prior.value from field_assertions prior
      where prior.record_id=a.record_id and prior.field_id=a.field_id
        and prior.status in ('active','superseded') and prior.reviewed_at is null
        and (prior.created_at,prior.id) < (a.created_at,a.id)
      order by prior.created_at desc,prior.id desc limit 1)`;
}

export const revertFeedUpdateInput = z.strictObject({
  recordId: z.uuid(),
  assertionIds: z.array(z.uuid()).min(1),
});

export async function revertFeedUpdate(
  sql: Sql,
  caller: Caller,
  id: string,
  { recordId, assertionIds }: z.infer<typeof revertFeedUpdateInput>,
) {
  requireUser(caller.actor, 'revert a Home update');
  return withWrite(sql, caller, async (tx, context) => {
    const [record] = await lockRecordsForUpdate(tx, context.workspaceId, [recordId]);
    // Match the card's group exactly under the record lock. A stale card can have
    // a different set of visible assertions after an earlier retraction or merge.
    const assertions =
      record && !record.deleted_at
        ? await tx<{ id: string; record_id: string; field_id: string; status: string }[]>`
          select a.id, a.record_id, a.field_id, a.status
          from records r
          join field_assertions anchor on anchor.record_id=r.id and anchor.id=${id}
          join field_assertions a on a.record_id=r.id and a.write_at=anchor.write_at
            and a.actor=anchor.actor and a.source_record_id is not distinct from anchor.source_record_id
          where r.id=${record.id} and ${sharedActivityRecord(tx, context.workspaceId, context.schema.visibleObjectIds)}
            and ${displayedUpdates(tx, context.schema)}
          order by a.id`
        : [];
    const expected = assertionIds.map((assertionId) => assertionId.toLowerCase()).sort();
    if (
      !record ||
      assertions[0]?.id !== id.toLowerCase() ||
      assertions.length !== expected.length ||
      assertions.some((assertion, index) => assertion.id !== expected[index])
    ) {
      throw new AppError(409, 'stale_update', 'This update changed. Refresh Home and try again.');
    }
    const fieldIds = assertions.map((assertion) => assertion.field_id);
    const object = context.schema.objectsById.get(record.object_type_id);
    const fields =
      object?.activeFields.filter((field) => fieldIds.includes(field.id as string)) ?? [];
    refuseOwnedWrite(await readOnlyFieldsFor(tx, caller, fieldIds), fields);
    await tx`update field_assertions set status='retracted' where id=any(${expected}::uuid[])`;
    await releaseAndRecompute(tx, context, [record], assertions);
    return { id, retractedAssertions: assertions.length };
  });
}

/** Read projection only. Object writes remain assertions, never synthetic events. */
export async function workspaceFeed(
  sql: Sql,
  caller: Caller,
  input: z.infer<typeof feedInputSchema>,
): Promise<WorkspaceFeedPage> {
  return withRead(sql, caller, async (tx, schema) => {
    const linkedId = input.linked
      ? await resolveRecordId(tx, caller.workspaceId, input.linked)
      : undefined;
    const typeIds = input.types?.length
      ? input.types.map((name) => {
          const object = schema.objectsByName.get(name);
          if (!object || !schema.visibleObjectIds.includes(object.id)) {
            throw new AppError(400, 'unknown_object', `Unknown object: ${name}`);
          }
          return object.id;
        })
      : schema.visibleObjectIds;
    const binding = createHash('sha256')
      .update(
        JSON.stringify([
          caller.workspaceId,
          input.mode,
          [...typeIds].sort(),
          input.query ?? '',
          input.channel ?? null,
          linkedId ?? null,
          input.from ?? null,
          input.to ?? null,
        ]),
      )
      .digest('base64url');
    let position: z.infer<typeof positionSchema> | undefined;
    if (input.cursor) {
      try {
        position = positionSchema.parse(
          JSON.parse(Buffer.from(input.cursor, 'base64url').toString()),
        );
      } catch {
        throw new AppError(400, 'invalid_cursor', 'Start again from the newest activity.');
      }
      if (position.binding !== binding)
        throw new AppError(
          400,
          'invalid_cursor',
          'The feed filters changed. Start again from the newest activity.',
        );
    }
    const visible = sharedActivityRecord(tx, caller.workspaceId, typeIds);
    const sourceFilter = (source: ReturnType<typeof tx>) =>
      input.channel
        ? tx`exists (select 1 from event_records e join records s on s.id=e.record_id
          where e.record_id=${source} and e.channel=${input.channel} and s.deleted_at is null
            and s.object_type_id=any(${schema.visibleObjectIds}::uuid[]))`
        : tx`true`;
    const linked = linkedId
      ? tx`(r.id=${linkedId} or exists (select 1 from event_links l
          join records target on target.id=l.record_id and target.deleted_at is null
          where l.event_id=r.id and l.record_id=${linkedId}
            and target.object_type_id=any(${schema.visibleObjectIds}::uuid[])))`
      : tx`true`;
    const query = input.query
      ? tx`r.search @@ websearch_to_tsquery('simple', ${input.query})`
      : tx`true`;
    const rows = await tx<
      {
        id: string;
        record_id: string;
        kind: WorkspaceFeedItem['kind'];
        at: Date;
        stamp: string;
        actor: WorkspaceFeedItem['actor'];
        assertion_ids: string[];
        field_ids: string[];
      }[]
    >`
      with activity as (
        select r.id, r.id as record_id, case when e.record_id is null then 'record_created' else 'event' end as kind,
          r.created_at as at, r.created_by as actor, array[]::uuid[] as assertion_ids, array[]::uuid[] as field_ids
        from records r left join event_records e on e.record_id=r.id
        where ${visible} and ${linked} and ${query} and ${sourceFilter(tx`r.id`)}
          and (${input.mode} = 'all' or (${input.mode} = 'events' and e.record_id is not null)
            or (${input.mode} = 'records' and e.record_id is null))
        union all
        select (array_agg(a.id order by a.id))[1], r.id, 'record_updated',
          a.write_at, a.actor, array_agg(a.id order by a.id), array_agg(distinct a.field_id)
        from field_assertions a join records r on r.id=a.record_id
        where ${visible} and ${linked} and ${query} and ${sourceFilter(tx`a.source_record_id`)}
          and ${input.mode} <> 'events'
          and ${displayedUpdates(tx, schema)}
        group by r.id, a.write_at, a.actor, a.source_record_id
      )
      select *, at::text as stamp from activity
      where ${input.from ? tx`at >= ${input.from}::timestamptz` : tx`true`}
        and ${input.to ? tx`at < ${input.to}::timestamptz` : tx`true`}
        and ${position ? tx`(at,id) < (${position.at}::timestamptz,${position.id}::uuid)` : tx`true`}
      order by at desc, id desc limit ${input.limit + 1}`;
    const page = rows.slice(0, input.limit);
    const ids = [...new Set(page.map((row) => row.record_id))];
    const recordRows = ids.length
      ? await tx<RecordRow[]>`select ${recordColumns(tx)} from records where id=any(${ids}::uuid[])`
      : [];
    const canWrite =
      caller.actor.type === 'user' &&
      (caller.scopes.includes('write') || caller.scopes.includes('admin'));
    const [records, changes, readOnlyFields] = await Promise.all([
      presentRecords(tx, schema, recordRows),
      presentValues(
        tx,
        schema,
        page.flatMap((row) => row.assertion_ids),
      ),
      canWrite
        ? readOnlyFieldsFor(tx, caller, [...new Set(page.flatMap((row) => row.field_ids))])
        : new Set<string>(),
    ]);
    const byId = new Map(records.map((record) => [record.id, record]));
    const items = page.flatMap((row): WorkspaceFeedItem[] => {
      const record = byId.get(row.record_id);
      if (!record) return [];
      const cardChanges = row.assertion_ids.flatMap((id) => {
        const item = changes.get(id);
        return item?.kind === 'field_change' ? [item] : [];
      });
      return [
        {
          id: row.id,
          kind: row.kind,
          at: row.at.toISOString(),
          actor: row.actor,
          record,
          changes: cardChanges,
          ...(canWrite &&
          row.kind === 'record_updated' &&
          cardChanges.length === row.assertion_ids.length &&
          row.field_ids.every((id) => !readOnlyFields.has(id))
            ? { canRevert: true }
            : {}),
        },
      ];
    });
    const last = page.at(-1);
    return {
      items,
      references: await relationReferences(tx, schema, records),
      nextCursor:
        rows.length > input.limit && last
          ? Buffer.from(JSON.stringify({ at: last.stamp, id: last.id, binding })).toString(
              'base64url',
            )
          : null,
    };
  });
}
