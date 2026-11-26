import type { UpsertRecordsResponse } from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { invalid } from '../errors.js';
import { createRecord, upsertInputSchema, upsertRecord } from '../records/service.js';
import { objectName, zodError } from './request.js';
import { errorBody, toAppError } from './response.js';

export const upsertRecordInput = z.strictObject({
  object: objectName,
  ...upsertInputSchema.shape,
  id: upsertInputSchema.shape.id.describe('Update this record.'),
  match: upsertInputSchema.shape.match.describe(
    'Find the record by one unique field and its value, e.g. { "emails": "dana@acme.com" }. ' +
      'Names and phones are not unique: find those records with search or query_records first.',
  ),
  values: upsertInputSchema.shape.values.describe(
    "Field name to value, in its type's format from describe_schema's valueFormats. " +
      'Composite fields (emails, phones, links, money, full_name, address) are replaced whole, so include the values to keep. null clears a field. ' +
      'A many_to_many relation takes the whole list of record IDs ([] clears it): read ' +
      'the record first and send every member to keep. Fields marked readOnly are not yours ' +
      'to write: an inverse relation (isInverse) is written from the other side, and any ' +
      'other is written only by the app that added it.',
  ),
  ifMissing: upsertInputSchema.shape.ifMissing.describe(
    'When id or match finds nothing: "fail" (default) or "create". Use "create" only ' +
      'when you mean to add a new record.',
  ),
  expectedUpdatedAt: upsertInputSchema.shape.expectedUpdatedAt.describe(
    'Reject the write if the record changed since this updatedAt.',
  ),
  source: upsertInputSchema.shape.source.describe(
    'The event id (from log_event) these values come from. Values then carry the ' +
      "event's date, so an older email cannot overwrite a newer claim. Omit only for " +
      'values that come from no conversation.',
  ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Only for creates without id or match: retrying with the same key returns the first ' +
        'result instead of creating a second record.',
    ),
});

const MAX_ITEMS = 50;
export const UPSERT_RECORDS_MAX_BYTES = 2 * 1024 * 1024;

// Advertise the single upsert's input shape to tool callers. Parse items
// separately so a malformed item gets its own error without rejecting the batch.
const { $schema: _draft, ...itemSchema } = z.toJSONSchema(upsertRecordInput, {
  io: 'input',
  target: 'draft-7',
});
export const upsertRecordsInput = z.strictObject({
  items: z
    .array(z.unknown().meta(itemSchema))
    .min(1)
    .max(MAX_ITEMS, `pass at most ${MAX_ITEMS} items`),
});

export function writeRecord(
  sql: Sql,
  caller: Caller,
  { object, idempotencyKey, ...input }: z.infer<typeof upsertRecordInput>,
) {
  if (!input.id && !input.match) {
    return createRecord(sql, caller, object, input.values, {
      idempotencyKey,
      source: input.source,
      bindings: input.bindings,
    });
  }
  if (idempotencyKey !== undefined) {
    throw invalid('idempotencyKey applies only to creates without id or match');
  }
  return upsertRecord(sql, caller, object, input);
}

export async function upsertRecords(
  sql: Sql,
  caller: Caller,
  items: unknown[],
): Promise<UpsertRecordsResponse> {
  const results: UpsertRecordsResponse['results'] = [];
  // Each write acquires and releases its own locks, and admits its caller again.
  // Input order also lets a later write see earlier commits.
  for (const item of items) {
    const parsed = upsertRecordInput.safeParse(item);
    if (!parsed.success) {
      results.push(errorBody(zodError(parsed.error)));
      continue;
    }
    try {
      results.push(await writeRecord(sql, caller, parsed.data));
    } catch (error) {
      results.push(errorBody(toAppError(error)));
    }
  }
  return { results };
}
