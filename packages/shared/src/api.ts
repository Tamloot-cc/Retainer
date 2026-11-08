import type { Actor } from './actor.js';
import type { FieldType, MoneyValue } from './field-types.js';
import type {
  BaseEventFieldName,
  BaseEventTypeName,
  BaseFieldName,
  BaseObjectName,
  CoreRole,
  EventColumn,
  FieldDefinition,
  FieldSettings,
  ObjectClass,
  ObjectDefinition,
  ProfileAlias,
  SchemaChangeStatus,
  SchemaOwner,
  SelectOption,
} from './schema.js';
import { isCollectionRelation, isInverseRelation } from './schema.js';
export type Scope = 'read' | 'write' | 'schema:write' | 'admin';
export type Session = {
  workspace: { id: string; name: string; slug: string };
  actor: Actor;
  scopes: Scope[];
  /**
   * Whether the credential works for a person, and so has personal memory
   * (`me`): a signed-in person, an app a person connected, or an API key
   * created with "This agent works for me".
   */
  person: boolean;
};
export type FieldView = Omit<FieldDefinition, 'description' | 'settings'> & {
  description: string | null;
  settings: FieldSettings;
  readOnly: boolean;
  owner: SchemaOwner;
  /**
   * Server behavior depends on the field: it cannot be deleted or reshaped,
   * only renamed, relabeled and described (1.1). Set by Retainer, never by
   * a client.
   */
  isProtected: boolean;
  /** Select option values server code reads; they cannot be removed. */
  protectedOptions?: string[];
  /** Which base field this is, so clients find it after a rename. */
  baseField?: BaseFieldName | BaseEventFieldName;
  /** An event type's core field: `title` (its label) or `summary`. */
  coreRole?: CoreRole;
  isNullable: boolean;
  isUnique: boolean;
  isFilterable: boolean;
  isSearchable: boolean;
};
export type ObjectView = {
  nameSingular: string;
  namePlural: string;
  labelSingular: string;
  labelPlural: string;
  description: string | null;
  labelField: string | null;
  owner: SchemaOwner;
  /** Server behavior depends on the object: it cannot be deleted (1.1). */
  isProtected: boolean;
  /** `entity` or `event`. Events are created only by logging them (log_event). */
  class: ObjectClass;
  /** Event types only: built-in columns beside the fields, filterable and sortable. */
  eventColumns?: EventColumn[];
  /** Which base object or base event type this is, so clients find it after a rename. */
  baseObject?: BaseObjectName | BaseEventTypeName;
  fields: FieldView[];
};
export type SchemaDescription = {
  workspace: Session['workspace'] & {
    schemaVersion: number;
    initialized: boolean;
    templates: { name: string; version: number; appliedAt: string }[];
  };
  objects: ObjectView[];
  /**
   * How to write a value of each field type the objects use
   * (FIELD_VALUE_FORMATS), so an agent gets composite shapes right first time.
   */
  valueFormats: Partial<Record<FieldType, string>>;
  /**
   * What Retainer stores besides records (1.3): facts. Fixed by Retainer and
   * written only through their own tools, never upsert_record.
   */
  builtIns: BuiltInView[];
};
/** A built-in part of every workspace's memory, as describe_schema lists it. */
export type BuiltInView = {
  name: 'fact' | 'comment' | 'memory';
  labelSingular: string;
  labelPlural: string;
  description: string;
  fields: { name: string; type: string; description: string }[];
  /** The MCP tools (and REST routes) that write it. */
  writeWith: string[];
  /** The MCP tools (and REST routes) that read it. */
  readWith: string[];
  /**
   * `memory` only: the memories this credential can name instead of a record
   * ID (personal memory spec 4.4). `workspace` always; `me` when it works
   * for a person.
   */
  profiles?: ProfileAlias[];
};
export type RecordReference = { id: string; object: string; label: string | null };
/** The event a claim cites. */
export type SourceReference = {
  id: string;
  /** The event type's API name. */
  type: string;
  title: string | null;
  occurredAt: string;
};
export type AssertionView = {
  id: string;
  recordId: string;
  object: string;
  recordLabel: string | null;
  field: string;
  value: unknown;
  currentValue: unknown;
  status: 'active' | 'superseded' | 'pending_review' | 'rejected' | 'retracted';
  reason: 'outranked' | 'low_confidence' | 'unique_conflict' | null;
  actor: Actor;
  confidence: number;
  /** The event record the claim cites, if any. */
  sourceRecordId: string | null;
  /** One of the values `log_event` wrote when the event was logged (6.2). */
  isInitial: boolean;
  observedAt: string;
  createdAt: string;
  source: SourceReference | null;
  conflictingRecord: RecordReference | null;
  relationReferences?: Record<string, RecordReference>;
  reviewedBy: Actor | null;
  reviewedAt: string | null;
};
export type Provenance = {
  pendingAssertion?: AssertionView | null;
  assertion: AssertionView | null;
  pendingAssertionIds: string[];
};
export type PresentedRecord = {
  id: string;
  object: string;
  label: string | null;
  fields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdBy: Actor;
  updatedBy: Actor;
  provenance?: Record<string, Provenance>;
  relationReferences?: Record<string, RecordReference>;
  /** Event records only: their built-in columns and links. */
  event?: EventDetails;
  /** With `include=counts`: what the record's tabs hold, so they open with their numbers. */
  counts?: RecordCounts;
};
/**
 * How many items a record's tabs hold. `facts` and `openTasks` are for
 * entities, `claims` for events. Activity has no count: gathering a wide
 * rollup fan-out to count it is what the rollup query avoids (1.3).
 */
export type RecordCounts = {
  comments: number;
  facts: number;
  openTasks: number;
  claims: number;
};
/**
 * A person's remark on a record (C1): plain text, not an event, not an
 * assertion and never evidence. `editedAt` is null until the body changes.
 */
/** The longest comment, in characters. */
export const MAX_COMMENT_LENGTH = 10_000;
export type PresentedComment = {
  id: string;
  /** The record it is on: the survivor, after a merge. */
  record: string;
  body: string;
  author: Actor;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
};
/** `GET /v1/records/:id/comments`: newest first, with the record's total. */
export type CommentPage = {
  record: string;
  items: PresentedComment[];
  total: number;
  nextCursor: string | null;
};
export type WriteResponse = {
  id: string;
  created: boolean;
  fields: Record<string, 'applied' | 'pending_review' | 'superseded'>;
  record: PresentedRecord;
};
/** How an event is attached to a record (7.1). */
export const EVENT_ATTACHMENTS = ['participant', 'about', 'field'] as const;
export type EventAttachment = (typeof EVENT_ATTACHMENTS)[number];
export type QueryInput = {
  search?: string;
  /**
   * Event types only: events directly attached to this record, as a
   * participant, `about` it, or through one of the event's relation fields.
   */
  linked?: { record: string; link?: EventAttachment };
  filter?: Record<string, unknown>;
  sort?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  cursor?: string;
  include?: string[];
};
export type RecordPage = {
  records: PresentedRecord[];
  nextCursor: string | null;
  relationReferences?: Record<string, RecordReference>;
};
/**
 * The columns every event type shares, which `POST /v1/events/query` filters
 * and sorts by. `type` is a filter only, beside these.
 */
export const EVENT_QUERY_COLUMNS = [
  'occurredAt',
  'channel',
  'externalId',
  'id',
  'createdAt',
  'updatedAt',
] as const;
export type EventQueryColumn = (typeof EVENT_QUERY_COLUMNS)[number];
/**
 * `POST /v1/events/query` input, and `query_records` with `object: "event"`:
 * events of every visible event type. Filters take only the shared columns
 * and `type` (the event type's API name, with `eq`, `neq` and `in`; not a sort);
 * `search` matches the core title and summary. Newest first by default.
 */
export type EventQueryInput = Omit<QueryInput, 'filter' | 'sort'> & {
  filter?: Record<string, unknown>;
  sort?: { field: EventQueryColumn; direction: 'asc' | 'desc' }[];
};
/** An event in a cross-type page: its type's API name, fields, and built-in columns and links. */
export type EventRecord = PresentedRecord & { type: string; event: EventDetails };
/**
 * A page of `POST /v1/events/query`. With `include: ["relationReferences"]`,
 * `relationReferences` labels every record the page names: relation values,
 * participants, candidates and `about` records.
 */
export type EventPage = {
  records: EventRecord[];
  nextCursor: string | null;
  relationReferences?: Record<string, RecordReference>;
};
export type DecisionResult = {
  assertionId: string;
  status: 'accepted' | 'rejected';
  fields?: WriteResponse['fields'];
  record: PresentedRecord;
};
export type UnresolvedParticipant = {
  eventId: string;
  position: number;
  handle: string | null;
  role: string | null;
  occurredAt: string;
  title: string | null;
  deletedRecordIds: string[];
};
export type MergeSuggestion = {
  id: string;
  recordIds: [string, string];
  /** The two records' object and label, for live records only (7.2, rule 3). */
  records: RecordReference[];
  reason: string;
  createdAt: string;
};
/** `POST /v1/records/:id/merge` (4.2). */
export type MergeResult = {
  /** The surviving record. */
  id: string;
  /** The record merged into it; reads of it now return the survivor. */
  mergedId: string;
  /** False when it was already merged into the survivor (idempotent by state). */
  merged: boolean;
  /** Other records whose relations to the merged record now point at the survivor. */
  recomputedRecordIds: string[];
  record: PresentedRecord;
};
/** `GET /v1/records/:id/delete-impact`: the other records a delete would take with it. */
export type DeleteImpact = {
  id: string;
  /** Records deleted through cascading relations, at any depth, counted by object. */
  records: { object: string; count: number }[];
};
/** `POST /v1/records/delete-impact`: the same for several records deleted together. */
export type BulkDeleteImpact = {
  /** The records asked about, after following merges. */
  ids: string[];
  /** Other records the deletes would take with them, counted by object. */
  records: { object: string; count: number }[];
};
/** `POST /v1/review/merges/:id/dismiss`. */
export type MergeSuggestionDecision = {
  id: string;
  status: 'dismissed';
};
/** `POST /v1/records/:id/forget` (2.1): counts only, never erased content. */
export type ForgetResult = {
  id: string;
  forgotten: true;
  counts: {
    records: number;
    events: number;
    facts: number;
    assertions: number;
    inboundRelations: number;
    suppressedHandles: number;
    /** Comments on the erased records, hard-deleted with them. */
    comments: number;
  };
  /** Records whose values were recomputed after their claims or links were removed. */
  recomputedRecordIds: string[];
  /**
   * Live rows that may still mention the person, found by name and handle
   * search before deletion. Not a guarantee: a person reviews them.
   */
  reviewCandidates: { records: string[]; facts: string[]; events: string[] };
};
export type ReviewCollection = 'pendingAssertions' | 'unresolvedParticipants' | 'mergeSuggestions';
export type ReviewQueue = {
  pendingAssertions: AssertionView[];
  unresolvedParticipants: UnresolvedParticipant[];
  mergeSuggestions: MergeSuggestion[];
  totals: Record<ReviewCollection, number>;
  nextCursors: Record<ReviewCollection, string | null>;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
/**
 * Where a fact is: a record's ID, or for workspace and personal memory the
 * alias agents use, never the profile's ID (personal memory spec 4.4).
 */
export type FactPlace =
  | { record: string; profile?: never }
  | { profile: ProfileAlias; record?: never };
export type PresentedFact = FactPlace & {
  status?: 'current' | 'retracted' | 'superseded' | 'ended';
  id: string;
  content: string;
  kind: 'stated' | 'inferred';
  validFrom: string;
  validTo: string | null;
  writtenBy: Actor;
  sources: FactSource[];
};
/**
 * What a fact rests on: an event, with the quote the agent chose, or the
 * internal note `remember` created when it was given no source (6.4).
 */
export type FactSource =
  | { event: string; internal?: never; quote: string | null }
  | { event: null; internal: true; quote: null };
export type UnmatchedReason =
  | 'no_match'
  | 'phone_only'
  | 'deleted_record'
  | 'ambiguous'
  | 'suppressed';
export type MatchedParticipant = {
  /** The participant link's ID, for `DELETE /v1/events/:id/participants/:participantId`. */
  id: string;
  handle: string | null;
  role: string | null;
  recordId: string;
};
export type UnmatchedParticipant = {
  id: string;
  handle: string | null;
  role: string | null;
  reason: UnmatchedReason;
  candidates?: string[];
};
export type Participant = MatchedParticipant | UnmatchedParticipant;
export type Participants = { matched: MatchedParticipant[]; unmatched: UnmatchedParticipant[] };
/** An event record's built-in columns and links (1.3), beside its fields. */
export type EventDetails = {
  occurredAt: string;
  /** Null once a privacy request erased the event's raw identity (2.1). */
  channel: string | null;
  externalId: string | null;
  /** The core title and summary, whatever the fields are named. */
  title: string | null;
  summary: string | null;
  /** Who took part. */
  participants: Participants;
  /** Records the event concerns, e.g. a meeting's company or project (1.3). */
  about: string[];
};
/**
 * How an event is attached to the record whose history lists it (7.1). An
 * event attached in several ways appears once, with this precedence.
 */
export type Via =
  | { kind: 'participant' }
  | { kind: 'about' }
  /** The event's own relation field points at the record (6.3). */
  | { kind: 'field'; field: string }
  /** Rolled up from `record`, which the event is attached to, through `field` (7.2). */
  | { kind: 'rollup'; field: string; record: string };
/** An event in a record's history, as context packs list it. */
export type EventItem = {
  id: string;
  /** The event type's API name. */
  type: string;
  occurredAt: string;
  title: string | null;
  summary: string | null;
  via: Via;
};
/** The kinds of item in a record's timeline (8), in their order at equal times. */
export const TIMELINE_ITEM_KINDS = ['event', 'field_change', 'fact'] as const;
export type TimelineItemKind = (typeof TIMELINE_ITEM_KINDS)[number];
/**
 * One item of `GET /v1/records/:id/timeline` (8), newest `at` first. An
 * event is in the record's event history (7.1, 7.2). A field_change is a
 * value asserted for one of the record's fields: `current` says whether it
 * is the value the record holds now, and one that is not may never have
 * been. It carries the asserted value (a set's whole membership), not a
 * diff. A fact is current, superseded or ended; retracted ones are left out.
 */
export type TimelineItem =
  | {
      kind: 'event';
      id: string;
      /** When it happened. */
      at: string;
      /** The event type's API name. */
      type: string;
      title: string | null;
      summary: string | null;
      via: Via;
    }
  | {
      kind: 'field_change';
      /** The assertion's ID. */
      id: string;
      /** When the value was observed. */
      at: string;
      field: string;
      value: unknown;
      status: 'active' | 'superseded';
      /** Whether this is the value the record holds now. */
      current: boolean;
      actor: Actor;
      confidence: number;
      /** The event it cites, if that is live and visible. */
      source: SourceReference | null;
      relationReferences?: Record<string, RecordReference>;
    }
  | {
      kind: 'fact';
      id: string;
      /** When it became true (`validFrom`). */
      at: string;
      content: string;
      factKind: 'stated' | 'inferred';
      status: 'current' | 'superseded' | 'ended';
      validTo: string | null;
      writtenBy: Actor;
      sources: FactSource[];
    };
export type TimelinePage = FactPlace & { items: TimelineItem[]; nextCursor: string | null };
/** An event in `GET /v1/records/:id/events`: the full event and how it is attached. */
export type AttachedEvent = PresentedRecord & { event: EventDetails; via: Via };
/**
 * A page of `GET /v1/records/:id/events`, with a reference for every record
 * its events name (participants, candidates, `about`, rollup sources).
 */
export type AttachedEventPage = Page<AttachedEvent> & {
  references: Record<string, RecordReference>;
};
/** `POST /v1/events` input (6.2). */
export type LogEventInput = {
  /** The event type's API name, e.g. "conversation". */
  type: string;
  /** The source system or account, part of the event's identity, e.g. "gmail". */
  channel: string;
  externalId?: string;
  occurredAt: string;
  title?: string;
  summary?: string;
  /** The event type's other fields, by name; not title or summary. */
  fields?: Record<string, unknown>;
  participants?: { handle?: string; recordId?: string; role?: string }[];
  about?: string[];
};
/** What a write added to an event's participants and `about` records. */
export type AddedLinks = { participants: Participants; about: string[] };
/** `POST /v1/events` result (6.2); `added` is set when it was logged before. */
export type LogEventResult = {
  id: string;
  type: string;
  created: boolean;
  participants: Participants;
  about: string[];
  added?: AddedLinks;
};
/** How far deleting events reached (6.4). */
export type EventRetraction = {
  /** Field assertions that cited the events and no longer count. */
  retractedAssertions: number;
  /** Records whose field values were recomputed (rule 2.4). */
  recomputedRecordIds: string[];
  /** Facts hidden because a deleted event was their last live source. */
  hiddenFactIds: string[];
};
/** `DELETE /v1/events/:id`. */
export type RetractEventResult = EventRetraction & { id: string; deleted: true };
/**
 * `POST /v1/events/move` (1.3): changes the type of logged events, keeping
 * their IDs, identities, links and the claims that cite them.
 */
export type MoveEventsInput = {
  /** The event type the events have now (API name). */
  from: string;
  /** The event type they move to (API name). */
  to: string;
  /** Only these events of `from` (at most 1000); without it, every live event of `from`. */
  events?: string[];
  /**
   * Source field name to target field name, for fields whose names differ.
   * The rest map by name; title and summary always map to the target's.
   */
  fields?: Record<string, string>;
  /** Source fields whose values may be deleted because the target has no field for them. */
  drop?: string[];
  /**
   * Target field values for moved events that have none for that field,
   * written as if logged with the event, e.g. `{ "medium": "meeting" }`.
   */
  defaults?: Record<string, unknown>;
  /** Check the move and report what it would do, changing nothing. */
  dryRun?: boolean;
};
export type MoveEventsResult = {
  /** The move's entry in the log; null for a dry run or when nothing moved. */
  id: string | null;
  dryRun: boolean;
  from: string;
  to: string;
  /** IDs of the events moved (or that would move), in ID order. */
  eventIds: string[];
  /** How each source field mapped, and how many moved events had claims for it. */
  fields: { from: string; to: string; events: number }[];
  /** Fields listed in `drop`: the events and assertions whose values were deleted. */
  dropped: { field: string; events: number; assertions: number }[];
  /** Defaults written: to how many events each one was. */
  defaults: { field: string; events: number }[];
};
/** `DELETE /v1/records/:id`: the records deleted and, for events, what they retracted. */
export type DeleteRecordResult = Partial<EventRetraction> & {
  id: string;
  deleted: true;
  deletedRecordIds: string[];
};
export type SchemaChange = {
  id: string;
  status: SchemaChangeStatus;
  operations: { kind: string; [key: string]: unknown }[];
  request: SchemaOperation[];
  isDestructive: boolean;
  reason: string | null;
  requestedBy: Actor;
  decidedBy: Actor | null;
  appliedVersion: number | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
};
/** Public request operations; the schema engine remains the validator. */
export type SchemaOperation =
  | { op: 'create_object'; object: ObjectDefinition }
  | {
      op: 'update_object';
      object: string;
      labelSingular?: string;
      labelPlural?: string;
      description?: string | null;
      labelField?: string;
    }
  | { op: 'rename_object'; object: string; nameSingular: string; namePlural: string }
  | { op: 'delete_object'; object: string }
  | { op: 'create_field'; object: string; field: FieldDefinition }
  | ({
      op: 'update_field';
      object: string;
      field: string;
      description?: string | null;
      rollUpEvents?: boolean;
    } & Partial<
      Pick<
        FieldDefinition,
        'label' | 'isNullable' | 'isUnique' | 'isFilterable' | 'isSearchable' | 'type'
      >
    >)
  | { op: 'rename_field'; object: string; field: string; name: string }
  | { op: 'delete_field'; object: string; field: string }
  | { op: 'add_option'; object: string; field: string; option: SelectOption }
  | { op: 'update_option'; object: string; field: string; value: string; label: string }
  | { op: 'remove_option'; object: string; field: string; value: string };
export type SchemaChangeResult = {
  status: SchemaChangeStatus | 'unchanged';
  change: SchemaChange | null;
  schemaVersion: number;
  recordIds?: string[];
  alreadyApplied?: boolean;
};
export type TemplateView = {
  name: string;
  version: number;
  label: string;
  description: string;
  applied: boolean;
  adds: {
    objects: { name: string; fields: string[] }[];
    fields: { object: string; field: string }[];
  };
};
/**
 * `POST /v1/search` input (5.1), in Postgres `websearch_to_tsquery` syntax;
 * every word also matches as a prefix, and accents are ignored.
 */
export type SearchInput = { query: string; limit?: number };
export type RecordHit = {
  id: string;
  object: string;
  label: string | null;
  /** `text`: a full-text match. `similar_label`: the fuzzy fallback on the label. */
  match: 'text' | 'similar_label';
};
export type FactHit = FactPlace & { id: string; content: string; validFrom: string };
export type EventHit = {
  id: string;
  /** The event type's API name. */
  type: string;
  occurredAt: string;
  title: string | null;
  summary: string | null;
  /** Live records linked to it, as participants or `about`; possibly none or several. */
  records: string[];
};
/** Each list is ranked on its own; scores are not comparable across lists. */
export type SearchResult = {
  records: RecordHit[];
  facts: FactHit[];
  events: EventHit[];
};
/** `GET /v1/records/:id/context` input (6.2). */
export type ContextInput = { tokenBudget?: number };
/** A current field value with who wrote it and when it was true at the source. */
export type ContextField = { value: unknown; writtenBy: Actor; observedAt: string };
export type OpenTask = {
  id: string;
  title: string | null;
  status: unknown;
  dueDate: unknown;
};
export type ContextFact = {
  id: string;
  content: string;
  validFrom: string;
  writtenBy: Actor;
  /** Live events the fact rests on. */
  sources: string[];
  /** Set when the fact rests on a note `remember` created, which has no readable ID. */
  internal?: true;
};
export type ContextPack = {
  record: {
    id: string;
    object: string;
    label: string | null;
    fields: Record<string, ContextField>;
  };
  openTasks: OpenTask[];
  facts: ContextFact[];
  /** Events attached to the record, newest first, each with how (`via`). */
  recentEvents: EventItem[];
  /** Items of each section left out to fit the budget. */
  omitted: { openTasks: number; facts: number; recentEvents: number };
  tokenEstimate: number;
};
/**
 * `get_context("workspace")` and `get_context("me")` (personal memory spec
 * 4.4): a profile's current facts, newest first, fitted to the budget. It
 * has no fields, tasks or events.
 */
export type ProfileContextPack = {
  profile: ProfileAlias;
  /** The workspace's name, or the person's. */
  label: string | null;
  facts: ContextFact[];
  omitted: { facts: number };
  tokenEstimate: number;
};
/** `POST /v1/records/:id/merge` input (4.2). */
export type MergeInput = {
  /** The record merged into the one in the path; it is soft-deleted. */
  recordId: string;
  /** Values the survivor should end with, by field name. */
  values?: Record<string, unknown>;
};
/**
 * What a list footer can compute over the records a filter matches. Counts
 * and percentages work on every field a record holds; the rest depend on the
 * type (`aggregateOps`).
 */
export const AGGREGATE_OPS = [
  'countEmpty',
  'countNotEmpty',
  'percentEmpty',
  'percentNotEmpty',
  'countUnique',
  'sum',
  'avg',
  'min',
  'max',
] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];
const EMPTINESS: AggregateOp[] = ['countEmpty', 'countNotEmpty', 'percentEmpty', 'percentNotEmpty'];
/**
 * The aggregates a field supports: none for an inverse relation, only
 * emptiness for a many_to_many one (a set has no single value to compare).
 */
export function aggregateOps(field: {
  type: FieldType;
  settings: { relationCardinality?: string; isInverse?: boolean };
}): AggregateOp[] {
  if (isInverseRelation(field)) return [];
  const ops = [...EMPTINESS];
  if (isCollectionRelation(field)) return ops;
  if (field.type === 'relation' || SORTABLE_TYPES.includes(field.type)) ops.push('countUnique');
  if (field.type === 'number' || field.type === 'money') ops.push('sum', 'avg');
  // The ordered types, which take `gt` and `lt` filters.
  if (FILTER_OPERATORS[field.type].includes('gt')) ops.push('min', 'max');
  return ops;
}
/** `POST /v1/objects/:object/aggregate`. */
export type AggregateInput = {
  search?: string;
  filter?: Record<string, unknown>;
  aggregates?: { field: string; op: AggregateOp }[];
  /** A filterable `select` field: also compute the total and aggregates per option. */
  groupBy?: string;
};
export type AggregateValue = {
  field: string;
  op: AggregateOp;
  /**
   * A count; a percentage from 0 to 100; a number; a `money` value; or a date
   * or date-time string for `min` and `max` of dates. Null when there is
   * nothing to compute over, or for money in more than one currency.
   */
  value: number | string | MoneyValue | null;
  /** Money values in several currencies are not added up. */
  mixedCurrencies?: true;
};
/** One option's share of a grouped aggregate; `value` is null for records with no value. */
export type AggregateGroup = { value: string | null; total: number; values: AggregateValue[] };
export type AggregateResult = {
  total: number;
  values: AggregateValue[];
  /** With `groupBy`: every value that at least one matching record has. */
  groups?: AggregateGroup[];
};

// ---------------------------------------------------------------------------
// Saved views (ARCHITECTURE.md 1.4): a table, board or calendar over one
// object. Display settings only; fields are named as in the schema.
// ---------------------------------------------------------------------------

export const SAVED_VIEW_KINDS = ['table', 'board', 'calendar'] as const;
export type SavedViewKind = (typeof SAVED_VIEW_KINDS)[number];
export const SAVED_VIEW_VISIBILITIES = ['workspace', 'private'] as const;
export type SavedViewVisibility = (typeof SAVED_VIEW_VISIBILITIES)[number];

type KindFieldCandidate = { type: FieldType; isFilterable: boolean };
/** A board groups by a filterable single select; its options are the columns. */
export const canGroupBy = (field: KindFieldCandidate) =>
  field.type === 'select' && field.isFilterable;
/** A calendar places records by a filterable date or date-time. */
export const canPlaceBy = (field: KindFieldCandidate) =>
  (field.type === 'date' || field.type === 'date_time') && field.isFilterable;

export type ViewColumns = {
  /** Visible fields after the label field, in order. */
  order: string[];
  widths?: Record<string, number>;
  /** Each column's footer calculation. */
  aggregates?: Record<string, AggregateOp>;
};
export type ViewSort = { field: string; direction: 'asc' | 'desc' };
/** What a view shows; every key is optional and `null` clears it on update. */
export type ViewConfig = {
  filter?: Record<string, unknown> | null;
  sort?: ViewSort[] | null;
  columns?: ViewColumns | null;
  /** Board: the `select` field whose options are the columns. */
  groupBy?: string | null;
  /** Board: option values whose columns are hidden; `null` is "no value". */
  hiddenGroups?: (string | null)[] | null;
  /** Board: shown in each column's header. */
  groupAggregate?: { field: string; op: AggregateOp } | null;
  /** Calendar: the `date` or `date_time` field records are placed by. */
  dateField?: string | null;
};
export type SavedView = {
  id: string;
  object: string;
  name: string;
  kind: SavedViewKind;
  visibility: SavedViewVisibility;
  position: number;
  filter: Record<string, unknown> | null;
  sort: ViewSort[] | null;
  columns: ViewColumns | null;
  groupBy: string | null;
  hiddenGroups: (string | null)[];
  groupAggregate: { field: string; op: AggregateOp } | null;
  dateField: string | null;
  createdBy: Actor;
  updatedBy: Actor;
  createdAt: string;
  updatedAt: string;
  /** References to fields that are no longer active, dropped from what is returned. */
  issues: string[];
};
/** `POST /v1/objects/:object/views`. */
export type CreateViewInput = ViewConfig & {
  name: string;
  kind: SavedViewKind;
  visibility?: SavedViewVisibility;
  position?: number;
};
/** `PATCH /v1/views/:id`: only the keys given change. */
export type UpdateViewInput = ViewConfig & {
  name?: string;
  kind?: SavedViewKind;
  visibility?: SavedViewVisibility;
  position?: number;
};

export const SORTABLE_TYPES: readonly FieldType[] = [
  'text',
  'number',
  'boolean',
  'date',
  'date_time',
  'select',
];
export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'isNull'
  | 'containsAny'
  | 'containsAll'
  | 'isEmpty';
export const FILTER_OPERATORS: Record<FieldType, readonly FilterOperator[]> = {
  text: ['eq', 'neq', 'in', 'contains'],
  number: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'],
  boolean: ['eq', 'neq'],
  date: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte'],
  date_time: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  select: ['eq', 'neq', 'in'],
  multi_select: ['contains'],
  money: ['gt', 'gte', 'lt', 'lte'],
  emails: ['eq'],
  phones: ['eq'],
  links: ['eq'],
  full_name: ['contains'],
  address: ['contains'],
  relation: ['eq', 'in'],
  json: [],
};
/**
 * Filters on a many_to_many relation: whether its set holds any or all of
 * some record IDs, or is empty. Sets have no order, so no comparisons.
 */
const COLLECTION_FILTER_OPERATORS: readonly FilterOperator[] = [
  'containsAny',
  'containsAll',
  'isEmpty',
];
/** The filter operators a field takes, including `isNull` where it applies. */
export function filterOperatorsFor(field: {
  type: FieldType;
  settings: { relationCardinality?: string };
}): readonly FilterOperator[] {
  if (isCollectionRelation(field)) {
    return COLLECTION_FILTER_OPERATORS;
  }
  return [...FILTER_OPERATORS[field.type], 'isNull'];
}
