import type { MergeResult, MergeSuggestionDecision } from '@retainer/shared';
import { FieldValueError, MULTI_VALUE_TYPES } from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError, notFound, requireUser } from '../errors.js';
import type { CompiledObject, CompiledSchema } from '../schema/compiled.js';
import { type FieldState, relationTargetIds } from '../schema/types.js';
import { getRecord } from './read.js';
import { normalizeFieldValue, prepareValues } from './values.js';
import { sameValue } from './winner.js';
import {
  closeSuggestionsFor,
  lockRecordsForUpdate,
  objectOf,
  recomputeFields,
  resolveRecordId,
  type WriteContext,
  writeFields,
} from './write.js';

/**
 * Merging duplicate records (4.2). Only a `user` actor merges: an agent's
 * key scope is not human approval (3). The consolidator only suggests.
 */

export const mergeInputSchema = z.strictObject({
  /** The record to merge into the one in the path; it is soft-deleted. */
  recordId: z.uuid(),
  /**
   * Values the survivor should end with, by field name, written as the
   * merging user. They replace the defaults below for those fields.
   */
  values: z.record(z.string(), z.unknown()).optional(),
});
export type MergeInput = z.infer<typeof mergeInputSchema>;

/** A record changed between resolving and locking it; the caller retries the transaction. */
export class MergeRaceError extends Error {
  constructor() {
    super('a record was merged or deleted while this merge was starting');
  }
}

type MultiValue = { primary: unknown; additional?: unknown[] };

/**
 * The default for an `emails`, `phones` or `links` field (4.2): both
 * current winners combined and deduplicated, A's primary kept if present
 * (otherwise B's), the rest in `additional`. With only one value, that one.
 * Too many values for the field's `maxValues` fails, so nothing is
 * silently dropped.
 */
export function combineMultiValues(field: FieldState, survivor: unknown, merged: unknown): unknown {
  const a = survivor as MultiValue | null | undefined;
  const b = merged as MultiValue | null | undefined;
  if (!b) return a ?? null;
  if (!a) return b;
  const all = [a.primary, ...(a.additional ?? []), b.primary, ...(b.additional ?? [])].filter(
    (v) => v !== null && v !== undefined,
  );
  const primary = a.primary ?? b.primary ?? null;
  // Duplicates of the primary and of each other are dropped by normalizing.
  const additional = all.filter((v) => v !== primary);
  try {
    return normalizeFieldValue(field, { primary, additional });
  } catch (error) {
    if (!(error instanceof FieldValueError)) throw error;
    throw new AppError(
      422,
      'too_many_values',
      `the combined ${field.name} of both records do not fit the field: ${error.message}. ` +
        `Pass values.${field.name} with the ones to keep`,
      { field: field.name, maxValues: field.settings.maxValues ?? null },
    );
  }
}

/** Relation fields, on any object, whose target is this object. */
export function inboundRelationFields(schema: CompiledSchema, object: CompiledObject): string[] {
  return schema.state.objects.flatMap((o) =>
    o.fields
      .filter(
        (f) =>
          f.type === 'relation' &&
          !f.settings.isInverse &&
          relationTargetIds(f.settings).includes(object.state.universalId),
      )
      .map((f) => f.id as string),
  );
}

/**
 * Merges record `input.recordId` (B) into `survivorId` (A), in one
 * transaction (4.2):
 *
 * 1. Resolve both to canonical IDs. B already merged into A is a no-op.
 * 2. Lock A and B `FOR UPDATE` in sorted ID order, then every record with a
 *    relation assertion pointing at B. A relation write locks its target
 *    `FOR KEY SHARE`, so one that started earlier commits first and is seen
 *    here, and one that starts later waits and then follows the merge.
 * 3. Point inbound relation assertions and links at A, keeping provenance.
 * 4. Move B's assertions, facts, comments and event links to A; drop B's
 *    identifiers and links, then recompute the moved fields of A with the
 *    normal rules, which rebuilds identifiers and revalidates unique claims.
 * 5. For `emails`, `phones` and `links`, write the combined current winners
 *    as the merging user; `values` overrides any field.
 * 6. Soft-delete B with `merged_into_id = A`, point records merged into B at
 *    A so chains stay one hop, accept the pair's suggestion and close B's
 *    others.
 */
export async function mergeRecords(
  tx: Tx,
  context: WriteContext,
  survivorId: string,
  input: MergeInput,
): Promise<MergeResult> {
  requireUser(context.actor, 'merge records');
  const { workspaceId } = context;
  if (survivorId === input.recordId) {
    throw new AppError(422, 'invalid_merge', 'a record cannot be merged into itself');
  }
  const a = await resolveRecordId(tx, workspaceId, survivorId);
  const b = await resolveRecordId(tx, workspaceId, input.recordId);
  if (a === b) {
    if (a !== survivorId) {
      throw new AppError(
        409,
        'record_merged',
        `record ${survivorId} was merged into ${a}; merge into ${a} instead`,
        { recordId: a },
      );
    }
    return {
      id: a,
      mergedId: input.recordId,
      merged: false,
      recomputedRecordIds: [],
      record: await getRecord(tx, workspaceId, context.schema, a),
    };
  }

  const pair = [a, b].sort() as [string, string];
  const locked = await lockRecordsForUpdate(tx, workspaceId, pair);
  for (const id of pair) await context.changes?.capture(tx, id);
  const survivor = locked.find((r) => r.id === a);
  const merged = locked.find((r) => r.id === b);
  if (!survivor || !merged || survivor.merged_into_id || merged.merged_into_id) {
    throw new MergeRaceError();
  }
  for (const record of [survivor, merged]) {
    if (record.deleted_at) {
      throw new AppError(409, 'record_deleted', `record ${record.id} is deleted`, {
        recordId: record.id,
      });
    }
  }
  const object = objectOf(context.schema, survivor);
  if (object.isEvent) {
    throw new AppError(
      422,
      'invalid_merge',
      'events cannot be merged: each is something that happened, logged from its own source. ' +
        'Delete a duplicate event instead',
    );
  }
  if (merged.object_type_id !== survivor.object_type_id) {
    throw new AppError(
      422,
      'wrong_object',
      `record ${b} is a ${objectOf(context.schema, merged).name}, not a ${object.name}; ` +
        'only records of the same object can be merged',
    );
  }
  const overrides = prepareValues(object, input.values ?? {}, 'update');

  // Inbound relations: lock their records, then point them at A. The
  // winning assertion stays the same row, so its edge simply follows it.
  let inboundIds: string[] = [];
  const relationFieldIds = inboundRelationFields(context.schema, object);
  if (relationFieldIds.length > 0) {
    // A single-record value is B; a set (many_to_many) holds B among others.
    const pointsAtB = tx`(value = ${tx.json(b)}
      or (jsonb_typeof(value) = 'array' and value @> ${tx.json([b])}))`;
    const inbound = await tx<{ record_id: string }[]>`
      select distinct record_id from field_assertions
      where workspace_id = ${workspaceId} and field_id = any(${relationFieldIds}::uuid[])
        and ${pointsAtB} and record_id <> all(${pair}::uuid[])`;
    inboundIds = inbound.map((r) => r.record_id).sort();
    await lockRecordsForUpdate(tx, workspaceId, inboundIds);
    for (const id of inboundIds) await context.changes?.capture(tx, id);
    await tx`
      update field_assertions set value = ${tx.json(a)}
      where workspace_id = ${workspaceId} and field_id = any(${relationFieldIds}::uuid[])
        and value = ${tx.json(b)}`;
    // In a set, B becomes A once: membership is deduplicated and kept in ID
    // order (byte order, as the server sorts), so it still compares equal.
    await tx`
      update field_assertions set value = (
        select coalesce(jsonb_agg(x order by x collate "C"), '[]'::jsonb)
        from (select distinct case when v = ${b} then ${a} else v end as x
          from jsonb_array_elements_text(value) v) d)
      where workspace_id = ${workspaceId} and field_id = any(${relationFieldIds}::uuid[])
        and jsonb_typeof(value) = 'array' and value @> ${tx.json([b])}`;
    // Edges follow; an edge to B whose source already links to A is dropped.
    await tx`
      delete from record_links d using record_links k
      where d.workspace_id = ${workspaceId} and d.target_record_id = ${b}
        and k.source_record_id = d.source_record_id and k.field_id = d.field_id
        and k.target_record_id = ${a}`;
    await tx`
      update record_links set target_record_id = ${a}
      where workspace_id = ${workspaceId} and target_record_id = ${b}
        and source_record_id <> ${b}`;
  }

  // Move B's claims to A and release its identifiers and edges.
  await tx`delete from record_identifiers where record_id = ${b}`;
  await tx`delete from record_links where source_record_id = ${b}`;
  const moved = await tx<{ field_id: string }[]>`
    update field_assertions set record_id = ${a} where record_id = ${b} returning field_id`;
  await tx`update facts set record_id = ${a} where record_id = ${b}`;
  // Comments keep their authors and times; they were written, not re-written.
  await tx`update comments set record_id = ${a} where record_id = ${b}`;
  const linked = await tx<
    { event_id: string }[]
  >`select distinct event_id from event_links where record_id=${b}`;
  for (const { event_id } of linked) await context.changes?.capture(tx, event_id);
  await tx`update event_links set record_id = ${a} where record_id = ${b}`;
  // An event is about a record once: drop an about link that now repeats
  // another link to the survivor (1.3).
  await tx`
    delete from event_links d using event_links k
    where d.workspace_id = ${workspaceId} and d.record_id = ${a} and d.link = 'about'
      and k.event_id = d.event_id and k.record_id = ${a} and k.id <> d.id
      and (k.link = 'participant' or k.position < d.position)`;
  // The survivor changed even when no field did (it gained B's facts), so
  // the consolidator's next run compares it again.
  await tx`
    update records set updated_at = clock_timestamp(), updated_by = ${tx.json(context.actor)}
    where id = ${a}`;

  const before = survivor.data;
  await recomputeFields(tx, context, object, survivor, [...new Set(moved.map((m) => m.field_id))]);

  const combined = new Map<FieldState, unknown>();
  for (const field of object.activeFields) {
    if (!MULTI_VALUE_TYPES.has(field.type) || overrides.has(field)) continue;
    const value = combineMultiValues(field, before[field.key], merged.data[field.key]);
    if (!sameValue(value, survivor.data[field.key] ?? null)) combined.set(field, value);
  }
  // B's handles were released above, but both records held them while
  // live: they are not coming back, so they skip the suppression check.
  if (combined.size > 0) {
    await writeFields(tx, context, object, survivor, combined, { skipSuppressionCheck: true });
  }
  if (overrides.size > 0) await writeFields(tx, context, object, survivor, overrides);

  await tx`
    update records set merged_into_id = ${a}, deleted_at = clock_timestamp(),
      updated_at = clock_timestamp(), updated_by = ${tx.json(context.actor)},
      data = '{}'::jsonb, label = null, search = null
    where id = ${b}`;
  await tx`update records set merged_into_id = ${a} where merged_into_id = ${b}`;
  await tx`
    update merge_suggestions set status = 'accepted', decided_by = ${tx.json(context.actor)},
      decided_at = clock_timestamp()
    where workspace_id = ${workspaceId} and record_a_id = ${pair[0]}
      and record_b_id = ${pair[1]} and status = 'pending'`;
  await closeSuggestionsFor(tx, context, [b]);

  return {
    id: a,
    mergedId: b,
    merged: true,
    recomputedRecordIds: inboundIds,
    record: await getRecord(tx, workspaceId, context.schema, a),
  };
}

/** Dismisses a suggested merge; the consolidator never suggests the pair again. */
export async function dismissMergeSuggestion(
  tx: Tx,
  context: WriteContext,
  id: string,
): Promise<MergeSuggestionDecision> {
  requireUser(context.actor, 'decide merge suggestions');
  const [row] = await tx<{ status: string }[]>`
    select status from merge_suggestions
    where id = ${id} and workspace_id = ${context.workspaceId}
    for update`;
  if (!row) throw notFound('merge suggestion', { id });
  if (row.status !== 'pending') {
    throw new AppError(409, 'not_pending', `merge suggestion is ${row.status}, not pending`);
  }
  await tx`
    update merge_suggestions set status = 'dismissed', decided_by = ${tx.json(context.actor)},
      decided_at = clock_timestamp()
    where id = ${id}`;
  return { id, status: 'dismissed' };
}
