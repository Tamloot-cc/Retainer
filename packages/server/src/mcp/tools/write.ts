import type { McpServer } from '@modelcontextprotocol/server';
import { PROFILE_ALIASES } from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import type { Sql } from '../../db/client.js';
import { AppError } from '../../errors.js';
import { MAX_PARTICIPANTS, participantInputSchema } from '../../memory/event-links.js';
import { logEventInputSchema } from '../../memory/events.js';
import { rememberInputSchema } from '../../memory/facts.js';
import { moveEventsInputSchema } from '../../memory/move.js';
import { logEventFor, moveEventsFor, remember } from '../../memory/service.js';
import {
  createRecord,
  upsertInputSchema,
  upsertRecord,
  valuesSchema,
} from '../../records/service.js';
import { requestSchemaChange, schemaChangeRequestSchema } from '../../schema-engine/service.js';
import { objectName, run } from '../shared.js';

const upsertRecordInput = z.strictObject({
  object: objectName,
  ...upsertInputSchema.shape,
  id: upsertInputSchema.shape.id.describe('Update this record.'),
  match: upsertInputSchema.shape.match.describe(
    'Find the record by one unique field and its value, e.g. { "emails": "dana@acme.com" }. ' +
      'Names and phones are not unique: find those records with search or query_records first.',
  ),
  values: valuesSchema
    .default({})
    .describe(
      "Field name to value, in its type's format from describe_schema's valueFormats. " +
        'Composite fields (emails, phones, links, money, full_name, address) are replaced whole, so include the values to keep. null clears a field. ' +
        'A many_to_many relation takes the whole list of record IDs ([] clears it): read ' +
        'the record first and send every member to keep. Fields marked readOnly (isInverse) ' +
        'are written from the other side.',
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

const logEventInput = z.strictObject({
  ...logEventInputSchema.shape,
  type: logEventInputSchema.shape.type.describe(
    'The event type\'s API name: "conversation" for meetings, calls, emails and chats (set ' +
      'fields.medium), or another event type only when the workspace defines one for that ' +
      'kind of event. describe_schema lists them as objects of class "event".',
  ),
  channel: logEventInputSchema.shape.channel.describe(
    'The source system or account the event came from, e.g. "gmail", "zoom", "tamloot", ' +
      '"whatsapp-business". Part of its identity and fixed once logged: use a distinct channel ' +
      'per source account when their external IDs could overlap. What kind of conversation it ' +
      'was is the medium field, not the channel.',
  ),
  externalId: logEventInputSchema.shape.externalId.describe(
    "The source's own ID (message, thread, meeting or call ID). Logging it again with the " +
      'same input returns the same event; without it, retries log duplicates.',
  ),
  occurredAt: logEventInputSchema.shape.occurredAt.describe(
    'When it happened, ISO 8601 with a UTC offset, e.g. "2026-10-29T14:00:00+02:00".',
  ),
  title: logEventInputSchema.shape.title.describe('A short title.'),
  summary: logEventInputSchema.shape.summary.describe(
    'Your own short summary. Not a transcript or message body: store only what the ' +
      'workspace should keep.',
  ),
  fields: logEventInputSchema.shape.fields.describe(
    'The event type\'s other fields by name, e.g. { "medium": "call" } for a conversation, ' +
      'or { "deal": "<record id>" } for a type with a deal relation. Title and summary go at ' +
      'the top level, not here.',
  ),
  participants: z
    .array(
      z.strictObject({
        handle: participantInputSchema.shape.handle.describe('An email address or phone number.'),
        recordId: participantInputSchema.shape.recordId.describe(
          'The record of this participant, when you know it. Needed to link a participant ' +
            'known only by phone.',
        ),
        role: participantInputSchema.shape.role.describe(
          'The part they played, in your words, e.g. "customer", "from", "attendee".',
        ),
      }),
    )
    .max(MAX_PARTICIPANTS)
    .default([])
    .describe(
      'Who took part (people only); each needs a handle, a recordId, or both. Records the ' +
        'event concerns, such as a company or project, go in about.',
    ),
  about: logEventInputSchema.shape.about.describe(
    'IDs of the entities the event is about: the company, project, deal or tasks it ' +
      "concerns. It then shows in those records' get_context and query_records with linked. " +
      'Unknown or deleted IDs fail the call, and an event fails with invalid_link: an event ' +
      'is not linked to another event.',
  ),
});

const rememberInput = z.strictObject({
  record: z
    .union([z.uuid(), z.enum(PROFILE_ALIASES)])
    .describe(
      'The record the fact is about; or "workspace" for how the business works, shared by ' +
        'everyone; or "me" for the person you work for (preferences, style, goals), private to ' +
        "them. Customer knowledge always goes on the customer's record.",
    ),
  ...rememberInputSchema.shape,
  text: rememberInputSchema.shape.text.describe(
    'One plain-language fact, e.g. "Legal review at Acme usually takes two weeks."',
  ),
  source: rememberInputSchema.shape.source.describe(
    'The event id (from log_event) the fact comes from; the fact is valid from that ' +
      "event's date. Without it, the fact rests on an internal note Retainer keeps for it.",
  ),
  quote: rememberInputSchema.shape.quote.describe(
    'Optional short quote from the source that supports the fact. Needs source.',
  ),
  supersedes: rememberInputSchema.shape.supersedes.describe(
    'The ID of a current fact this one replaces; it stays in history. On the same record ' +
      'it corrects that fact. On another record (or memory) it moves it: pass the same text ' +
      'and no source or quote, and its evidence is copied. Not a fact a person wrote, and ' +
      'not a shared fact into me.',
  ),
  idempotencyKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Retrying with the same key returns the first result instead of a second fact.'),
});

export function registerWriteTools(server: McpServer, sql: Sql, caller: Caller): void {
  server.registerTool(
    'upsert_record',
    {
      title: 'Create or update a record',
      description:
        'Writes field values to one record. Find it by id, or by match on one unique field ' +
        '(e.g. emails). With neither, a new record is created. If id or match finds nothing ' +
        'the call fails, unless ifMissing is "create"; so "update Dana\'s address" can never ' +
        'create a second Dana by mistake.\n\n' +
        'Values learned from a conversation should cite it: log it with log_event first ' +
        'and pass its id as source. Events are created only with log_event; an existing ' +
        "event's fields can be corrected here.\n\n" +
        'The response reports each field: "applied" (it is now the value), "pending_review" ' +
        '(a person set a different value; yours waits for their approval, so say so) or ' +
        '"superseded" (kept in history; a newer or higher-precedence value stands). ' +
        'Validation errors name the field and the allowed values or expected format.',
      inputSchema: upsertRecordInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ object, idempotencyKey, ...input }) =>
      run(caller, 'write', () => {
        if (!input.id && !input.match) {
          return createRecord(sql, caller, object, input.values, {
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            ...(input.source !== undefined ? { source: input.source } : {}),
          });
        }
        if (idempotencyKey !== undefined) {
          throw new AppError(
            400,
            'invalid_request',
            'idempotencyKey applies only to creates without id or match; ' +
              'a write by id or match is already safe to retry',
          );
        }
        return upsertRecord(sql, caller, object, input);
      }),
  );

  server.registerTool(
    'log_event',
    {
      title: 'Log an event',
      description:
        'Logs something that happened, as a record of an event type. Log meetings, calls, ' +
        'emails and chats as conversation with a medium. Use another event type only when ' +
        'the workspace defines one for that kind of event. Give when it happened, a title, your own ' +
        'short summary, its other fields, who took part (participants) and the records it ' +
        'concerns (about: e.g. the company and project of a meeting with Dana about the Acme ' +
        'pilot). Do this first after a conversation, then pass the returned id as source to ' +
        'upsert_record and remember.\n\n' +
        'Participants are matched by email to existing records. The response lists matched ' +
        'participants with their recordId, and unmatched ones with a reason: "no_match" (no ' +
        'record has this email; create the person with upsert_record if worth keeping), ' +
        '"phone_only" (phones never match on their own; pass recordId if you know it), ' +
        '"deleted_record" (the email belongs to a deleted record; a person will review it), ' +
        '"ambiguous" (several records claim it; candidates lists them) or "suppressed" (the ' +
        'person asked to be forgotten; the handle is not stored, and do not create a record ' +
        'for it). Retainer never creates records for you.\n\n' +
        'Logging the same channel and externalId again returns the same event with ' +
        'created: false, after adding the participants and about records it did not have ' +
        '(listed in added); nothing is removed. A different type, occurredAt, title, summary ' +
        'or field value is a conflict (event_conflict): an edited source needs a new ' +
        'externalId. event_retracted means that source was deleted or erased: do not log it ' +
        'again.',
      inputSchema: logEventInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) => run(caller, 'write', () => logEventFor(sql, caller, input)),
  );

  server.registerTool(
    'move_events',
    {
      title: 'Move events to another event type',
      description:
        'Changes the type of logged events, e.g. every meeting to conversation with ' +
        'defaults { "medium": "meeting" }, keeping each event\'s id, channel and externalId, ' +
        'participants, about records, and the values and facts that cite it. Use it instead ' +
        'of deleting and re-logging, which retracts what cites the events and blocks their ' +
        'source for good. Without events, every event of from moves, all or nothing.\n\n' +
        'Fields map by name (title and summary always do); fields maps the ones named ' +
        'differently. If the target has no field for some values, the move is refused with ' +
        'the list (unmapped_fields): map them, or list them in drop only if your user agrees ' +
        'to delete those values. defaults fills target fields the events have no value for, ' +
        'and is compared like a logged value when the source is logged again.\n\n' +
        'Moving needs a person: a user key with the admin scope. With your own key, set ' +
        'dryRun: true (needs schema:write) to get exactly what would move, then show your ' +
        'user and let them run it.',
      inputSchema: moveEventsInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (input) => run(caller, 'schema:write', () => moveEventsFor(sql, caller, input)),
  );

  server.registerTool(
    'remember',
    {
      title: 'Remember a fact',
      description:
        'Stores one plain-language fact about a record that does not fit a field, e.g. ' +
        '"Legal review at Acme usually takes two weeks." Cite the event it came from as ' +
        'source (from log_event), with an optional short quote; the fact is then valid from ' +
        "that event's date. Without source, Retainer keeps an internal note for it, shown " +
        'as an internal source. One fact per call; field values belong in upsert_record. ' +
        'record "workspace" or "me" stores what is not about a record (get_guide("memory")). ' +
        'When a fact changes or sits on the wrong record, pass supersedes; you cannot delete one.',
      inputSchema: rememberInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ record, idempotencyKey, ...input }) =>
      run(caller, 'write', () => remember(sql, caller, record, input, idempotencyKey)),
  );

  server.registerTool(
    'propose_schema_change',
    {
      title: 'Change the schema',
      description:
        'Requests schema operations: create_object, create_field, add_option and label or ' +
        'description changes are applied at once. Renames, deletions, removing options and ' +
        'making a field required or unique are only proposed: a person with admin access ' +
        'approves them, and the response says "proposed". Field types cannot be changed; ' +
        'create a new field instead. Fields are not searchable unless you set isSearchable: ' +
        'set it on text fields people will look records up by (the label field is always ' +
        'searchable). Give a short reason. Needs the schema:write scope.\n\n' +
        'Make the smallest change that works: an option before a field, a field before an ' +
        'object. Meetings, calls, emails and chats are conversations (log_event): add an ' +
        'option to medium or a field to conversation rather than a new type. Create an event ' +
        'type (class "event") only for events with fields a conversation would never use, ' +
        'such as a payment. Something with a state people change is an object; something that ' +
        'happened, reported by a source, is an event; a change to an object is its history, ' +
        'never an event (the object-or-event test in get_guide("schema_design")). One-off ' +
        'knowledge is a fact (remember), never an object or field. If you have not yet, read ' +
        'get_guide("schema_design") before creating an object.',
      inputSchema: schemaChangeRequestSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    (body) =>
      run(
        caller,
        'schema:write',
        () => requestSchemaChange(sql, caller, body),
        (result) => (result as { status: string }).status === 'failed',
      ),
  );
}
