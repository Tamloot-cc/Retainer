import { type Actor, type ActorType, isProfileAlias } from '@retainer/shared';
import type { CallerPerson } from '../caller.js';
import { isUuid } from '../db/ids.js';
import type { AssertionStatus, ReviewReason } from '../db/schema.js';
import { jsonValue, type Tx } from '../db/tx.js';
import { AppError, notFound, profileNotSupported } from '../errors.js';
import { isSuppressed, suppressedOf, suppressibleHandles } from '../privacy/suppression.js';
import type { CompiledObject, CompiledSchema } from '../schema/compiled.js';
import { type FieldState, relationTargetIds } from '../schema/types.js';
import { identifiersFor, searchTextOf } from './derive.js';
import { searchVector } from './search-sql.js';
import { compareAssertions, pickWinner, type RankedAssertion, reviewReason } from './winner.js';

/** Everything a write needs: who, where, and the schema it validated against. */
export type WriteContext = {
  workspaceId: string;
  actor: Actor;
  schema: CompiledSchema;
  /** Agent assertions below this confidence wait for review (rule 2.3). */
  confidenceThreshold: number;
  /**
   * The person whose personal memory the credential reaches (personal memory
   * spec 4.3); `app.user_id` is set to them for the transaction.
   */
  person?: CallerPerson | undefined;
};

export type WriteOptions = {
  /** The event record the values come from; kept as provenance. */
  sourceRecordId?: string | null;
  /**
   * When the claim was true at the source: the cited event's `occurred_at`.
   * Without it, the server's clock at write time (rule 2.2).
   */
  observedAt?: Date | null;
  /** `log_event` writing an event's own initial values (6.2). */
  isInitial?: boolean;
  /** 0..1; direct writes are 1. */
  confidence?: number;
  /** Rejects the write if the record changed since (rule 2.5). */
  expectedUpdatedAt?: string;
  /**
   * Skips the suppression check (2.1). Only for values live records already
   * hold, such as the combined emails a merge writes.
   */
  skipSuppressionCheck?: boolean;
};

/** What happened to each written field (6.2). */
export type FieldWriteStatus = 'applied' | 'pending_review' | 'superseded';

export type LockedRecord = {
  id: string;
  object_type_id: string;
  data: Record<string, unknown>;
  updated_at: Date;
  deleted_at: Date | null;
  merged_into_id: string | null;
};

/** Another record already holds a unique value (1.2). */
export class UniqueConflictError extends AppError {
  constructor(
    readonly field: FieldState,
    readonly value: string,
    readonly recordId: string,
  ) {
    super(
      409,
      'unique_conflict',
      `${field.name} value ${value} already belongs to record ${recordId}`,
      {
        field: field.name,
        value,
        recordId,
        candidates: [recordId],
        errors: [{ field: field.name, message: 'already belongs to another record' }],
      },
    );
  }
}

type AssertionRow = {
  id: string;
  field_id: string;
  value: unknown;
  actor: Actor;
  status: AssertionStatus;
  observed_at: Date;
  created_at: Date;
};

const toRanked = (row: AssertionRow): RankedAssertion => ({
  id: row.id,
  actorType: row.actor.type,
  observedAt: row.observed_at,
  createdAt: row.created_at,
  status: row.status,
  value: row.value,
});

/** Fields whose values become rows in `record_identifiers`. */
const hasIdentifiers = (field: FieldState) =>
  field.isUnique || field.type === 'emails' || field.type === 'phones' || field.type === 'links';

/**
 * Merges flatten chains (4.2), so a merged ID is one hop from its survivor;
 * the limit only stops a corrupt cycle.
 */
export const MAX_MERGE_HOPS = 16;

/** Follows `merged_into_id` to the surviving record (4.2). */
export async function resolveRecordId(tx: Tx, workspaceId: string, id: string): Promise<string> {
  if (isProfileAlias(id)) throw profileNotSupported(id);
  if (!isUuid(id)) throw notFound('record', { id });
  let current = id;
  for (let hops = 0; hops < MAX_MERGE_HOPS; hops++) {
    const [row] = await tx<{ merged_into_id: string | null }[]>`
      select merged_into_id from records where id = ${current} and workspace_id = ${workspaceId}`;
    if (!row) throw notFound('record', { id });
    if (!row.merged_into_id) return current;
    current = row.merged_into_id;
  }
  throw new AppError(409, 'merge_cycle', `record ${id} has a merge chain that does not end`);
}

/**
 * Locks a live record for writing (rule 2.5). A merged ID resolves to the
 * surviving record; a deleted record cannot be written.
 *
 * Writes take `FOR NO KEY UPDATE`, so they serialize with each other but
 * not with the `FOR KEY SHARE` a relation write takes on its target. Merges
 * and deletes take `FOR UPDATE`, which waits for both.
 */
export async function lockRecord(tx: Tx, workspaceId: string, id: string): Promise<LockedRecord> {
  const canonical = await resolveRecordId(tx, workspaceId, id);
  const [row] = await tx<LockedRecord[]>`
    select id, object_type_id, data, updated_at, deleted_at, merged_into_id from records
    where id = ${canonical} and workspace_id = ${workspaceId}
    for no key update`;
  if (!row) throw notFound('record', { id });
  if (row.merged_into_id) return lockRecord(tx, workspaceId, row.merged_into_id);
  if (row.deleted_at) {
    throw new AppError(409, 'record_deleted', `record ${canonical} is deleted`, {
      recordId: canonical,
    });
  }
  return row;
}

/**
 * The object of a record a caller writes. The hidden internal-note type
 * (6.4) resolves as not found: its records change only through `remember`
 * and the fact and privacy lifecycle. A profile (personal memory spec 4.4)
 * is refused with the tools that take it.
 */
export function objectOf(
  schema: CompiledSchema,
  record: { id?: string; object_type_id: string },
): CompiledObject {
  const object = schema.objectsById.get(record.object_type_id);
  if (object?.profile) throw profileNotSupported(record.id);
  if (object?.hidden) throw notFound('record', record.id ? { id: record.id } : undefined);
  if (object?.state.status !== 'active') {
    throw new AppError(409, 'object_deleted', 'the object of this record was deleted');
  }
  return object;
}

type TargetRow = {
  id: string;
  object_type_id: string;
  deleted_at: Date | null;
  merged_into_id: string | null;
};

/**
 * Locks relation targets `FOR KEY SHARE` in sorted ID order, following
 * merges (4.2). A merge locks the record it removes `FOR UPDATE`, so this
 * waits for it; READ COMMITTED then sees the merged row, and the value
 * moves to the survivor.
 */
export async function lockTargets(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
): Promise<Map<string, TargetRow | undefined>> {
  const lock = (some: readonly string[]) => tx<TargetRow[]>`
    select id, object_type_id, deleted_at, merged_into_id from records
    where workspace_id = ${workspaceId} and id = any(${some as string[]}::uuid[])
    order by id for key share`;
  const rows = new Map((await lock(ids)).map((r) => [r.id, r]));
  const targets = new Map<string, TargetRow | undefined>();
  for (const id of ids) {
    let row = rows.get(id);
    for (let hops = 0; row?.merged_into_id && hops < MAX_MERGE_HOPS; hops++) {
      [row] = await lock([row.merged_into_id]);
    }
    targets.set(id, row?.merged_into_id ? undefined : row);
  }
  return targets;
}

/** The objects a relation field may point at, by their compiled schema entries. */
export function relationTargets(schema: CompiledSchema, field: FieldState): CompiledObject[] {
  return relationTargetIds(field.settings).flatMap((id) => {
    const target = schema.objectsByUniversalId.get(id);
    return target ? [target] : [];
  });
}

/**
 * Relation values must point at a live record of the target object, in this
 * workspace. A merged ID is replaced by its surviving record, as for any ID
 * a caller passes.
 */
async function checkRelationTargets(
  tx: Tx,
  context: WriteContext,
  object: CompiledObject,
  writes: Map<FieldState, unknown>,
): Promise<void> {
  const relations = [...writes].filter(
    (entry): entry is [FieldState, string | string[]] =>
      entry[0].type === 'relation' && entry[1] !== null,
  );
  if (relations.length === 0) return;
  const byId = await lockTargets(tx, context.workspaceId, [
    ...new Set(relations.flatMap(([, value]) => (Array.isArray(value) ? value : [value]))),
  ]);
  const errors = [];
  for (const [field, value] of relations) {
    const allowed = relationTargets(context.schema, field);
    const resolved: string[] = [];
    for (const targetId of Array.isArray(value) ? value : [value]) {
      const target = byId.get(targetId);
      if (!target || target.deleted_at) {
        errors.push({ field: field.name, message: `no live record ${targetId}` });
      } else if (!allowed.some((o) => o.id === target.object_type_id)) {
        errors.push({
          field: field.name,
          message: `record ${targetId} is not a ${allowed.map((o) => o.name).join(' or ') || 'valid target'}`,
        });
      } else resolved.push(target.id);
    }
    // A merged ID is replaced by its survivor; a set is normalized again,
    // since two IDs may now name one record.
    writes.set(
      field,
      Array.isArray(value) ? [...new Set(resolved)].sort() : (resolved[0] ?? value),
    );
  }
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_values', `invalid values for ${object.name}`, { errors });
  }
}

/**
 * Emails and phones erased by `forget` cannot be written again (2.1). A
 * handle the record already holds is not new: another live record can
 * share a phone with the forgotten person and keeps it. The caller holds
 * the privacy lock in shared mode, so the check and the write commit
 * inside the same boundary as `forget`. The error names the field, never
 * the value.
 */
async function checkSuppressed(
  tx: Tx,
  context: WriteContext,
  record: LockedRecord,
  writes: Map<FieldState, unknown>,
): Promise<void> {
  const handles = [...writes].flatMap(([field, value]) =>
    suppressibleHandles(field, value).map((handle) => ({ field, handle })),
  );
  const suppressed = await suppressedOf(
    tx,
    context.workspaceId,
    handles.map((h) => h.handle),
  );
  const hits = handles.filter((h) => isSuppressed(suppressed, h.handle));
  if (hits.length === 0) return;
  const held = await tx<{ value: string }[]>`
    select value from record_identifiers
    where record_id = ${record.id} and kind in ('email', 'phone')`;
  const heldValues = new Set(held.map((h) => h.value));
  const hit = hits.find((h) => !heldValues.has(h.handle.value));
  if (hit) {
    throw new AppError(
      409,
      'suppressed',
      `a value of ${hit.field.name} was erased by a privacy request and cannot be stored again`,
      {
        field: hit.field.name,
        errors: [
          {
            field: hit.field.name,
            message: 'was erased by a privacy request and cannot be stored again',
          },
        ],
      },
    );
  }
}

/**
 * The write path (rules 2.2–2.5). With the record row locked: insert one
 * assertion per field, recompute only the touched fields' winners, then
 * update `data`, `record_links`, `record_identifiers`, label and search in
 * the same transaction.
 */
export async function writeFields(
  tx: Tx,
  context: WriteContext,
  object: CompiledObject,
  record: LockedRecord,
  writes: Map<FieldState, unknown>,
  options: WriteOptions = {},
): Promise<Record<string, FieldWriteStatus>> {
  if (
    options.expectedUpdatedAt !== undefined &&
    record.updated_at.getTime() !== new Date(options.expectedUpdatedAt).getTime()
  ) {
    throw new AppError(412, 'stale_write', 'the record changed since expectedUpdatedAt', {
      updatedAt: record.updated_at.toISOString(),
    });
  }
  await checkRelationTargets(tx, context, object, writes);
  if (!options.skipSuppressionCheck) await checkSuppressed(tx, context, record, writes);

  const fields = [...writes.keys()];
  const fieldIds = fields.map((f) => f.id as string);
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() as now`;
  const observedAt = options.observedAt ?? (clock?.now as Date);
  const confidence = options.confidence ?? 1;
  const actorType: ActorType = context.actor.type;

  const existing = await tx<AssertionRow[]>`
    select id, field_id, value, actor, status, observed_at, created_at from field_assertions
    where record_id = ${record.id} and field_id = any(${fieldIds}::uuid[])
      and status in ('active', 'superseded')`;

  const statuses: Record<string, FieldWriteStatus> = {};
  const winners = new Map<FieldState, AssertionRow | undefined>();

  for (const field of fields) {
    const value = writes.get(field);
    const current = existing.filter((a) => a.field_id === field.id);
    const currentWinner = pickWinner(current.map(toRanked));
    const reason: ReviewReason | null = reviewReason(
      { actorType, value, observedAt, confidence },
      currentWinner,
      context.confidenceThreshold,
    );

    const [inserted] = await tx<AssertionRow[]>`
      insert into field_assertions (workspace_id, record_id, field_id, value, actor,
        source_record_id, is_initial, confidence, status, review_reason, observed_at, created_at)
      values (${context.workspaceId}, ${record.id}, ${field.id as string},
        ${value === null ? null : tx.json(jsonValue(value))}, ${tx.json(context.actor)},
        ${options.sourceRecordId ?? null}, ${options.isInitial ?? false}, ${confidence},
        ${reason ? 'pending_review' : 'active'}, ${reason}, ${observedAt}, clock_timestamp())
      returning id, field_id, value, actor, status, observed_at, created_at`;
    const assertion = inserted as AssertionRow;

    if (reason) {
      statuses[field.name] = 'pending_review';
      continue;
    }

    const candidates = [...current, assertion];
    const winner = candidates.find((a) => a.id === pickWinner(candidates.map(toRanked))?.id);
    const winnerId = winner?.id as string;
    await tx`update field_assertions set status = 'active'
      where id = ${winnerId} and status <> 'active'`;
    await tx`update field_assertions set status = 'superseded'
      where record_id = ${record.id} and field_id = ${field.id as string}
        and status = 'active' and id <> ${winnerId}`;
    statuses[field.name] = winnerId === assertion.id ? 'applied' : 'superseded';
    winners.set(field, winner);
  }

  if (winners.size > 0) await applyWinners(tx, context, object, record, winners);
  return statuses;
}

/**
 * Makes `records.data`, `record_links`, `record_identifiers`, the label and
 * the search text follow the given fields' winners (rule 2.4). The record
 * must be locked.
 */
async function applyWinners(
  tx: Tx,
  context: WriteContext,
  object: CompiledObject,
  record: LockedRecord,
  winners: Map<FieldState, AssertionRow | undefined>,
  identifiersDone: ReadonlySet<FieldState> = new Set(),
): Promise<void> {
  const data = { ...record.data };
  for (const [field, winner] of winners) {
    if (field.type === 'relation') {
      // One edge per target; a set's edges are marked by the database (5.3).
      const targets = Array.isArray(winner?.value)
        ? (winner.value as string[])
        : winner?.value
          ? [winner.value as string]
          : [];
      // Only the edges that changed: a set gaining one member keeps the rest.
      await tx`delete from record_links where source_record_id = ${record.id}
        and field_id = ${field.id as string} and target_record_id <> all(${targets}::uuid[])`;
      if (targets.length > 0) {
        await tx`
          insert into record_links ${tx(
            targets.map((target) => ({
              workspace_id: context.workspaceId,
              field_id: field.id as string,
              source_record_id: record.id,
              target_record_id: target,
              created_by: tx.json(jsonValue(winner?.actor ?? context.actor)),
            })),
          )}
          on conflict (workspace_id, source_record_id, field_id, target_record_id) do update
            set created_by = excluded.created_by
            where record_links.created_by is distinct from excluded.created_by`;
      }
      continue;
    }
    if (winner) data[field.key] = winner.value;
    else delete data[field.key];

    if (hasIdentifiers(field) && !identifiersDone.has(field)) {
      await replaceIdentifiers(tx, context.workspaceId, record.id, field, winner?.value ?? null);
    }
  }

  const { label, body } = searchTextOf(object.state.fields, object.labelField, data);
  const [updated] = await tx<{ updated_at: Date }[]>`
    update records set data = ${tx.json(jsonValue(data))}, label = ${label},
      search = ${searchVector(tx, label, body)}, updated_at = clock_timestamp(),
      updated_by = ${tx.json(context.actor)}
    where id = ${record.id}
    returning updated_at`;
  record.data = data;
  record.updated_at = updated?.updated_at ?? record.updated_at;
}

/**
 * Recomputes fields of a locked record from their eligible assertions alone
 * (rule 2.4): the winner becomes `active`, the rest `superseded`, and the
 * derived data follows. Used after assertions stop counting, e.g. when their
 * source is retracted.
 *
 * An older value can no longer be restored when another record has since
 * claimed it (1.2). Rather than fail, so that a retraction always takes
 * effect, that candidate waits for review (`unique_conflict`) and the next
 * one wins; accepting it later fails until the claim is released. With
 * `onUniqueConflict: 'refuse'`, the claim fails the write instead
 * (`UniqueConflictError`), for callers that must not lose a value that way.
 */
export async function recomputeFields(
  tx: Tx,
  context: WriteContext,
  object: CompiledObject,
  record: LockedRecord,
  fieldIds: readonly string[],
  { onUniqueConflict = 'review' }: { onUniqueConflict?: 'review' | 'refuse' } = {},
): Promise<void> {
  const fields = fieldIds
    .map((id) => object.fieldsById.get(id))
    .filter((f): f is FieldState => f !== undefined);
  if (fields.length === 0) return;
  const rows = await tx<AssertionRow[]>`
    select id, field_id, value, actor, status, observed_at, created_at from field_assertions
    where record_id = ${record.id} and field_id = any(${fields.map((f) => f.id as string)}::uuid[])
      and status in ('active', 'superseded')`;
  const winners = new Map<FieldState, AssertionRow | undefined>();
  const claimed = new Set<FieldState>();
  for (const field of fields) {
    const ranked = rows
      .filter((r) => r.field_id === field.id)
      .sort((a, b) => compareAssertions(toRanked(a), toRanked(b)));
    let winner: AssertionRow | undefined = ranked[0];
    if (field.isUnique) {
      // The claim attempt itself is the test, so a claim another transaction
      // has made but not yet committed is waited for, not missed.
      winner = undefined;
      for (const candidate of ranked) {
        const holder = await claimIdentifiers(
          tx,
          context.workspaceId,
          record.id,
          field,
          candidate.value,
        );
        if (!holder) {
          winner = candidate;
          break;
        }
        if (onUniqueConflict === 'refuse') {
          throw new UniqueConflictError(field, holder.value, holder.recordId);
        }
        await tx`update field_assertions set status = 'pending_review',
            review_reason = 'unique_conflict'
          where id = ${candidate.id}`;
      }
      if (!winner) await claimIdentifiers(tx, context.workspaceId, record.id, field, null);
      claimed.add(field);
    }
    const winnerId = winner?.id;
    if (winnerId) {
      await tx`update field_assertions set status = 'active'
        where id = ${winnerId} and status <> 'active'`;
    }
    await tx`update field_assertions set status = 'superseded'
      where record_id = ${record.id} and field_id = ${field.id as string}
        and status = 'active' and id is distinct from ${winnerId ?? null}::uuid`;
    winners.set(field, winner);
  }
  await applyWinners(tx, context, object, record, winners, claimed);
}

/** Locks records `FOR UPDATE` in sorted ID order (rule 2.5), for merges, retraction and `forget`. */
export async function lockRecordsForUpdate(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
): Promise<LockedRecord[]> {
  if (ids.length === 0) return [];
  return tx<LockedRecord[]>`
    select id, object_type_id, data, updated_at, deleted_at, merged_into_id from records
    where workspace_id = ${workspaceId} and id = any(${[...ids].sort()}::uuid[])
    order by id for update`;
}

/** An assertion that stopped counting, with the status it had. */
export type RemovedClaim = { record_id: string; field_id: string; status: string };

/**
 * After assertions stop counting (retracted or deleted), recomputes the
 * fields where one of them was winning, on the given locked records. Every
 * identifier those winners held is released first, across all records, so
 * a claim from one record cannot block another's previous value from
 * coming back. Returns the IDs of the records recomputed.
 */
export async function releaseAndRecompute(
  tx: Tx,
  context: WriteContext,
  locked: readonly LockedRecord[],
  removed: readonly RemovedClaim[],
): Promise<string[]> {
  const winners = removed.filter((c) => c.status === 'active');
  if (winners.length > 0) {
    await tx`
      delete from record_identifiers ri
      using unnest(${winners.map((c) => c.record_id)}::uuid[],
        ${winners.map((c) => c.field_id)}::uuid[]) as r(record_id, field_id)
      where ri.workspace_id = ${context.workspaceId}
        and ri.record_id = r.record_id and ri.field_id = r.field_id`;
  }
  const recomputed: string[] = [];
  for (const record of locked) {
    const fieldIds = [
      ...new Set(winners.filter((c) => c.record_id === record.id).map((c) => c.field_id)),
    ];
    const object = context.schema.objectsById.get(record.object_type_id);
    if (fieldIds.length === 0 || !object) continue;
    await recomputeFields(tx, context, object, record, fieldIds);
    recomputed.push(record.id);
  }
  return recomputed;
}

/**
 * Closes pending merge suggestions that involve records which are no
 * longer live (merged or deleted), so review only ever lists live pairs.
 */
export async function closeSuggestionsFor(
  tx: Tx,
  context: WriteContext,
  recordIds: readonly string[],
): Promise<void> {
  if (recordIds.length === 0) return;
  await tx`
    update merge_suggestions set status = 'dismissed', decided_by = ${tx.json(context.actor)},
      decided_at = clock_timestamp()
    where workspace_id = ${context.workspaceId} and status = 'pending'
      and (record_a_id = any(${recordIds as string[]}::uuid[])
        or record_b_id = any(${recordIds as string[]}::uuid[]))`;
}

/**
 * Replaces a field's identifier rows with those of its new winning value.
 * A claim another record already holds fails the whole write with the
 * holder's ID; ON CONFLICT waits for a concurrent claimer to commit or roll
 * back first, so the loser of a race sees the winner.
 */
async function replaceIdentifiers(
  tx: Tx,
  workspaceId: string,
  recordId: string,
  field: FieldState,
  value: unknown,
): Promise<void> {
  const conflict = await claimIdentifiers(tx, workspaceId, recordId, field, value);
  if (conflict) throw new UniqueConflictError(field, conflict.value, conflict.recordId);
}

/**
 * Replaces a field's identifier rows, returning the first claim another
 * record holds instead of throwing. ON CONFLICT DO NOTHING leaves the
 * transaction usable, and the next call starts by deleting this field's
 * rows, so a caller can try another value.
 */
async function claimIdentifiers(
  tx: Tx,
  workspaceId: string,
  recordId: string,
  field: FieldState,
  value: unknown,
): Promise<{ value: string; recordId: string } | null> {
  const fieldId = field.id as string;
  await tx`delete from record_identifiers where record_id = ${recordId} and field_id = ${fieldId}`;
  for (const identifier of identifiersFor(field, value)) {
    if (!field.isUnique) {
      await tx`
        insert into record_identifiers (workspace_id, record_id, field_id, kind, value, is_claim)
        values (${workspaceId}, ${recordId}, ${fieldId}, ${identifier.kind}, ${identifier.value},
          false)`;
      continue;
    }
    const claimed = await tx`
      insert into record_identifiers (workspace_id, record_id, field_id, kind, value, is_claim)
      values (${workspaceId}, ${recordId}, ${fieldId}, ${identifier.kind}, ${identifier.value}, true)
      on conflict (workspace_id, field_id, value) where is_claim do nothing
      returning id`;
    if (claimed.length === 0) {
      const [holder] = await tx<{ record_id: string }[]>`
        select record_id from record_identifiers
        where workspace_id = ${workspaceId} and field_id = ${fieldId}
          and value = ${identifier.value} and is_claim`;
      return { value: identifier.value, recordId: holder?.record_id ?? 'unknown' };
    }
  }
  return null;
}

/** Inserts an empty record row; the caller writes its values with `writeFields`. */
export async function insertRecord(
  tx: Tx,
  context: WriteContext,
  object: CompiledObject,
  /** The person an internal note of personal memory is private to (personal memory 4.5). */
  privateTo: string | null = null,
): Promise<LockedRecord> {
  const [row] = await tx<LockedRecord[]>`
    insert into records (workspace_id, object_type_id, created_by, updated_by, private_to_user)
    values (${context.workspaceId}, ${object.id}, ${tx.json(context.actor)},
      ${tx.json(context.actor)}, ${privateTo})
    returning id, object_type_id, data, updated_at, deleted_at, merged_into_id`;
  return row as LockedRecord;
}

/**
 * Recomputes a record's values from its assertions alone (rule 2.4). Used
 * to prove `records.data` is a cache, and to rebuild it.
 */
export async function computeDataFromAssertions(
  tx: Tx,
  object: CompiledObject,
  recordId: string,
): Promise<Record<string, unknown>> {
  const rows = await tx<AssertionRow[]>`
    select id, field_id, value, actor, status, observed_at, created_at from field_assertions
    where record_id = ${recordId} and status in ('active', 'superseded')`;
  const data: Record<string, unknown> = {};
  for (const field of object.state.fields) {
    if (field.type === 'relation') continue;
    const winner = pickWinner(rows.filter((r) => r.field_id === field.id).map(toRanked));
    if (winner) data[field.key] = winner.value;
  }
  return data;
}

/**
 * The record and every live record that deleting it reaches through
 * `onDelete: cascade` relations, at any depth: what `softDeleteRecord`
 * deletes, and what the delete dialog warns about beforehand.
 */
export async function cascadeSet(
  tx: Tx,
  schema: CompiledSchema,
  roots: readonly string[],
): Promise<Set<string>> {
  const cascadeFieldIds = schema.state.objects.flatMap((o) =>
    o.fields
      .filter((f) => f.status === 'active' && f.settings.onDelete === 'cascade')
      .map((f) => f.id as string),
  );
  const ids = new Set(roots);
  let frontier = [...ids];
  while (frontier.length > 0 && cascadeFieldIds.length > 0) {
    const rows = await tx<{ id: string }[]>`
      select distinct l.source_record_id as id from record_links l
      join records r on r.id = l.source_record_id and r.deleted_at is null
      where l.target_record_id = any(${frontier}::uuid[])
        and l.field_id = any(${cascadeFieldIds}::uuid[])`;
    frontier = rows.map((r) => r.id).filter((rid) => !ids.has(rid));
    for (const rid of frontier) ids.add(rid);
  }
  return ids;
}

/**
 * Soft-deletes a record (2.1). Relations to it with `onDelete: cascade`
 * soft-delete their source records too; `set_null` relations simply stop
 * resolving, since reads skip deleted targets. All affected records are
 * locked in sorted ID order (rule 2.5). Uniqueness claims stay, so writes
 * cannot silently recreate the record. Returns the IDs deleted; the events
 * among them are retracted by the caller (`deleteRecords`).
 */
export async function softDeleteRecord(
  tx: Tx,
  context: WriteContext,
  id: string,
): Promise<string[]> {
  const rootId = await resolveRecordId(tx, context.workspaceId, id);
  // Collect first, then lock everything in sorted order.
  const sorted = [...(await cascadeSet(tx, context.schema, [rootId]))].sort();
  const locked = await lockRecordsForUpdate(tx, context.workspaceId, sorted);
  const root = locked.find((r) => r.id === rootId);
  if (root) objectOf(context.schema, root);
  if (root?.deleted_at) {
    throw new AppError(409, 'record_deleted', `record ${rootId} is already deleted`, {
      recordId: rootId,
    });
  }
  return markDeleted(tx, context, sorted);
}

/** Sets `deleted_at` on locked records, returning those it deleted now. */
export async function markDeleted(
  tx: Tx,
  context: WriteContext,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const deleted = await tx<{ id: string }[]>`
    update records set deleted_at = clock_timestamp(), updated_at = clock_timestamp(),
      updated_by = ${tx.json(context.actor)}
    where id = any(${[...ids]}::uuid[]) and deleted_at is null
    returning id`;
  const sorted = deleted.map((r) => r.id).sort();
  await closeSuggestionsFor(tx, context, sorted);
  return sorted;
}
