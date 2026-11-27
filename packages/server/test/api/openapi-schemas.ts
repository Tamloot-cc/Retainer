import { writeFileSync } from 'node:fs';
import { EVENT_QUERY_COLUMNS } from '@retainer/shared';
import { z } from 'zod';
import { fileErasureStatusInput } from '../../src/api/routes/files.js';
import { createRecordInput, mergeSuggestionInput } from '../../src/api/routes/records.js';
import { commentInputSchema } from '../../src/comments/service.js';
import { createDashboardSchema, updateDashboardSchema } from '../../src/dashboards/service.js';
import { fileIntentSchema } from '../../src/files/service.js';
import { upsertRecordInput, upsertRecordsInput } from '../../src/http/record-upserts.js';
import { deleteBindingsInput } from '../../src/http/request.js';
import { addLinksInputSchema } from '../../src/memory/event-links.js';
import { logEventInputSchema } from '../../src/memory/events.js';
import { rememberInputSchema } from '../../src/memory/facts.js';
import { moveEventsInputSchema } from '../../src/memory/move.js';
import { aggregateInputSchema } from '../../src/records/aggregate.js';
import { mergeInputSchema } from '../../src/records/merge.js';
import { queryInputSchema } from '../../src/records/query.js';
import {
  bulkDeleteImpactSchema,
  patchInputSchema,
  upsertInputSchema,
} from '../../src/records/service.js';
import { searchInputSchema } from '../../src/retrieval/search.js';
import { schemaChangeRequestSchema } from '../../src/schema-engine/service.js';
import { createViewSchema, updateViewSchema } from '../../src/views/service.js';
import { buildResponseSchemas } from './openapi-responses.js';

function jsonSchema(validator: z.ZodType) {
  const { $schema: _, ...schema } = z.toJSONSchema(validator, { io: 'input' });
  return schema;
}

const querySort = queryInputSchema.shape.sort.unwrap();
const eventQueryInput = queryInputSchema.extend({
  filter: queryInputSchema.shape.filter.describe(
    'Filter by a shared event column or by type. The type filter supports eq, neq, and in.',
  ),
  sort: querySort
    .meta({ items: jsonSchema(querySort.element.extend({ field: z.enum(EVENT_QUERY_COLUMNS) })) })
    .optional(),
});

// These service-level rules are not expressible by converting the base Zod shapes alone.
const exclusiveTarget = { required: ['id', 'match'] };
const uniqueMatch = upsertInputSchema.shape.match
  .unwrap()
  .meta({ minProperties: 1, maxProperties: 1, description: 'Match one unique field.' })
  .optional();
const batchRecordInput = upsertRecordInput.extend({ match: uniqueMatch }).meta({
  not: {
    anyOf: [
      exclusiveTarget,
      { required: ['id', 'idempotencyKey'] },
      { required: ['match', 'idempotencyKey'] },
    ],
  },
});

export const requestValidators = {
  'accept-merge': mergeSuggestionInput,
  'aggregate-records': aggregateInputSchema,
  'create-dashboard': createDashboardSchema,
  'create-comment': commentInputSchema,
  'create-file-intent': fileIntentSchema,
  'create-record': createRecordInput,
  'create-view': createViewSchema,
  'delete-event': deleteBindingsInput,
  'delete-record': deleteBindingsInput,
  'get-bulk-delete-impact': bulkDeleteImpactSchema,
  'get-file-erasure-status': fileErasureStatusInput,
  'link-event': addLinksInputSchema.meta({
    anyOf: [
      { required: ['participants'], properties: { participants: { minItems: 1 } } },
      { required: ['about'], properties: { about: { minItems: 1 } } },
    ],
  }),
  'log-event': logEventInputSchema,
  'merge-record': mergeInputSchema,
  'move-events': moveEventsInputSchema,
  'query-events': eventQueryInput,
  'query-records': queryInputSchema,
  'remember-fact': rememberInputSchema,
  'request-schema-change': schemaChangeRequestSchema,
  search: searchInputSchema,
  'update-dashboard': updateDashboardSchema,
  'update-comment': commentInputSchema,
  'update-record': patchInputSchema,
  'update-view': updateViewSchema,
  'upsert-record': upsertInputSchema.extend({ match: uniqueMatch }).meta({ not: exclusiveTarget }),
  'upsert-records': upsertRecordsInput.extend({
    items: upsertRecordsInput.shape.items.meta({ items: jsonSchema(batchRecordInput) }),
  }),
} satisfies Record<string, z.ZodType>;

export const apiSchemasFile = new URL(
  '../../../../apps/docs/lib/api-schemas.json',
  import.meta.url,
);

export function buildRequestSchemas() {
  return Object.fromEntries(
    Object.entries(requestValidators).map(([operation, validator]) => [
      operation,
      jsonSchema(validator),
    ]),
  );
}

export function buildApiSchemas() {
  return { requests: buildRequestSchemas(), responses: buildResponseSchemas() };
}

if (import.meta.main) {
  writeFileSync(apiSchemasFile, `${JSON.stringify(buildApiSchemas(), null, 2)}\n`);
}
