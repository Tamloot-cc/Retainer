import type { Actor } from '@retainer/shared';
import type { AssertionStatus } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound, requireUser } from '../errors.js';
import { lockSource } from '../memory/events.js';
import { getRecord, type PresentedRecord } from './read.js';
import { normalizeFieldValue } from './values.js';
import {
  type FieldWriteStatus,
  lockRecord,
  objectOf,
  type WriteContext,
  writeFields,
} from './write.js';

type PendingRow = {
  id: string;
  record_id: string;
  field_id: string;
  value: unknown;
  status: AssertionStatus;
  source_record_id: string | null;
  observed_at: Date;
};

async function loadPending(
  tx: Tx,
  workspaceId: string,
  assertionId: string,
  lock = false,
): Promise<PendingRow> {
  const [row] = await tx<PendingRow[]>`
    select id, record_id, field_id, value, status, source_record_id, observed_at
    from field_assertions
    where id = ${assertionId} and workspace_id = ${workspaceId}
    ${lock ? tx`for update` : tx``}`;
  if (!row) throw notFound('assertion', { id: assertionId });
  return row;
}

const requireReviewer = (actor: Actor) => requireUser(actor, 'decide pending assertions');

export type DecisionResult = {
  assertionId: string;
  status: 'accepted' | 'rejected';
  /** For an acceptance: what happened to the re-asserted value. */
  fields?: Record<string, FieldWriteStatus>;
  record: PresentedRecord;
};

/**
 * Accepts a pending assertion (rule 2.3): the value is re-asserted with the
 * reviewing user as actor, keeping its source event and `observed_at`,
 * and goes through the normal write path, so a value a person set later
 * still stands. The original is kept, marked superseded. The source is
 * locked before the record, the order deletion uses.
 */
export async function acceptAssertion(
  tx: Tx,
  context: WriteContext,
  assertionId: string,
): Promise<DecisionResult> {
  requireReviewer(context.actor);
  const first = await loadPending(tx, context.workspaceId, assertionId);
  if (first.status !== 'pending_review') {
    throw new AppError(409, 'not_pending', `assertion is ${first.status}, not pending_review`);
  }
  if (first.source_record_id) {
    await lockSource(tx, context, first.source_record_id);
  }
  const record = await lockRecord(tx, context.workspaceId, first.record_id);
  // Lock the assertion after its record: rejection locks this row too.
  // Without this lock, rejection could commit between our read and final update.
  const pending = await loadPending(tx, context.workspaceId, assertionId, true);
  if (pending.status !== 'pending_review') {
    throw new AppError(409, 'not_pending', `assertion is ${pending.status}, not pending_review`);
  }
  if (record.id !== pending.record_id) {
    throw new AppError(409, 'record_merged', 'the record was merged; review it again');
  }
  const object = objectOf(context.schema, record);
  const field = object.fieldsById.get(pending.field_id);
  if (field?.status !== 'active') {
    throw new AppError(409, 'field_deleted', 'the field of this assertion was deleted');
  }

  let value: unknown = null;
  if (pending.value !== null) {
    try {
      value = normalizeFieldValue(field, pending.value);
    } catch (error) {
      throw new AppError(
        422,
        'invalid_values',
        `the pending value no longer fits ${field.name}: ${(error as Error).message}`,
      );
    }
  }

  const fields = await writeFields(tx, context, object, record, new Map([[field, value]]), {
    sourceRecordId: pending.source_record_id,
    observedAt: pending.observed_at,
  });
  await context.changes?.review(tx, record.id, field.key);
  await tx`
    update field_assertions set status = 'superseded', reviewed_by = ${tx.json(context.actor)},
      reviewed_at = clock_timestamp()
    where id = ${assertionId}`;
  return {
    assertionId,
    status: 'accepted',
    fields,
    record: await getRecord(tx, context.workspaceId, context.schema, record.id),
  };
}

export async function rejectAssertion(
  tx: Tx,
  context: WriteContext,
  assertionId: string,
): Promise<DecisionResult> {
  requireReviewer(context.actor);
  const [row] = await tx<PendingRow[]>`
    select id, record_id, field_id, value, status, source_record_id, observed_at
    from field_assertions
    where id = ${assertionId} and workspace_id = ${context.workspaceId}
    for update`;
  if (!row) throw notFound('assertion', { id: assertionId });
  if (row.status !== 'pending_review') {
    throw new AppError(409, 'not_pending', `assertion is ${row.status}, not pending_review`);
  }
  const object = context.schema.fieldOwners.get(row.field_id),
    field = object?.fieldsById.get(row.field_id);
  if (field) await context.changes?.review(tx, row.record_id, field.key);
  await tx`
    update field_assertions set status = 'rejected', reviewed_by = ${tx.json(context.actor)},
      reviewed_at = clock_timestamp()
    where id = ${assertionId}`;
  return {
    assertionId,
    status: 'rejected',
    record: await getRecord(tx, context.workspaceId, context.schema, row.record_id),
  };
}
