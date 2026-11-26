import {
  type AddedLinks,
  AGGREGATE_OPS,
  type AssertionView,
  actorSchema,
  CORE_ROLES,
  EVENT_COLUMNS,
  type EventDetails,
  type EventPage,
  type EventRecord,
  FIELD_TYPES,
  type FieldView,
  type LogEventResult,
  type MatchedParticipant,
  type MergeResult,
  OBJECT_CLASSES,
  type ObjectView,
  type Participants,
  type PresentedComment,
  type PresentedFact,
  type PresentedRecord,
  type RecordPage,
  type RecordReference,
  SAVED_VIEW_KINDS,
  SAVED_VIEW_VISIBILITIES,
  type SavedView,
  SCHEMA_OWNERS,
  type SchemaDescription,
  type Session,
  type UnmatchedParticipant,
  type WriteResponse,
} from '@retainer/shared';
import { z } from 'zod';
import { fileMetadataSchema, type SignedTransfer } from '../../src/file-storage/contract.js';
import type { ErrorBody } from '../../src/http/response.js';
import { fieldDefinitionSchema } from '../../src/schema-engine/operations.js';

// Check the shape in both directions. Check keys separately so adding an optional
// field to the API type also requires documenting it here.
type Keys<T> = T extends unknown ? keyof T : never;
function response<T>() {
  return <S extends z.ZodType>(
    schema: S &
      ([z.output<S>] extends [T]
        ? [T] extends [z.output<S>]
          ? [Keys<T>] extends [Keys<z.output<S>>]
            ? [Keys<z.output<S>>] extends [Keys<T>]
              ? unknown
              : never
            : never
          : never
        : never),
  ): S => schema;
}

const text = z.string();
const id = z.uuid();
const timestamp = z.string().meta({ format: 'date-time' });
const values = z.record(text, z.unknown());
const profile = z.enum(['me', 'workspace']);
const factStatus = z.enum(['current', 'retracted', 'superseded', 'ended']);
const workspace = response<Session['workspace']>()(z.object({ id, name: text, slug: text }));
const recordReference = response<RecordReference>()(
  z.object({ id, object: text, label: text.nullable() }),
);
const references = z.record(text, recordReference);
const assertion = response<AssertionView>()(
  z.object({
    id,
    recordId: id,
    object: text,
    recordLabel: text.nullable(),
    field: text,
    value: z.unknown(),
    currentValue: z.unknown(),
    status: z.enum(['active', 'superseded', 'pending_review', 'rejected', 'retracted']),
    reason: z.enum(['outranked', 'low_confidence', 'unique_conflict']).nullable(),
    actor: actorSchema,
    confidence: z.number(),
    sourceRecordId: id.nullable(),
    isInitial: z.boolean(),
    observedAt: timestamp,
    createdAt: timestamp,
    source: z.object({ id, type: text, title: text.nullable(), occurredAt: timestamp }).nullable(),
    conflictingRecord: recordReference.nullable(),
    relationReferences: references.optional(),
    reviewedBy: actorSchema.nullable(),
    reviewedAt: timestamp.nullable(),
  }),
);
const matched = response<MatchedParticipant>()(
  z.object({ id, handle: text.nullable(), role: text.nullable(), recordId: id }),
);
const unmatched = response<UnmatchedParticipant>()(
  z.object({
    id,
    handle: text.nullable(),
    role: text.nullable(),
    reason: z.enum(['no_match', 'phone_only', 'deleted_record', 'ambiguous', 'suppressed']),
    candidates: z.array(id).optional(),
  }),
);
const participants = response<Participants>()(
  z.object({ matched: z.array(matched), unmatched: z.array(unmatched) }),
);
const addedLinks = response<AddedLinks>()(z.object({ participants, about: z.array(id) }));
const eventDetails = response<EventDetails>()(
  z.object({
    occurredAt: timestamp,
    channel: text.nullable(),
    externalId: text.nullable(),
    title: text.nullable(),
    summary: text.nullable(),
    participants,
    about: z.array(id),
    content: z
      .literal(true)
      .optional()
      .describe('Full text is available at GET /v1/events/{id}/content.'),
    source: z
      .object({
        sourceItemId: id,
        revisionId: id,
        current: z.boolean(),
        previousEventId: id.nullable(),
      })
      .optional(),
  }),
);
const record = response<PresentedRecord>()(
  z.object({
    id,
    object: text,
    label: text.nullable(),
    fields: values.describe('Keys are API field names from the workspace schema.'),
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: actorSchema,
    updatedBy: actorSchema,
    provenance: z
      .record(
        text,
        z.object({
          pendingAssertion: assertion.nullable().optional(),
          assertion: assertion.nullable(),
          pendingAssertionIds: z.array(id),
        }),
      )
      .optional(),
    relationReferences: references.optional(),
    counts: z
      .object({ comments: z.int(), facts: z.int(), linked: z.int(), claims: z.int() })
      .optional(),
    event: eventDetails.optional(),
  }),
);
const eventRecord = response<EventRecord>()(record.extend({ type: text, event: eventDetails }));
const page = { nextCursor: text.nullable(), relationReferences: references.optional() };
const factFields = {
  id,
  content: text,
  kind: z.enum(['stated', 'inferred']),
  validFrom: timestamp,
  validTo: timestamp.nullable(),
  writtenBy: actorSchema,
  sources: z.array(
    z.union([
      z.object({ event: id, quote: text.nullable() }),
      z.object({ event: z.null(), internal: z.literal(true), quote: z.null() }),
    ]),
  ),
};
const fact = response<PresentedFact>()(
  z.union([
    z.object({ ...factFields, record: id, status: factStatus.optional() }),
    z.object({ ...factFields, profile, status: factStatus.optional() }),
  ]),
);
const field = response<FieldView>()(
  z.object({
    ...fieldDefinitionSchema.shape,
    description: text.nullable(),
    settings: fieldDefinitionSchema.shape.settings.unwrap().extend({
      relationCardinality: z.enum(['many_to_one', 'many_to_many', 'one_to_many']).optional(),
      isInverse: z.boolean().optional(),
    }),
    readOnly: z.boolean(),
    owner: z.enum(SCHEMA_OWNERS),
    isProtected: z.boolean(),
    protectedOptions: z.array(text).optional(),
    coreRole: z.enum(CORE_ROLES).optional(),
    isNullable: z.boolean(),
    isUnique: z.boolean(),
    isFilterable: z.boolean(),
    isSearchable: z.boolean(),
  }),
);

const objectView = response<ObjectView>()(
  z.object({
    nameSingular: text,
    namePlural: text,
    labelSingular: text,
    labelPlural: text,
    description: text.nullable(),
    labelField: text.nullable(),
    class: z.enum(OBJECT_CLASSES),
    owner: z.enum(SCHEMA_OWNERS),
    isProtected: z.boolean(),
    fields: z.array(field),
    eventColumns: z.array(z.enum(EVENT_COLUMNS)).optional(),
  }),
);
const aggregateOp = z.enum(AGGREGATE_OPS);

const responses = {
  Workspace: workspace,
  Actor: actorSchema,
  Session: response<Session>()(
    z.object({
      workspace,
      actor: actorSchema,
      scopes: z.array(z.enum(['read', 'write', 'schema:write', 'admin'])),
      person: z.boolean(),
      routinesAvailable: z.literal(true).optional(),
      agentAvailable: z.literal(true).optional(),
    }),
  ),
  Error: response<ErrorBody>()(
    z.object({
      error: z.object({ code: text, message: text, details: values.optional() }),
    }),
  ),
  Record: record,
  RecordReference: recordReference,
  RecordPage: response<RecordPage>()(z.object({ ...page, records: z.array(record) })),
  WriteResult: response<WriteResponse>()(
    z.object({
      id,
      created: z.boolean(),
      fields: z.record(text, z.enum(['applied', 'pending_review', 'superseded'])),
      record,
    }),
  ),
  MergeResult: response<MergeResult>()(
    z.object({
      id,
      mergedId: id,
      merged: z.boolean(),
      recomputedRecordIds: z.array(id),
      record,
    }),
  ),
  EventPage: response<EventPage>()(z.object({ ...page, records: z.array(eventRecord) })),
  EventRecord: eventRecord,
  EventDetails: eventDetails,
  Participants: participants,
  AddedLinks: addedLinks,
  LoggedEvent: response<LogEventResult>()(
    z.object({
      id,
      type: text,
      created: z.boolean(),
      participants,
      about: z.array(id),
      added: addedLinks.optional(),
    }),
  ),
  SchemaDescription: response<SchemaDescription>()(
    z.object({
      workspace: workspace.extend({
        schemaVersion: z.int(),
        initialized: z.boolean(),
        templates: z.array(z.object({ name: text, version: z.int(), appliedAt: timestamp })),
      }),
      objects: z.array(objectView),
      valueFormats: z.partialRecord(z.enum(FIELD_TYPES), text),
      builtIns: z.array(
        z.object({
          name: z.enum(['fact', 'comment', 'memory']),
          labelSingular: text,
          labelPlural: text,
          description: text,
          fields: z.array(z.object({ name: text, type: text, description: text })),
          writeWith: z.array(text),
          readWith: z.array(text),
          profiles: z.array(profile).optional(),
        }),
      ),
    }),
  ),
  Fact: fact,
  HistoricalFact: response<PresentedFact & { status: NonNullable<PresentedFact['status']> }>()(
    z.intersection(fact, z.object({ status: factStatus })),
  ),
  Comment: response<PresentedComment>()(
    z.object({
      id,
      record: id,
      body: text,
      author: actorSchema,
      createdAt: timestamp,
      updatedAt: timestamp,
      editedAt: timestamp.nullable(),
    }),
  ),
  SavedView: response<SavedView>()(
    z.object({
      id,
      object: text,
      name: text,
      kind: z.enum(SAVED_VIEW_KINDS),
      visibility: z.enum(SAVED_VIEW_VISIBILITIES),
      position: z.number(),
      filter: values.nullable(),
      sort: z.array(z.object({ field: text, direction: z.enum(['asc', 'desc']) })).nullable(),
      columns: z
        .object({
          order: z.array(text),
          widths: z.record(text, z.int()).optional(),
          aggregates: z.record(text, aggregateOp).optional(),
        })
        .nullable(),
      groupBy: text.nullable(),
      groupAggregate: z.object({ field: text, op: aggregateOp }).nullable(),
      hiddenGroups: z.array(text.nullable()),
      dateField: text.nullable(),
      createdBy: actorSchema,
      updatedBy: actorSchema,
      createdAt: timestamp,
      updatedAt: timestamp,
      issues: z.array(text),
    }),
  ),
  Assertion: assertion,
  FileMetadata: fileMetadataSchema,
  FileTransfer: response<SignedTransfer>()(
    z.object({ url: text, headers: z.record(text, text), expiresAt: timestamp }),
  ),
};

export function buildResponseSchemas() {
  const names = new Map<z.core.$ZodType, string>(
    Object.entries(responses).map(([name, validator]) => [validator, name]),
  );
  return Object.fromEntries(
    Object.entries(responses).map(([name, validator]) => {
      const { $schema: _, ...schema } = z.toJSONSchema(validator, {
        io: 'input',
        override({ zodSchema, jsonSchema }) {
          const component = names.get(zodSchema);
          if (!component || zodSchema === validator) return;
          for (const key of Object.keys(jsonSchema)) delete jsonSchema[key];
          jsonSchema.$ref = `#/components/schemas/${component}`;
        },
      });
      return [name, schema];
    }),
  );
}
