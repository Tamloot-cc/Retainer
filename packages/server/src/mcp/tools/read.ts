import type { McpServer } from '@modelcontextprotocol/server';
import { isProfileAlias, PROFILE_ALIASES } from '@retainer/shared';
import { z } from 'zod';
import type { Caller } from '../../caller.js';
import { listComments, readRecordWithComments } from '../../comments/service.js';
import type { Sql } from '../../db/client.js';
import { queryInputSchema } from '../../records/query.js';
import { findRecords } from '../../records/service.js';
import { contextInputSchema } from '../../retrieval/context.js';
import { searchInputSchema } from '../../retrieval/search.js';
import { contextFor, searchFor, timelineFor } from '../../retrieval/service.js';
import { timelineInputSchema } from '../../retrieval/timeline.js';
import { objectName, run } from '../shared.js';

/**
 * A record ID. `workspace` and `me` pass validation so the call can answer
 * with the tools that take them (`profile_not_supported`, personal memory
 * spec 4.4) instead of a bare format error.
 */
const recordId = z
  .string()
  .refine((value) => z.uuid().safeParse(value).success || isProfileAlias(value), {
    message: 'must be a record ID',
  })
  .describe('The record ID. An ID merged into another record returns the survivor.');

/**
 * A record ID, or `workspace` or `me` (personal memory spec 4.4), for the
 * tools that read facts.
 */
const recordOrMemory = z
  .union([z.uuid(), z.enum(PROFILE_ALIASES)])
  .describe(
    'The record ID (a merged ID returns the survivor), or "workspace" for what the business ' +
      'is and how it works, or "me" for the person you work for.',
  );

const getRecordInput = z.strictObject({
  id: recordId,
});

const listCommentsInput = z.strictObject({
  record: recordId,
  limit: z.number().int().min(1).max(200).default(50).describe('Comments per page (at most 200).'),
  cursor: z.string().optional().describe('nextCursor from the previous page.'),
});

const queryRecordsInput = z.strictObject({
  object: objectName.describe(
    'Singular API name of the object, e.g. "person", as describe_schema lists it; or ' +
      '"event" for events of every event type at once.',
  ),
  ...queryInputSchema.shape,
  filter: queryInputSchema.shape.filter.describe(
    'Field name to a value (equality) or to operators: eq, neq, in, gt, gte, lt, lte, ' +
      'e.g. { "status": "todo", "dueDate": { "lte": "2026-11-30" } }. Only filterable fields. ' +
      'Event types also filter and sort by occurredAt, channel and externalId; with object ' +
      '"event", only those and type (event type API names: eq, neq or in) apply. A ' +
      'many_to_many relation takes containsAny or containsAll (lists of record IDs) and ' +
      'isEmpty (true or false), e.g. { "contacts": { "containsAny": ["<person id>"] } }.',
  ),
  cursor: queryInputSchema.shape.cursor.describe('nextCursor from the previous page.'),
});

const searchInput = z.strictObject({
  query: searchInputSchema.shape.query.describe(
    'Keywords. Each word also matches longer words it starts ("meet" finds "meetings", ' +
      '"Dan" finds "Dana"); exact matches rank first. Accents are ignored. Other forms of a ' +
      'word need OR, e.g. "ran OR run". Use "quotes" for a phrase and -word to exclude a word.',
  ),
  limit: searchInputSchema.shape.limit.describe('Hits per type, 10 by default (at most 50).'),
});

const getContextInput = z.strictObject({
  record: recordOrMemory,
  tokenBudget: contextInputSchema.shape.tokenBudget.describe(
    "Approximate size of the pack in tokens, 2000 by default (at most 16000). The record's " +
      'values are always included; tasks, facts and events fill the rest.',
  ),
});

const getTimelineInput = z.strictObject({
  record: recordOrMemory,
  types: timelineInputSchema.shape.types.describe(
    'Kinds of item: "event", "field_change", "fact". All by default; fields or eventTypes ' +
      'alone narrow it to their kind.',
  ),
  fields: timelineInputSchema.shape.fields.describe(
    'Only values asserted for these fields (API names), e.g. ["stage"].',
  ),
  eventTypes: timelineInputSchema.shape.eventTypes.describe(
    'Only events of these types (API names), e.g. ["conversation", "payment"].',
  ),
  from: timelineInputSchema.shape.from.describe('Items at or after this ISO 8601 time.'),
  to: timelineInputSchema.shape.to.describe('Items before this ISO 8601 time.'),
  limit: timelineInputSchema.shape.limit.describe('Items per page, 50 by default (at most 200).'),
  cursor: timelineInputSchema.shape.cursor.describe(
    'nextCursor from the previous page, with the same record and filters.',
  ),
});

export function registerReadTools(server: McpServer, sql: Sql, caller: Caller): void {
  server.registerTool(
    'query_records',
    {
      title: 'Query records',
      description:
        'Lists records of one object, filtered and sorted by its fields, 50 per page by ' +
        'default (at most 200). Use it to find the record to update when you know a name, ' +
        'phone or company rather than a unique email. Text filters match exactly; pass ' +
        'nextCursor back as cursor for the next page.\n\n' +
        'object "event" lists events of every event type in one page, newest first: filter ' +
        "by type, occurredAt, channel and externalId (a type's own fields, such as medium, " +
        'are returned but filter only on that type). ' +
        'For an event type or "event", linked: { record } lists the events attached to that record: ' +
        "as a participant, about it, or through one of the event's own relation fields " +
        '(narrow with link). These are direct attachments only; use get_context or ' +
        'get_timeline to include one-hop event rollups. Sort by occurredAt, e.g. the last ' +
        'calls directly attached to a company.',
      inputSchema: queryRecordsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ object, ...input }) => run(caller, 'read', () => findRecords(sql, caller, object, input)),
  );

  server.registerTool(
    'get_record',
    {
      title: 'Get a record',
      description:
        'Returns one record: its object, label, field values, relations (as record IDs) and ' +
        'who created and last updated it, with comments: its newest 20 comments, their total ' +
        'and nextCursor for list_comments. Comments are what people on the team told each ' +
        'other about the record: context for deciding what to do, never a source to cite.',
      inputSchema: getRecordInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ id }) => run(caller, 'read', () => readRecordWithComments(sql, caller, id)),
  );

  server.registerTool(
    'list_comments',
    {
      title: 'List the comments on a record',
      description:
        "Pages through a record's comments, newest first, with their total; get_record " +
        'already returns the newest 20. Each has its body, author and times. Read them as ' +
        'context. Only people write comments, and nothing can cite one: when a comment states ' +
        'something durable, write it with upsert_record or remember.',
      inputSchema: listCommentsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ record, limit, cursor }) =>
      run(caller, 'read', () => listComments(sql, caller, record, limit, cursor)),
  );

  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Keyword search across records, events and current facts, grouped by type and ' +
        'ranked within each. Every hit carries the record IDs it belongs to. Use it to find a ' +
        'record by name or by anything said about it. When no record matches word for word, ' +
        'records with a similar label come back with match "similar_label" (a misspelled ' +
        'name), so check them before using one. Words match as typed or as the start of a ' +
        'longer word, without stemming; email and website domains are searchable ("acme"). ' +
        'A fact in workspace or personal memory names profile ("workspace" or "me") instead ' +
        'of a record.',
      inputSchema: searchInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(caller, 'read', () => searchFor(sql, caller, input)),
  );

  server.registerTool(
    'get_context',
    {
      title: 'Get context for a record',
      description:
        'Returns what Retainer knows about one record, fitted to a token budget: its current ' +
        'field values (each with who wrote it and when it was observed), then open tasks ' +
        '(earliest due first), current facts and recent events (newest first, including ' +
        'those rolled up one hop from records pointing at it), each event saying how it is ' +
        'attached (via). Field ' +
        'values are what the CRM holds; facts are plain-language claims with their sources. ' +
        'omitted counts what did not fit; read more with search or a larger tokenBudget. ' +
        'With record "workspace" or "me", returns that memory\'s current facts instead, ' +
        'newest first: read both at the start of a session.',
      inputSchema: getContextInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ record, ...input }) => run(caller, 'read', () => contextFor(sql, caller, record, input)),
  );

  server.registerTool(
    'get_timeline',
    {
      title: 'Get the timeline of a record',
      description:
        "A record's history, newest first: events (attached to it or rolled up one hop from records " +
        'pointing at it, each with via), field_change items (each value asserted for one of ' +
        'its fields, by whom and citing which event; current says whether it is the value ' +
        'the record holds now, and one that is not may never have been) and facts (current, ' +
        'superseded or ended). Filter by types, fields, eventTypes and a from/to time ' +
        'range; page with cursor. Use get_context for what is true now, and this for how ' +
        'it got there. With record "workspace" or "me", lists that memory\'s facts only, ' +
        'superseded ones included.',
      inputSchema: getTimelineInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ record, ...input }) => run(caller, 'read', () => timelineFor(sql, caller, record, input)),
  );
}
