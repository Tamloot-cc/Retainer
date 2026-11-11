import type {
  AggregateResult,
  BulkDeleteImpact,
  DeleteImpact,
  DeleteRecordResult,
  EventPage,
  ForgetResult,
  MergeResult,
  MergeSuggestionDecision,
  RecordPage,
} from '@retainer/shared';
import { isoDateTimeSchema } from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { WorkspaceSettings } from '../db/schema.js';
import {
  inWorkspace,
  lockForWrite,
  lockPrivacyShared,
  lockSchemaShared,
  type Tx,
  type WriteLocks,
} from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { admitRun } from '../extension-runtime/admission.js';
import { claimIdempotencyKey, requestHash, storeIdempotentResult } from '../idempotency.js';
import { lockSource, retractEventClaims } from '../memory/events.js';
import { lockPerson } from '../memory/profiles.js';
import { forgetRecord } from '../privacy/forget.js';
import {
  type CompiledObject,
  type CompiledSchema,
  getSchema,
  objectNamed,
} from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';
import { type AggregateInput, aggregateRecords } from './aggregate.js';
import { identifiersFor, lookupValue } from './derive.js';
import { dismissMergeSuggestion, type MergeInput, MergeRaceError, mergeRecords } from './merge.js';
import { EVENT_QUERY_OBJECT, type QueryInput, queryEvents, queryRecords } from './query.js';
import { getRecord, type PresentedRecord } from './read.js';
import { acceptAssertion, type DecisionResult, rejectAssertion } from './review.js';
import { normalizeFieldValue, prepareValues } from './values.js';
import {
  cascadeSet,
  type FieldWriteStatus,
  insertRecord,
  lockRecord,
  MAX_MERGE_HOPS,
  markDeleted,
  objectOf,
  resolveRecordId,
  softDeleteRecord,
  UniqueConflictError,
  type WriteContext,
  type WriteOptions,
  writeFields,
} from './write.js';

/** Who is calling, from their API key. */
export type WriteResponse = {
  id: string;
  created: boolean;
  /** Per written field: `applied`, `pending_review` or `superseded` (6.2). */
  fields: Record<string, FieldWriteStatus>;
  record: PresentedRecord;
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

/** Postgres aborted the transaction to break a deadlock; nothing it did was kept. */
const isDeadlock = (error: unknown) => (error as { code?: string }).code === '40P01';
const DEADLOCK_RETRIES = 3;

/**
 * A record write: one short workspace transaction holding the schema lock
 * in shared mode, so the schema it validated against stays current (3),
 * and the privacy lock, so it serializes with `forget` (2.1). Only
 * `forget` takes the privacy lock exclusively, and only moving events
 * between types takes the schema lock exclusively (1.3).
 *
 * A relation write locks its source record, then its target `FOR KEY
 * SHARE`; merges and cascading deletes lock targets before sources. The two
 * orders can deadlock, and Postgres then aborts one transaction. It is
 * rolled back whole, so it is run again from the start.
 */
export type TransactionOptions = {
  /**
   * Whether the transaction sees the caller's personal memory (personal
   * memory spec 4.2). `forget` runs without it, so nothing private reaches
   * the requester; the erasure function cleans up private rows instead.
   */
  asPerson?: boolean;
};

export async function withWrite<T>(
  sql: Sql,
  caller: Caller,
  fn: (tx: Tx, context: WriteContext) => Promise<T>,
  locks: WriteLocks = {},
  { asPerson = true }: TransactionOptions = {},
): Promise<T> {
  const person = !caller.run && asPerson ? caller.person : undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await inWorkspace(
        sql,
        caller.workspaceId,
        async (tx) => {
          await lockForWrite(tx, caller.workspaceId, locks);
          if (caller.run) await admitRun(tx, caller.workspaceId, caller.run, true);
          const schema = await getSchema(tx, caller.workspaceId);
          const [workspace] = await tx<{ settings: WorkspaceSettings }[]>`
            select settings from workspaces where id = ${caller.workspaceId}`;
          return fn(tx, {
            workspaceId: caller.workspaceId,
            actor: caller.actor,
            ...(caller.run ? { run: caller.run } : {}),
            schema,
            confidenceThreshold:
              workspace?.settings.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
            person,
          });
        },
        person?.id,
      );
    } catch (error) {
      if (isDeadlock(error) && attempt < DEADLOCK_RETRIES) continue;
      throw error;
    }
  }
}

/** A read as the caller: their personal memory is visible to them alone (4.2). */
export async function withRead<T>(
  sql: Sql,
  caller: Caller,
  fn: (tx: Tx, schema: CompiledSchema) => Promise<T>,
  options: { privacy?: boolean } = {},
): Promise<T> {
  const { workspaceId } = caller;
  const person = caller.run ? undefined : caller.person;
  return inWorkspace(
    sql,
    workspaceId,
    async (tx) => {
      if (options.privacy) await lockPrivacyShared(tx, workspaceId);
      // A read with a person can see their personal memory on any path
      // (search, an event's citations), so it holds their membership lock
      // and re-checks access first: a removal either committed before, and
      // the read is refused, or waits for it (personal memory spec 4.3).
      if (caller.run) {
        await lockSchemaShared(tx, workspaceId);
        await admitRun(tx, workspaceId, caller.run);
      }
      if (person) await lockPerson(tx, { workspaceId, person });
      return fn(tx, await getSchema(tx, workspaceId));
    },
    person?.id,
  );
}

/**
 * An object by singular or plural API name. The hidden internal-note type
 * (6.4) is not in `objectsByName`, so every route that names an object
 * resolves it as not found.
 */
export function requireObject(schema: CompiledSchema, name: string): CompiledObject {
  const object = objectNamed(schema, name);
  if (!object) {
    throw notFound(`object "${name}"`, { objects: [...schema.objectsByName.keys()] });
  }
  return object;
}

/** Only logging creates events (6.2): record writes may edit one, never create one. */
function refuseEventCreation(object: CompiledObject): void {
  if (!object.isEvent) return;
  throw new AppError(
    422,
    'use_log_event',
    `${object.name} is an event type: create its records with log_event (POST /v1/events), ` +
      'which records when it happened, its source and who took part. upsert_record can edit ' +
      'an event that exists',
    { object: object.name },
  );
}

export const valuesSchema = z.record(z.string(), z.unknown());

/** The event a write cites (rule 2.1); its `occurred_at` becomes `observed_at`. */
export const sourceSchema = z.uuid();

/**
 * Write options for a cited source (rules 2.1, 2.2): the event must be live
 * in this workspace, and its `occurred_at` is the claim's `observed_at`. It
 * is locked before any record, the order deletion uses.
 */
async function citeSource(tx: Tx, context: WriteContext, source?: string): Promise<WriteOptions> {
  if (source === undefined) return {};
  const cited = await lockSource(tx, context, source);
  return { sourceRecordId: cited.id, observedAt: cited.occurredAt };
}

export type CreateOptions = {
  /** Retrying with the same key returns the first result (6.2). */
  idempotencyKey?: string;
  /** The event the values come from. */
  source?: string;
};

export async function createRecord(
  sql: Sql,
  caller: Caller,
  objectName: string,
  values: Record<string, unknown>,
  options: CreateOptions = {},
): Promise<WriteResponse> {
  const { idempotencyKey, source } = options;
  return withWrite(sql, caller, async (tx, context) => {
    const object = requireObject(context.schema, objectName);
    refuseEventCreation(object);
    let claimId: string | undefined;
    if (idempotencyKey !== undefined) {
      const claim = await claimIdempotencyKey(
        tx,
        context,
        'create_record',
        idempotencyKey,
        requestHash({ object: object.name, values, source: source ?? null }),
      );
      if (claim.kind === 'replay') return claim.result as WriteResponse;
      claimId = claim.id;
    }
    const cited = await citeSource(tx, context, source);
    const writes = prepareValues(object, values, 'create');
    const record = await insertRecord(tx, context, object);
    const fields = await writeFields(tx, context, object, record, writes, cited);
    const response: WriteResponse = {
      id: record.id,
      created: true,
      fields,
      record: await getRecord(tx, caller.workspaceId, context.schema, record.id),
    };
    if (claimId) await storeIdempotentResult(tx, claimId, response);
    return response;
  });
}

export const upsertInputSchema = z.strictObject({
  id: z.uuid().optional(),
  match: z.record(z.string(), z.unknown()).optional(),
  values: valuesSchema.default({}),
  ifMissing: z.enum(['fail', 'create']).default('fail'),
  expectedUpdatedAt: isoDateTimeSchema.optional(),
  source: sourceSchema.optional(),
});
export type UpsertInput = z.infer<typeof upsertInputSchema>;

const SEARCH_HINT = 'find the record with search or query_records, then update it by id';

/** Resolves `match` to its unique field, or explains why it cannot match (6.2). */
function matchField(object: CompiledObject, match: Record<string, unknown>) {
  const entries = Object.entries(match);
  const uniqueNames = object.activeFields.filter((f) => f.isUnique).map((f) => f.name);
  if (entries.length !== 1) {
    throw new AppError(422, 'invalid_match', 'match takes exactly one unique field and value', {
      allowed: uniqueNames,
    });
  }
  const [[name, value]] = entries as [[string, unknown]];
  const field = object.fieldsByName.get(name);
  if (!field) {
    throw new AppError(422, 'invalid_match', `unknown field "${name}" on ${object.name}`, {
      field: name,
      allowed: uniqueNames,
    });
  }
  if (!field.isUnique) {
    const why =
      field.type === 'phones'
        ? 'phones are not unique: numbers are shared and reassigned'
        : `${name} is not unique, so it cannot select one record`;
    throw new AppError(422, 'invalid_match', `${why}; ${SEARCH_HINT}`, {
      field: name,
      allowed: uniqueNames,
    });
  }
  const lookup = lookupValue(field, value);
  if (lookup === null) {
    throw new AppError(422, 'invalid_match', `match.${name} needs a non-empty value`, {
      field: name,
    });
  }
  return { field, value, lookup };
}

/** With `ifMissing: "create"`, the match value is written to the new record. */
function valuesWithMatch(
  field: FieldState,
  matchValue: unknown,
  lookup: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const given = values[field.name];
  if (given === undefined) return { ...values, [field.name]: matchValue };
  let identifiers: string[];
  try {
    identifiers = identifiersFor(field, normalizeFieldValue(field, given)).map((i) => i.value);
  } catch {
    return values; // prepareValues reports the invalid value
  }
  if (!identifiers.includes(lookup)) {
    throw new AppError(422, 'invalid_match', `values.${field.name} must include the match value`, {
      field: field.name,
    });
  }
  return values;
}

/**
 * Updates the record found by `id` or `match`, or creates one (6.2). With
 * `ifMissing: "fail"` (the default) a miss is an error, so "update Dana's
 * address" never creates a person by accident. A create that loses a race
 * on the match value rolls back entirely and retries the lookup, so
 * concurrent upserts of one email end on one record.
 */
export async function upsertRecord(
  sql: Sql,
  caller: Caller,
  objectName: string,
  input: UpsertInput,
): Promise<WriteResponse> {
  if (input.id && input.match) {
    throw new AppError(400, 'invalid_request', 'pass id or match, not both');
  }
  for (let attempt = 0; ; attempt++) {
    let creatingWith: FieldState | undefined;
    try {
      return await withWrite(sql, caller, async (tx, context) => {
        const object = requireObject(context.schema, objectName);
        const cited = await citeSource(tx, context, input.source);
        let targetId: string | null = null;
        let match: ReturnType<typeof matchField> | undefined;

        if (input.id) {
          targetId = await resolveRecordId(tx, caller.workspaceId, input.id).catch((error) => {
            if (error instanceof AppError && error.status === 404) return null;
            throw error;
          });
        } else if (input.match) {
          match = matchField(object, input.match);
          const [hit] = await tx<{ record_id: string }[]>`
            select record_id from record_identifiers
            where workspace_id = ${caller.workspaceId} and field_id = ${match.field.id as string}
              and value = ${match.lookup} and is_claim`;
          targetId = hit ? await resolveRecordId(tx, caller.workspaceId, hit.record_id) : null;
        }

        if (targetId) {
          const record = await lockRecord(tx, caller.workspaceId, targetId);
          if (record.object_type_id !== object.id) {
            throw new AppError(422, 'wrong_object', `record ${record.id} is not a ${object.name}`, {
              object: objectOf(context.schema, record).name,
            });
          }
          const writes = prepareValues(object, input.values, 'update');
          const fields = await writeFields(tx, context, object, record, writes, {
            ...cited,
            ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
          });
          return {
            id: record.id,
            created: false,
            fields,
            record: await getRecord(tx, caller.workspaceId, context.schema, record.id),
          };
        }

        if ((input.id || input.match) && input.ifMissing === 'fail') {
          const what = input.id
            ? `record ${input.id}`
            : `${object.name} with ${match?.field.name} ${match?.lookup}`;
          throw new AppError(404, 'not_found', `no ${what}; pass ifMissing: "create" to create it`);
        }

        refuseEventCreation(object);
        const values = match
          ? valuesWithMatch(match.field, match.value, match.lookup, input.values)
          : input.values;
        const writes = prepareValues(object, values, 'create');
        creatingWith = match?.field;
        const record = await insertRecord(tx, context, object);
        const fields = await writeFields(tx, context, object, record, writes, cited);
        return {
          id: record.id,
          created: true,
          fields,
          record: await getRecord(tx, caller.workspaceId, context.schema, record.id),
        };
      });
    } catch (error) {
      const lostRace =
        error instanceof UniqueConflictError && creatingWith && error.field.id === creatingWith.id;
      if (lostRace && attempt < 3) continue;
      throw error;
    }
  }
}

export const patchInputSchema = z.strictObject({
  values: valuesSchema,
  expectedUpdatedAt: isoDateTimeSchema.optional(),
  source: sourceSchema.optional(),
});

export async function patchRecord(
  sql: Sql,
  caller: Caller,
  id: string,
  input: z.infer<typeof patchInputSchema>,
): Promise<WriteResponse> {
  return withWrite(sql, caller, async (tx, context) => {
    const cited = await citeSource(tx, context, input.source);
    const record = await lockRecord(tx, caller.workspaceId, id);
    const object = objectOf(context.schema, record);
    const writes = prepareValues(object, input.values, 'update');
    const fields = await writeFields(tx, context, object, record, writes, {
      ...cited,
      ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
    });
    return {
      id: record.id,
      created: false,
      fields,
      record: await getRecord(tx, caller.workspaceId, context.schema, record.id),
    };
  });
}

/** Records outside `roots` that deleting them would take along, counted by object. */
async function cascadeCounts(
  tx: Tx,
  schema: CompiledSchema,
  roots: string[],
): Promise<DeleteImpact['records']> {
  const ids = await cascadeSet(tx, schema, roots);
  for (const id of roots) ids.delete(id);
  const rows = ids.size
    ? await tx<{ object_type_id: string; count: number }[]>`
        select object_type_id, count(*)::int as count from records
        where id = any(${[...ids]}::uuid[]) group by object_type_id`
    : [];
  return rows
    .map((r) => ({
      object: schema.objectsById.get(r.object_type_id)?.name ?? 'unknown',
      count: r.count,
    }))
    .sort((a, b) => a.object.localeCompare(b.object));
}

/**
 * What deleting a record would delete with it through cascading relations,
 * counted by object, at any depth and without changing anything.
 */
export async function deleteImpact(sql: Sql, caller: Caller, id: string): Promise<DeleteImpact> {
  return withRead(sql, caller, async (tx, schema) => {
    const record = await getRecord(tx, caller.workspaceId, schema, id);
    return { id: record.id, records: await cascadeCounts(tx, schema, [record.id]) };
  });
}

export const bulkDeleteImpactSchema = z.strictObject({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
/** The same for several records deleted together: overlaps count once. */
export async function bulkDeleteImpact(
  sql: Sql,
  caller: Caller,
  input: z.infer<typeof bulkDeleteImpactSchema>,
): Promise<BulkDeleteImpact> {
  return withRead(sql, caller, async (tx, schema) => {
    // Each ID follows its merges to the live record, all in one query.
    const rows = await tx<{ start: string; id: string; deleted_at: Date | null }[]>`
      with recursive chain (start, id, merged_into_id, deleted_at, hops) as (
        select id, id, merged_into_id, deleted_at, 0 from records
        where id = any(${input.ids}::uuid[]) and workspace_id = ${caller.workspaceId}
        union all
        select c.start, r.id, r.merged_into_id, r.deleted_at, c.hops + 1
        from chain c join records r on r.id = c.merged_into_id
        where r.workspace_id = ${caller.workspaceId} and c.hops < ${MAX_MERGE_HOPS})
      select start, id, deleted_at from chain where merged_into_id is null`;
    const byStart = new Map(rows.map((r) => [r.start, r]));
    const roots = new Set<string>();
    for (const id of input.ids) {
      const row = byStart.get(id);
      if (!row) throw notFound('record', { id });
      if (row.deleted_at)
        throw new AppError(404, 'record_deleted', `record ${row.id} was deleted`, {
          recordId: row.id,
        });
      roots.add(row.id);
    }
    return { ids: [...roots], records: await cascadeCounts(tx, schema, [...roots]) };
  });
}

/** Totals over the records a filter matches, for a list's footer. */
export async function aggregate(
  sql: Sql,
  caller: Caller,
  objectName: string,
  input: AggregateInput,
): Promise<AggregateResult> {
  return withRead(sql, caller, (tx, schema) =>
    aggregateRecords(tx, caller.workspaceId, schema, requireObject(schema, objectName), input),
  );
}

/**
 * Soft-deletes a record and what cascades from it (2.1). Every event among
 * them goes through the deletion lifecycle (6.4): what cites it is
 * retracted and recomputed, and the response counts how far that reached.
 */
export async function deleteRecord(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<DeleteRecordResult> {
  return withWrite(sql, caller, async (tx, context) => {
    const deletedRecordIds = await softDeleteRecord(tx, context, id);
    const events = await eventsAmong(tx, context.schema, deletedRecordIds);
    // Deleting an event retracts what cites it, and says how much (6.4).
    const retraction = events.length > 0 ? await retractEventClaims(tx, context, events) : {};
    return {
      id: await resolveRecordId(tx, caller.workspaceId, id),
      deleted: true,
      deletedRecordIds,
      ...retraction,
    };
  });
}

/** The event records among `ids`. */
export async function eventsAmong(
  tx: Tx,
  schema: CompiledSchema,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx<{ id: string; object_type_id: string }[]>`
    select id, object_type_id from records where id = any(${[...ids]}::uuid[])`;
  return rows
    .filter((r) => schema.objectsById.get(r.object_type_id)?.isEvent)
    .map((r) => r.id)
    .sort();
}

/**
 * Deleting an event type (6.4): every live record of it is deleted through
 * the same lifecycle as deleting one event, in the schema change's own
 * transaction, so no claim keeps citing an event of a deleted type.
 */
export async function deleteEventsOfType(
  tx: Tx,
  context: WriteContext,
  objectTypeId: string,
): Promise<void> {
  const rows = await tx<{ id: string }[]>`
    select id from records
    where workspace_id = ${context.workspaceId} and object_type_id = ${objectTypeId}
      and deleted_at is null
    order by id for update`;
  const deleted = await markDeleted(
    tx,
    context,
    rows.map((r) => r.id),
  );
  await retractEventClaims(tx, context, deleted);
}

export async function readRecord(sql: Sql, caller: Caller, id: string): Promise<PresentedRecord> {
  return withRead(sql, caller, (tx, schema) => getRecord(tx, caller.workspaceId, schema, id));
}

/**
 * Records of one object. The reserved name `event` (or `events`) queries
 * events of every event type at once (7.1).
 */
export async function findRecords(
  sql: Sql,
  caller: Caller,
  objectName: string,
  input: QueryInput,
): Promise<RecordPage | EventPage> {
  if (objectName === EVENT_QUERY_OBJECT || objectName === `${EVENT_QUERY_OBJECT}s`) {
    return findEvents(sql, caller, input);
  }
  return withRead(sql, caller, (tx, schema) =>
    queryRecords(tx, caller.workspaceId, schema, requireObject(schema, objectName), input),
  );
}

/** Events of every visible event type, newest first by default (7.1). */
export async function findEvents(sql: Sql, caller: Caller, input: QueryInput): Promise<EventPage> {
  return withRead(sql, caller, (tx, schema) => queryEvents(tx, caller.workspaceId, schema, input));
}

export async function decideAssertion(
  sql: Sql,
  caller: Caller,
  assertionId: string,
  decision: 'accept' | 'reject',
): Promise<DecisionResult> {
  return withWrite(sql, caller, (tx, context) =>
    decision === 'accept'
      ? acceptAssertion(tx, context, assertionId)
      : rejectAssertion(tx, context, assertionId),
  );
}

/**
 * Merges `input.recordId` into record `id` (4.2). A merge whose records
 * changed between resolving and locking is retried in a new transaction
 * (deadlocks are retried by `withWrite`). With an idempotency
 * key, a retry returns the first result; without one, merging again is a
 * no-op by state.
 */
export async function mergeRecord(
  sql: Sql,
  caller: Caller,
  id: string,
  input: MergeInput,
  idempotencyKey?: string,
): Promise<MergeResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withWrite(sql, caller, async (tx, context) => {
        let claimId: string | undefined;
        if (idempotencyKey !== undefined) {
          const claim = await claimIdempotencyKey(
            tx,
            context,
            'merge',
            idempotencyKey,
            requestHash({ id, recordId: input.recordId, values: input.values ?? null }),
          );
          if (claim.kind === 'replay') return claim.result as MergeResult;
          claimId = claim.id;
        }
        const result = await mergeRecords(tx, context, id, input);
        if (claimId) await storeIdempotentResult(tx, claimId, result);
        return result;
      });
    } catch (error) {
      if (!(error instanceof MergeRaceError)) throw error;
      if (attempt < 3) continue;
      throw new AppError(409, 'merge_conflict', 'the records changed during the merge; retry');
    }
  }
}

export async function dismissSuggestion(
  sql: Sql,
  caller: Caller,
  id: string,
): Promise<MergeSuggestionDecision> {
  return withWrite(sql, caller, (tx, context) => dismissMergeSuggestion(tx, context, id));
}

/**
 * `forget` (2.1). It holds the privacy lock exclusively, so it waits for
 * in-flight writes in the workspace and blocks new ones until it commits.
 * It runs without the requester's personal memory (personal memory spec
 * 4.6): private derivatives of what it erases, the requester's own
 * included, go through the erasure function, so nothing private is counted
 * or returned.
 */
export async function forget(sql: Sql, caller: Caller, id: string): Promise<ForgetResult> {
  return withWrite(
    sql,
    caller,
    (tx, context) => forgetRecord(tx, context, id),
    { privacy: 'exclusive' },
    { asPerson: false },
  );
}
