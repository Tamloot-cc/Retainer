# Retainer architecture

Retainer is an open-source memory layer for AI agents that work with customer
relationships. Agents and apps use it through a REST API and an MCP server.
An optional web app in `packages/web` gives people review, records and
provenance screens; see `FRONTEND.md` for its scope.

It combines two ideas:

- **Schema as data** (from [Twenty](https://github.com/twentyhq/twenty)): the
  shape of the CRM (objects, fields, relations) is stored as rows, so a
  workspace, or an agent working in it, can extend the model at runtime.
- **Memory with provenance** (inspired by
  [Honcho](https://github.com/plastic-labs/honcho), but agent-written):
  agents read conversations with their own models and write typed field
  values, plain-language facts and a log of events (meetings, calls,
  emails and anything else that happens). Every value records who wrote it
  and which event it came from.

Retainer never calls a language model. Agents decide what to remember;
Retainer validates it, resolves conflicts, keeps its history and makes it
searchable. Full conversations stay with the agent.

---

## 1. Data model

Three layers, all in one Postgres database. This document describes the
design as of the first release (0.1.0).

### 1.1 Schema (metadata)

| Table            | Holds                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `object_types`   | The kinds of things tracked: `person`, `company`, `task` and the base event types in every workspace, more from templates (3.1), plus custom objects. `class` is `entity` or `event` (1.3) |
| `fields`         | The fields of each object: type, settings, flags (`is_nullable`, `is_unique`, `is_filterable`, `is_searchable`), and `core_role` (`title` or `summary`) on an event type's core fields     |
| `schema_changes` | Every applied, proposed, rejected or failed change, with its operations and actor                                                                                                          |

Every schema row carries:

- `universal_id`: a stable UUID that is the same for a standard object or
  field in every workspace, so upgrades can find it.
- `owner`: `system` (shipped with Retainer), `workspace` (added by a user or
  integration), or `agent` (added by an agent).
- `status`: `active` or `deprecated`. A proposed change lives only in
  `schema_changes` until it is approved; nothing half-exists in the live
  schema.
- `key` (fields only): a short, permanent ID used as the JSON key in
  `records.data`. Renaming a field changes `name`, never `key`, so a rename
  never touches the data. Keys are never reused, even after a field is
  deleted.

- `is_protected`: set by the schema engine, never by a client, on objects and
  fields that server code depends on (below).

#### Protection

Server code finds the schema elements it depends on by universal ID, never
by API name, and the engine protects each of them. Today these are the base
objects `person`, `company` and `task`, the fields `task.status` and
`task.dueDate` (open tasks in context packs, 6.2), and the hidden
internal-note event type (1.3). The list lives in
`schema-engine/protection.ts`; any new server dependency on a schema
element protects it in the same change. The core `title` and `summary`
fields of every event type are protected the same way. The base event type
itself is not: an unused one can be deleted like any object.

- A protected object cannot be deleted. Its API names and labels can change.
- A protected field cannot be deleted or reshaped: renames, labels and
  descriptions are allowed; changes to type, `is_nullable`, `is_unique`,
  `is_filterable` and `is_searchable` are rejected.
- Only the select option values server code reads are protected:
  `task.status` keeps its `done` option, whose label can change. Other
  options can be added, relabeled and removed, so a workspace can add
  statuses such as `blocked`.
- Protection does not freeze record values.

`describe_schema` shows `isProtected` on objects and fields and
`protectedOptions` on fields, and marks base elements with `baseObject`
(`person`, `company`, `task`) or `baseField` (`taskStatus`,
`taskDueDate`), so a client finds them after a rename without reading
universal IDs.

Workspaces carry a `schema_version` that increments on every applied change.
API and MCP schemas are cached per `(workspace, schema_version)`.

#### Field types

| Type                                                     | Stored as                                                        |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `text`, `number`, `boolean`, `date`, `date_time`, `json` | Plain JSON values                                                |
| `select`, `multi_select`                                 | Option value(s); options live in `fields.settings`               |
| `money`                                                  | `{ amountMicros, currency }`                                     |
| `emails`                                                 | `{ primary, additional[] }`                                      |
| `phones`                                                 | `{ primary: { number, countryCode }, additional[] }`             |
| `links`                                                  | `{ primary: { url, label }, additional[] }`                      |
| `full_name`                                              | `{ first, last }`                                                |
| `address`                                                | `{ street1, street2, city, state, postcode, country, lat, lng }` |
| `relation`                                               | Not in `records.data`; see `record_links`                        |

Composite shapes are defined once in `@retainer/shared`, so every object that
has emails stores them the same way.

#### Built-in columns on every record

`id`, `created_at`, `updated_at`, `deleted_at` (soft delete), `created_by`,
`updated_by`, `merged_into_id` (set when the record was merged into another,
so IDs that agents kept still resolve). These are real columns on `records`,
not schema fields.

#### Relations

A `relation` field is defined on its owning side: `many_to_one` for one
record (`person.company`) or `many_to_many` for a set of records
(`deal.contacts`). The other side, if named with `inverseField`, is its
inverse, read from the same `record_links` rows: `one_to_many` for a
many-to-one field (`company.people`), `many_to_many` for a many-to-many
one (`person.contactDeals`). The engine marks every inverse
`settings.isInverse`, and only the owning side is written; `describe_schema`
shows inverses as `readOnly`. Cardinality and targets cannot change on an
existing field: create a new field instead.

A relation may also be polymorphic: `targetObjects` names two or more
objects it may point at (a deal's `customer`, a company or a person),
instead of `targetObject`. Either multiplicity works. Stored settings hold
the objects' universal IDs, so renames keep it. A polymorphic relation has
no inverse field (per-target inverses are deferred); the records pointing at
one target are found by filtering on the field. Deleting an object that a
polymorphic relation may also point at is refused and names the field: the
engine never narrows its targets, which would reinterpret existing values,
so the field is replaced first. A relation whose only target is deleted is
deprecated with it, as before.

Setting a link is a field assertion whose value is the target record's ID,
or for a set the whole array of IDs, so links follow the same write rules as
other fields; `record_links` is derived from the winning assertion, one row
per target, like `records.data`. A set is normalized before it is compared
or stored: duplicates dropped, ordered by ID, `[]` to clear it, `null`
refused; a required set needs at least one member. A write replaces the
whole set as one assertion, ranked like any other; there is no implicit
union, so two writers replacing a set do not each keep their members, and
a pending set changes no edges. Every member must be a live record of an
allowed target object in the same workspace, or the whole write fails.

The field's `onDelete` setting is applied by the application when the target
is soft-deleted: `cascade` soft-deletes the source records too; `set_null`
(the default) keeps the edge and the assertion, and reads skip the deleted
target. `cascade` is refused on many-to-many fields, since cascades follow
links at any depth and deleting one contact would delete every deal listing
it. The database cascade only covers hard deletes of edges, not the
asserted relation values.

`record_links.is_collection` marks a set's edges. A trigger sets it from the
field, never from the writer, and refuses edges on an inverse or
non-relation field; a unique index on `(workspace_id, source_record_id,
field_id, target_record_id)` keeps each edge once, and a partial unique
index on `(source_record_id, field_id) where not is_collection` holds a
single-record field to one edge in the database itself, even for a writer
that bypasses the application. Merges point sets at the survivor, once.
Hard deletion deletes single-record assertions that point at the deleted
record and removes it from every set assertion, current or past (2.1,
step 3), so a rebuild cannot recreate dangling links.

Sets filter with `containsAny` and `containsAll` (lists of record IDs) and
`isEmpty`; they take no comparisons and cannot be sorted.

#### Actor

Every write carries an actor: `{ type, id, name? }` where `type` is `user`,
`agent`, `integration`, or `system`. The API key decides the actor; callers
cannot claim to be someone else. The server's own `system` actor
(`retainer`) seeds base objects and applies a template chosen at workspace
creation; merges are attributed to the merging user, and the consolidator
writes no actor-stamped rows.

### 1.2 Records

| Table                | Holds                                                                                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records`            | One row per entity: `workspace_id`, `object_type_id`, `data jsonb` (keyed by field `key`), `search tsvector` and `label` (5.1), built-in columns                                                                                        |
| `record_links`       | Relations as edges: `field_id`, `source_record_id`, `target_record_id`. Real foreign keys with cascade delete                                                                                                                           |
| `record_identifiers` | Normalized identifiers pointing at a record: every email, phone and website domain, plus the value of every `is_unique` field. `(workspace_id, field_id, value)` is unique for `is_unique` fields (the standard `person.emails` is one) |

`records.data` is a **cache computed from `field_assertions`** (below). If the
layout ever needs to change, records are rebuilt from assertions.
`record_links` and `record_identifiers` are maintained in the same
transaction that recomputes `records.data`.

`record_identifiers` exists because composite fields (`emails`, `phones`,
`links`) keep extra values in an array that an expression index on
`data->>'<key>'` cannot see or enforce. It is used for participant matching,
for uniqueness, and for finding duplicates, and its unique constraint is what
stops two concurrent writes from creating the same person twice.
Each identifier row stores a canonical value and an explicit uniqueness
claim (`is_claim`); a fixed partial unique index over claims enforces `(workspace_id, field_id, value)` without
per-field DDL. Null values create no claim. Normalization is shared by
writes and lookup; generic unique values retain their JSON type so number
`1` and text `"1"` do not collide. Only `text`, `number`, `date` and
`emails` fields can be unique; the schema engine rejects the rest.

Only an exact identifier declared unique can automatically select a record.
Non-unique phones, shared inboxes, domains and name similarity produce
candidates. If supplied identifiers point to different records, return a
conflict with candidate IDs; never pick the first match or merge implicitly.
A losing concurrent create rolls back the entire provisional record and
retries lookup. Soft-deleted records retain uniqueness claims until purged
with `forget` (restoring a record is not in v1), so writes cannot silently
recreate them. A match on a
soft-deleted record follows `merged_into_id` when set; otherwise the
participant stays unresolved and is listed in `GET /v1/review`, rather than
attaching new events to a hidden record.

#### Why JSONB and not a table per object

Twenty creates a real Postgres table for every object in every workspace. We
store all records in one table instead, because:

- Agents add fields automatically. With JSONB that is one metadata row, with
  no DDL, locks or partial failures.
- Self-hosted upgrades stay simple: one fixed schema with normal migrations,
  not a migration per workspace.
- The hosted cloud can hold many workspaces without bloating the Postgres
  catalog.

To keep what real tables give you:

1. **Integrity for relations**: `record_links` has real foreign keys.
2. **Rename safety**: JSON keys are field `key`s, not names.
3. **Uniqueness without DDL**: `is_unique` is enforced through
   `record_identifiers`, not a per-field unique index.
4. **Shared indexes in v1**: equality filters use JSONB containment (`data
   @> …`) with the existing GIN index, scoped by workspace and object.
   `is_filterable` exposes a field to structured filters; it does not create
   an index. Range filters and sorts scan that object's rows with typed
   comparisons. Add expression indexes later only for measured workloads.
5. **Escape hatch**: a field that gets very hot can be promoted to a real
   column later.

Not in the first release: typed SQL views per object and workspace
(`crm_views.<workspace>_<object>`) for people and BI tools. They are DDL per
workspace and per schema change, which is exactly what the JSONB design
avoids, and on the hosted cloud they would bloat the catalog. A self-hosted
install can add them later as an opt-in.

### 1.3 Memory

| Table                       | Holds                                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event_records`             | One row per event record: `occurred_at`, `channel` and `external_id` (unique per workspace and channel when set, so logging the same source twice is a no-op). Immutable once logged, except that erasure clears `channel` and `external_id` (2.1). A deferred trigger requires the row for every event record |
| `event_links`               | The records linked to an event, in the order logged. `link = 'participant'`: who took part, as a normalized `handle` (email or phone) and/or a `record_id`, a free-text `role`, and an `unmatched_reason` when no record was matched. `link = 'about'`: a record it concerns (only `record_id`)                |
| `event_identity_tombstones` | Keyed HMACs of erased event identities, with the ID of the key that made each (2.1). No raw channel, external ID, text or record ID                                                                                                                                                                            |
| `field_assertions`          | A claimed value for one field of one record: value, actor, source event (`source_record_id`), `is_initial`, confidence, `observed_at` (when the claim was true at the source), `status` (`active`, `superseded`, `pending_review`, `rejected`, `retracted`)                                                    |
| `facts`                     | Plain-language claims about a record: `content`, `kind` (`stated` or `inferred`), confidence, `valid_from` / `valid_to` (when it was true in the world), `superseded_by`                                                                                                                                       |
| `fact_sources`              | What a fact rests on: an event (`source_record_id`, with an optional quote the agent chose) or other facts (for inferences)                                                                                                                                                                                    |
| `event_moves`               | Each move of events to another event type: the actor, the two types, the event IDs and the field mapping, by ID and name, never values. Only ever added to                                                                                                                                                     |

`field_assertions.observed_at` and `facts.valid_from` come from the source
(rules 2.2 and 2.6); `valid_from` has no `now()` default, so backfilled
facts do not appear newly true. No v1 write path creates `inferred` facts,
premise-fact sources or `valid_to`; those columns are reserved.

Retainer stores what the agent chose to record, not the conversation itself.
A summary or quote is stored like any other value, so an agent should not put
in it what the workspace should not keep.

#### Events

An object type has a class. `entity` is the default: people, companies,
deals, anything with a lifecycle. `event` is something that happened at a
point in time and is logged from a source: a conversation (a meeting, call,
email thread or chat), or a type the workspace adds, such as a payment or a
site visit.
Events are records: they have fields, assertions, relation fields, views and
search like any other record, plus the built-in columns `occurredAt`,
`channel` and `externalId` from `event_records`, which `query_records` can
filter and sort by and a calendar view can use as its date.

**Object or event.** Something with a state that people change is an object:
a task, a deal, a ticket. Something that happened, reported by a source and
cited as evidence, is an event: a call, a payment, a form submission. A
change to an object is its history (assertions and the timeline), never an
event, and a person's remark about a record is a comment (below), never an
event. The `schema_design` guide gives agents this test with examples.

Every workspace has the base event type `conversation`, with a universal ID
(3.1). `note` is no longer in the base template, but keeps its universal ID,
so a template or agent that adds a `note` event type gets the same identity;
a workspace from before this keeps its notes and may delete the type. A
conversation's kind is its `medium` field, a
nullable, filterable select with the options `meeting`, `call`, `email`
and `message` (workspaces may add more), not its type: a field can be
corrected after logging with `upsert_record`, while an event's type changes
only by moving it, which a person does (below). `channel` and `medium` answer different
questions. `channel` is where the event came from, the source system or
account (`gmail`, `zoom`, `tamloot`); it is part of the identity, fixed at
logging, and must tell apart sources whose IDs could overlap. `medium` is
what happened; it is optional, and an agent that can't tell leaves it
empty. A workspace adds an event type only for events whose fields a
conversation would never use: a payment (an amount, an invoice), a form
submission, a site visit. Details such as duration, direction or a
recording link are optional fields on `conversation`. The base type is not
protected. `describe_schema` marks it with `baseObject` (`conversation`, or
`note` where one exists) and the medium with
`baseField: "conversationMedium"`, so clients find them after a rename. Creating an object with
`class: "event"` gives it two core fields, with roles `title` and
`summary`: searchable text, protected (1.1), and `title` is the label
field. The rest of an event type's fields are ordinary fields. The names
`type`, `occurredAt`, `channel`, `externalId`, `participants`, `about`,
`event` and `via` are reserved on event types.

Only logging creates events. `log_event` (`POST /v1/events`) takes `type`,
`occurredAt`, `channel`, `externalId`, `title`, `summary`, `fields` (the
type's other fields, by name), `participants` and `about`, and writes the
record, its `event_records` row, its initial field values and its links in
one transaction. `upsert_record` and record creation refuse event types
(`422 use_log_event`), but can correct an existing event's fields: later
edits are ordinary assertions with no source and the write time as
`observed_at`, ranked as usual. Events cannot be merged or suggested as
duplicates: each is something that happened, logged from its own source.

The values logging writes are the event's initial values: their assertions
are marked `is_initial`, cite the event itself as their source, and have
the event's `occurred_at` as `observed_at`. No other copy of the payload is
kept, so erasure has one place to clean (2.1).

Logging again with the same `(workspace_id, channel, external_id)` returns
the existing event when its type, `occurred_at` instant and initial values
are the same. A retry is compared with the initial assertions, not the
current values, so later edits never break it. Relation values are compared
after resolving merged record IDs to their survivors on both sides. A field
added since logging counts as absent from the original, so a retry that
supplies it conflicts; one that names a field deleted since logging fails
validation, like any write. Participants and `about` records the event does
not have yet are added, after the existing ones, and the response lists them
in `added`; nothing is removed this way, so retries, and syncs that log the
original list again, are no-ops unless a previously unmatched participant can
now resolve. Stored `no_match` and `phone_only` rows matching an input by key
are re-resolved in place, preserving link ID and position. A supplied record ID
is followed through merges; an email alone uses a fresh unique-claim lookup.
Successful resolutions are included in `added.participants.matched` alongside
new links. `suppressed` and `deleted_record` rows stay for people review;
rows stored as `ambiguous` require an explicit record ID among their current
candidates. For stored `no_match` or `phone_only` rows, an explicit record ID
remains authoritative even if email claims have changed; a retry that still
cannot resolve leaves the row unchanged.
This also applies to `POST /v1/events/:id/links`. A participant is the same
one when its role and handle match, or its role and record (after merges)
when it has no handle; an erased handle (2.1) matches another erased handle with the same
role. Adding a participant changes no field value or fact, only which
records list the event. A different payload returns `event_conflict`; it is
never silently ignored. Logging the identity of a deleted event, or one
erased by `forget`, returns `event_retracted`; restoring a source is not in
v1. Logging takes a transaction-scoped advisory lock on the identity, so
concurrent logs of one source create one event. `channel` must distinguish
source accounts when their external IDs can overlap. Without `external_id`,
callers do not get deduplication. An edited source needs a new
`external_id`; creating it does not retract the old source's claims; a
person deletes the old event (`DELETE /v1/events/:id`).

Participants are who took part, and `about` lists the records an event
concerns: the company, project or tasks of a meeting with Dana about the Acme
pilot. Both name entities only. A new `about` link to an event, or to the
event itself, is a 422 `invalid_link`; an event as a participant is a 422
`invalid_participants`; a participant's handle matches entities only. An
event is something that happened among entities, and what it means for
another event belongs in a comment or a field. Links to events from before
this rule still read and can be removed, the workspace upgrade logs how many
each workspace has, and retrying a call that names one already linked is a
no-op. The agent names `about` records explicitly. Retainer does not infer
them, for example from a participant's company, since that would move old
meetings when a person changes jobs. A record is linked once per event:
`about` skips a record already linked, a record added as a participant
replaces its `about` link, and a merge drops the `about` link that would
repeat another. Adding links locks every record involved `FOR KEY SHARE`,
as relation writes do (4.2), so a concurrent merge either commits first and
the link goes to the survivor, or waits and then moves the new link with
the rest.

A relation field on an event type, such as a call's `deal` or a payment's
`invoice`, also attaches the event to the record it points at. It follows
the current value: unlike `about`, a corrected relation moves the event.
Agents are told to prefer `about` for what an event concerns and to keep
relation fields for structure the type owns.

An event is attached directly to a record in three ways, and every list of
a record's events says which, as `via`: `{ kind: 'participant' }`,
`{ kind: 'about' }` or `{ kind: 'field', field }`. An event attached in
several ways appears once, with that precedence. `query_records` on an event
type takes `linked: { record, link? }` for these events, and
`GET /v1/records/:id/events` and context packs (6.2) list them across types,
newest first.

`query_records` with the reserved object name `event` (and
`POST /v1/events/query`) queries events of every visible event type at
once, newest first by default; internal notes are never included. It
filters and sorts on what every event type shares: `occurredAt`, `channel`,
`externalId`, `id`, `createdAt` and `updatedAt`, and filters on `type`
(event type API names, with `eq`, `neq` and `in`), with `search` over the records'
searchable text (the core title and summary, and any searchable fields of
the type) and `linked` as above. Rollups are not included; they stay with
`GET /v1/records/:id/events` and the timeline. A type's own fields, such as
`medium`, are returned but not filterable there, since they differ by
type: filter them with `query_records` on that type. Each item carries
`type` beside the presented record and its `event` details, and pages and
cursors work as for one object. With `include: ["relationReferences"]`,
the references cover relation values, participants, candidates and
`about` records.

#### Rollups

An owning relation field of an entity can set `rollUpEvents`. Then the
events attached directly to a record (any of the three ways) also appear in
the history of the records it points at through that field, with
`via: { kind: 'rollup', field, record }` naming the field and the record
they came from: a company sees the calls about its deals. It works for
single-record, `many_to_many` and polymorphic fields and needs no inverse.

- It is read-time: nothing is copied, so `update_field` turns it on or off
  at any time, as an additive change (no review), and a changed relation
  regroups the events at once. `via` describes the current grouping, never
  who took part back then; explicit participants and `about` are unaffected.
- One hop. What a record has only by rollup does not roll up again, and
  direction is always source to target. An event's own relation field
  attaches it (above) and does not use up the hop: a payment attached to an
  invoice through `payment.invoice` rolls up once through `invoice.company`,
  never onward through the company's `parent`.
- Events only: facts and field values stay on their record.
- An event appears once. A direct attachment wins over a rollup, and among
  several rollup paths the one with the smallest field ID, then source
  record ID, so the same `via` comes back on every read. Pages, counts and
  context budgets see each event once.
- It cannot be set on an inverse field, nor on an event type's fields.

A company with thousands of deals is a wide fan-out, so the query never
gathers it: it reads the incoming edges through `record_links_target_idx`
(workspace, target, field, covering the source), takes each live source's
own newest page of directly attached events (through `event_links
(workspace, record_id, link)`, the event types' relation edges and
`event_records (record_id, occurred_at)`), and merges those, deduplicated,
into one keyset page on (`occurred_at`, ID). An event's position among one
source's events is never later than its position overall, so that covers
the page and every path to its events. Context packs and
`GET /v1/records/:id/events` share it, and an integration test checks its
plan on a seeded fan-out.

The engine cannot prove a relation is stable, so the setting says nothing
about permanence. Template defaults leave it off on affiliations, ownership
and contact assignments (`person.company`, `deal.company`,
`deal.pointOfContact`, `property.owner`, `project.company`,
`project.primaryContact`, `proposal.company`, `job.company`, the task
relations), where reassigning should not regroup old events. They turn it
on only where a record belongs to its target and a change is a correction:
`appointment.person`, `viewing.property`, `viewing.person`,
`application.person`, `application.job` and `proposal.project`.

`POST /v1/events/:id/links` adds participants and `about` records to a
logged event by ID, with the same matching. Removing one
(`DELETE /v1/events/:id/participants/:participantId` or
`/about/:recordId`) is a person's decision, like other changes that hide
data: an agent's key gets 403.

#### Internal notes

Every fact cites an event (rule 2.1). When `remember` gets no `source`, it
logs an internal note: the fact's text as its summary, the record as its
one `about` link, channel `retainer` (which `log_event` rejects). Internal
notes are records of their own hidden, protected event type with a fixed
universal ID, not of a workspace's own `note` type, so hiding them is one
check in object resolution rather than one on every path: `describe_schema`
omits the type; query, view, search, record and write routes resolve it as
not found; context packs and event lists never include it. Its records
change only through `remember` and the fact and privacy lifecycle. A fact
presents such a source as `{ event: null, internal: true }` instead of an ID
callers cannot read. Events a workspace logs as a `note` type are ordinary
events.

#### Workspace and personal memory

Two more hidden, protected types with fixed universal IDs hold what is not
about a CRM record ([personal memory spec](docs/specs/user-and-workspace-memory.md)).
Both are entities with no fields; their records hold facts only.

- The **workspace profile** (`workspace`): one per workspace, seeded at
  creation and on upgrade. How the business works; everyone sees it.
- The **member profile** (`me`): one per member per workspace, created by
  the first write to `me`, with `records.private_to_user` set to that
  person. What agents learn about the person they work for.

Agents name them by alias in `remember`, `get_context`, `get_timeline` and
`GET /v1/records/:id/facts`; every other record route answers `422
profile_not_supported`. A profile's label is computed (the workspace's
name, or the person's), and its search text is empty: its facts are
searched like any other fact.

`private_to_user` is on `records`, `facts`, `fact_sources`,
`field_assertions`, `event_records`, `event_links` and `idempotency_keys`.
Child rows copy it from their parent through triggers, and a write under a
parent the writer cannot see fails. It never changes once set.

`facts.replaced_at` marks a fact `remember` replaced with `supersedes`
(rule 2.6): it leaves current memory for good, keeps its history, and is
never revived.

#### Comments

A comment is plain text a person writes on any record, entity or event, to
the people working with it: "is this the right email?", "don't contact him
before January". It lives in its own `comments` table (`record_id`, `body`
up to 10,000 characters, `author`, `created_at`, `updated_at`, `edited_at`,
`deleted_at`, `deleted_by`), with row-level security like every workspace
table. It is not an event and not an assertion, so:

- **Never evidence.** Nothing can cite one. It is outside the Activity feed,
  the events query, timelines, context packs and fact sources. A fact in a
  comment becomes memory only when something writes it through
  `upsert_record`, `log_event` or `remember`, and the guides tell agents so.
- **Only people write.** The actor must be `user`, whatever the key's scopes;
  anyone else gets 403 with a message naming what to use instead. Agents and
  integrations read them, with `get_record` (the newest 20 and a total) and
  `list_comments`.
- **Who changes what.** The author edits (a `write` key is still needed, and
  `edited_at` says so). The author, or a `user` with `admin`, deletes.
  Deleting is soft and records `deleted_by`, like other deletes (2.1).
- **Following the record.** A merge moves the loser's comments to the
  survivor, under the same `FOR KEY SHARE` locks as links (4.2), so a comment
  racing a merge lands on the survivor. They go with a deleted record, and
  `forget` hard-deletes them, including soft-deleted text (2.1).
- **Retries.** `Idempotency-Key` is honored on add, edit and delete, and is
  bound to the actor as well as the body.

#### Moving events between types

`POST /v1/events/move` and the `move_events` tool change the type of logged
events: one or more named events of a type, or every live event of it, for
example the `meeting` and `call` types a workspace used before `conversation`
existed. Deleting and re-logging is no substitute: deletion retracts what
cites the events and keeps their identities suppressed, so a source could
never again be deduplicated against them.

What stays: the record ID, the `event_records` row (`occurred_at`, `channel`,
`external_id`), participants and `about` links, every assertion and fact
citing the event, and so its place in timelines and context packs. What
changes is `records.object_type_id` and the fields the event's own
assertions belong to:

- **Mapping.** Core `title` and `summary` map to the target's by role. Other
  active fields map to the target field of the same name, or to the one the
  caller names (`fields`). A field maps only to one of the same type (and, for
  a relation, the same multiplicity), and two source fields never map to one.
  Assertions are moved, never data: every assertion of a mapped field, of any
  status, is re-pointed at the target field with its actor, source,
  `observed_at` and `is_initial` unchanged. `records.data`, `record_links`,
  `record_identifiers`, label and search are then rebuilt from them (rule
  2.4), so ranking is exactly what it was.
- **Values that would be lost.** If a source field with any assertions on
  the moved events has no target field, or its active, superseded or pending
  values do not fit the target field (an option it lacks, a relation to a
  record it cannot point at, a value past its limits), the move is refused
  with the list (`unmapped_fields`). The caller maps the field, or names it
  in `drop`, which deletes its assertions on those events. Nothing is dropped
  unless named. This was chosen over dropping by default because a value
  that vanishes on a move cannot be recovered. Assertions of fields the
  source type had already deleted stay as that field's history; they never
  counted for the source type and never count for the target.
- **Defaults.** `defaults` gives target fields the moved events have no value
  for, such as `medium: "meeting"`. They are written as the event's initial
  values, citing the event, observed at `occurred_at`, by the caller. The
  old type carried that information when the source was logged, so a
  re-log of the source as the new type with that value matches the moved
  event (retries compare initial values, above).
- **Refusals.** Moving between an event type and itself, an entity, or the
  hidden internal-note type (it resolves as not found); a required target
  field left empty on any event (`invalid_values`); a moved value of a
  unique field another record claims (`unique_conflict`, rather than the
  silent review rule 2.4 uses for retractions); and records whose active or
  superseded relation claims point at the events through an active field
  that cannot target the new type (`referenced_by_relations`), since a
  relation's targets never change (1.1) and a retraction restores a
  superseded claim without checking its target again. A deleted field is
  never recomputed, so its links do not block a move.

A move needs a `user` actor with the `admin` scope, the rule for destructive
schema changes (3) and `forget` (2.1): the request is the approval, and an
agent's key is not, whatever its scope. It is not a schema change, since no
object or field changes, so it is not stored as a proposal: approving a
stored "move every meeting" later would move events logged since, which the
approver never saw. Instead anyone with `schema:write` can run it as a dry
run, the same code in a transaction that is rolled back, and show a person
exactly what it would do; the person then runs it. Each move is logged in
`event_moves`.

A move takes the workspace schema lock exclusively (3), so no write runs
while it does: every write takes that lock in shared mode before reading
the record or field it writes, so none can write an assertion against a field
the events are leaving. The moved events are also locked `FOR UPDATE`, in ID
order. Moving every event of a type is one transaction: all of them move or
none do. Once a type has no live events, deleting it deletes nothing.

### 1.4 Views

A view is a saved way of looking at one object's records: a table, a board
grouped by a select field, or a calendar on a date field. Views are display
settings, not CRM data. They have no provenance, are not assertions and do
not go through the schema engine; changing one never changes a record.

| Table   | Holds                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `views` | Object, name, `kind` (`table`, `board`, `calendar`), `visibility` (`workspace`, `private`), `position` in the object's list, `config`, actors |

`config` is JSON validated on every write:

| Key              | Holds                                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `filter`         | A query filter (5), as `POST /v1/objects/:object/query` takes it                |
| `sort`           | Up to three sort keys                                                           |
| `columns`        | Visible fields in order, their widths and each column's footer calculation      |
| `groupBy`        | Board: the `select` field whose options are the columns                         |
| `hiddenGroups`   | Board: option values (or `null` for "no value") whose columns are hidden        |
| `groupAggregate` | Board: one calculation shown in every column's header, e.g. the sum of `amount` |
| `dateField`      | Calendar: the `date` or `date_time` field records are placed by                 |

Rules:

1. **Fields by key.** Stored config names fields by `fields.key`, like
   `records.data`, so renaming a field never breaks a view. The API reads
   and writes field names and translates both ways.
2. **Repaired by the schema change.** Board columns are the group field's
   options as they are when the view is read, so adding or relabelling an
   option needs no change to any view. A schema change that removes a
   field, stops a field being filterable, or removes an option rewrites the
   object's views in the same transaction: the field leaves columns and
   sort, a filter condition that no longer compiles goes, a removed option
   leaves `in` lists (a condition naming nothing else goes), hidden columns
   lose removed options, and a `groupBy` or `dateField` that no longer fits
   is cleared. The view stays, so a board or calendar left without its field
   asks for a new one. Every record has a board column, because the engine
   refuses to remove an option records hold or make a field required while
   records lack it. Reads apply the same repair as a safety net, listing
   anything they drop in the view's `issues`.
3. **Validated like queries.** `filter` and `sort` must compile against the
   current schema, as a query would. `groupBy` must be a filterable `select`
   field and `dateField` a filterable `date` or `date_time` field, because
   each board column and calendar month is a filtered query.
4. **Visibility.** A `workspace` view is visible to every key in the
   workspace and editable by any key with `write`. A `private` view is
   visible and editable only by the actor that created it; to anyone else it
   does not exist (404). Only the creator can change a view's visibility.
5. **Card order is not stored.** Cards in a board column and records on a
   calendar day follow the view's `sort`. Manual ordering would need a
   position that is not a fact about the record, so it is not a field value
   and is not in v1.
6. **Moving a card is a record write.** Dropping a card on another column
   (or a calendar day) is a normal `PATCH /v1/records/:id` of the group (or
   date) field by the person who moved it. It follows every write rule (2),
   so it can come back `pending_review` or `superseded` rather than applied.

Deleting a view removes its row; there is nothing to retract. Deleting an
object deletes its views with it.

---

## 2. Write rules

1. **Nothing is written without an actor and, for derived data, a source.**
   A field write may cite an event as its source (`source` on
   `upsert_record`); without one, the actor is the source. Every fact cites
   an event: the agent passes one, or `remember` creates an internal note
   for it (1.3). A source must be a live event record of a visible type in
   the same workspace: an entity is refused (`invalid_source`), a deleted
   event too (`source_retracted`).
2. **Precedence decides a field's value**:
   `user` > `integration` > `agent` > `system`. Within the same precedence,
   the assertion with the latest
   `observed_at` wins (the source event's `occurred_at`, or the write
   time for direct writes), then server-assigned `created_at`, then assertion
   ID as a deterministic tie-breaker. This prevents an old email from
   overwriting a newer claim at the same precedence. Higher-precedence claims
   remain authoritative until explicitly changed. Clearing a nullable field
   is an assertion with a `null` value; missing keys mean no change. Composite
   fields are replaced as a whole in v1, including their additional values.
   `observed_at` is set by the server: the cited event's `occurred_at`,
   or the write time when no event is cited. Callers cannot set it
   directly.
3. **Agents never silently overwrite people, and are never silently
   ignored.** If the winning assertion is a `user` or `integration` one and
   an agent asserts a different value with a newer `observed_at`, the agent's
   value is stored as `pending_review` and does not change `records.data`.
   (Otherwise "Dana moved to Globex" from last week's email would lose to a
   months-old CRM sync and vanish into `superseded`.) An older or equal agent
   value is simply `superseded`. An agent assertion below the workspace's
   confidence threshold is also `pending_review`. Accepting a pending
   assertion re-asserts it with the reviewing user as actor and retaining its source provenance
   and `observed_at`, so a value a person set after the source still stands. Acceptance
   requires a `user` actor with write permission, not an agent choosing a
   reviewer identity.
4. **The value is always recomputable.** For each field, the winner among
   `active` and `superseded` assertions is `active`, the rest `superseded`;
   `records.data[key]` is the winner's value (relation winners instead produce
   `record_links`). With no eligible assertion the key/edge is absent.
   `pending_review` and `rejected` assertions never count. Source retraction
   makes its derived assertions ineligible and recomputes affected fields;
   it cannot let an older `superseded` claim from that source win again.
   Retraction sets every `active`, `superseded` or `pending_review`
   assertion citing the source to `retracted`, which never counts again,
   and recomputes the fields where one of them was winning. If the value
   that would win again is now claimed by another record (1.2), it becomes
   `pending_review` (reason `unique_conflict`) and the next one wins, so a
   retraction always takes effect.
5. **Writes to one record are serialized.** A write locks the record row
   (`SELECT … FOR NO KEY UPDATE`; merges, deletes and retraction take
   `FOR UPDATE`), inserts its assertions, recomputes only the
   touched keys, and updates `data`, `record_links` and `record_identifiers`
   in the same short transaction. Nothing does read-modify-write on `data`
   outside that lock, so two agents writing the same record never lose each
   other's values. Multi-record writes lock records in sorted
   ID order. An optional expected `updated_at` precondition rejects stale
   direct edits; serialization alone does not detect a stale agent's intent.
6. **Facts are never deleted by the system, only superseded.** Two times are
   kept apart: `valid_from` / `valid_to` say when a fact was true in the
   world; `created_at` says when it was recorded. `valid_from` is the cited
   event's `occurred_at`, or the write time for the internal note that
   `remember` creates; v1 takes no separate effective date. Supersession
   records a correction and preserves provenance. An agent supersedes a fact
   itself with `remember`'s `supersedes`: on the same record the new fact
   corrects it, elsewhere it moves it (and copies its citations). The
   replaced fact gets `superseded_by` and `replaced_at`. Facts move between
   records the caller can see; a private fact never moves to a shared place,
   and a fact never moves between two people. A person can retract a
   fact (soft delete) or hard-delete data for privacy (2.1). Exact historical
   belief snapshots are deferred: the schema has no supersession-event
   timestamp or append-only history of validity edits.

### 2.1 Deletion and privacy

Soft delete (`deleted_at`) is the default for records, events included,
and facts. Reads exclude deleted parents as well as deleted rows: a
record's facts are hidden with it, and links to a deleted record drop out
of an event's participants and `about`. Deleting an event
(`DELETE /v1/events/:id`, or `DELETE /v1/records/:id` on one) also retracts
the claims that cite it and recomputes field winners, and returns how far
that reached; the event's own initial values are not retracted. Facts with
other live sources may remain; a fact with no live source is hidden on
read. Deleting an event type deletes its records through the same
lifecycle, in the same transaction.
A write citing an event (including accepting a pending claim from it)
locks it `FOR KEY SHARE` before locking any record, and deletion locks it
`FOR UPDATE` before locking the affected records, so a claim either commits before the deletion (and is retracted
with the rest) or sees the source deleted and fails.
Restoring a source is not in v1; when added, it must revalidate its derived
claims before exposing them.

`forget` (admin scope) is the hard delete for privacy requests. First collect
the record's identifiers, participant events, dependent facts,
assertions and inbound relation assertions, before cascades or `SET NULL`
can erase those dependencies. Then, in a coordinated deletion operation:

1. add normalized emails and phones to a workspace suppression list using a
   keyed HMAC (a plain hash of a guessable email/phone is insufficient);
2. hard-delete events it took part in and the internal notes `remember`
   wrote about it, with their source quotes, and remove their assertions and
   facts that have no live source. An event that is only `about` the record
   (a meeting about a company) is someone else's conversation: it stays, and
   only the link is deleted. An erased event's identity is replaced by a
   tombstone (below);
3. invalidate inbound relation assertions (removing the record from sets)
   and recompute surviving records'
   field values, links, identifiers and search text. A surviving event whose
   initial values this erases loses its `channel` and `external_id`, which
   are caller-chosen strings that may identify the person, and gets a
   tombstone when it had an external ID;
4. hard-delete the record, its assertions, facts, links, identifiers and
   comments, including deleted comments' text, and any stored idempotency
   response that repeats one;
5. write a minimal audit entry (actor ID, time, counts), without copied names,
   handles, summaries, quotes or field values.

Writes coordinate with deletion: creating a record or resolving a
participant checks suppression in the same serialization boundary as
`forget`, so a suppressed email or phone cannot come back. Jobs carry IDs
only, and must not resurrect deleted content. Delete idempotency responses
and error text containing erased content too.

How this is built:

- **Who.** `forget` needs the `admin` scope and a `user` actor; an agent
  with an admin key cannot erase a person.
- **What it covers.** The record and every record merged into it. Its
  handles are its current email and phone identifiers, every email or
  phone it was ever claimed to have, and the handles of events it was
  matched in. It "took part in" an event when a participant link points at
  it or carries one of those handles. A forgotten event record is erased
  as an event.
- **Boundary.** A workspace advisory lock. Every write takes it in shared
  mode after the schema lock; `forget` takes it exclusively, so it waits
  for in-flight writes and blocks new ones until it commits. A record
  write with a suppressed email or phone fails with `409 suppressed`,
  naming the field but not the value. A suppressed participant handle is
  stored as `null` with the reason `suppressed`.
- **Key.** The HMAC key is `RETAINER_SUPPRESSION_KEY` (at least 32
  characters), kept outside the database so a dump alone does not reveal
  the handles. The HMAC covers the workspace ID, kind and normalized
  handle. Without the key, `forget` fails with `503 not_configured`; if a
  workspace already has suppressions, writes that could add a handle fail
  closed. To rotate the key, set the new one and list the old ones in
  `RETAINER_SUPPRESSION_PREVIOUS_KEYS`: lookups try every key, so earlier
  suppressions keep matching. Dropping an old key without listing it
  forgets the handles it suppressed.
- **Event identities.** A tombstone stores the workspace, the key's ID and
  a keyed HMAC of the JSON encoding of `(workspace_id, channel,
  external_id)` under a domain separator of its own, so it never equals a
  handle's HMAC. It is a retained suppression token, not anonymization.
  `log_event` checks it, under the identity's lock and the shared privacy
  lock, before creating an event or adding retry links, and returns
  `event_retracted` on a match. A tombstone made with a key that is no
  longer configured cannot be checked, so logging in that workspace fails
  closed with `503 not_configured` until the key is listed again. Events
  without an external ID get no tombstone and no deduplication guarantee.
- **Idempotency.** Stored responses whose text contains an erased record,
  event or fact ID are deleted.
- **Response.** IDs and counts only: records, events, facts and assertions
  deleted, inbound relations removed, handles suppressed, the records
  recomputed, and review candidates (other live records, facts and events
  matching the name by phrase search or a handle by text).
- **Shared phones.** The check skips handles the written record already
  holds, so another live record that shares a suppressed phone keeps it
  and can still be edited, but no other record can add it.

Facts on other records that mention the person but rest on other sources
("Acme's champion is Dana") cannot be found reliably. Collect candidates by
name and identifier search before deletion and return their IDs for human
review. This is a deletion workflow, not a guarantee that every mention is
found. Backup retention and deletion after restore are the operator's
responsibility. Suppression entries remain personal data with restricted
access and a documented retention policy.

Shared events are deleted whole (step 2), even when other people took
part. This is the simpler rule and fully removes the person's words, at the
cost of losing what that event said about the others. Redacting only
the person, or keeping other people's facts with a "deleted for privacy"
source, is a possible later refinement.

`forget` erases a record, not an actor. The name stored with each write
(`{ type, id, name }`) stays after the person who made it leaves the
workspace: the history is the workspace's audit trail (accounts spec 9.5).

Workspace deletion cascades through `workspace_id` and removes everything.
In accounts mode deleting a workspace first only sets `deletion_scheduled_at`:
every lookup (keys, sessions, OAuth tokens, the consolidator) then treats it
as gone, an operator can restore it, and 7 days later a scheduled run of the
control function deletes it for good, one workspace per statement, holding
the deploy lock like a consolidator pass.

---

## 3. Schema engine

One entry point for every schema change, whoever makes it (seed, upgrade,
person or agent). Same pattern as Twenty's migration engine:

1. **Load** the workspace's current schema, holding the workspace's
   exclusive schema lock (below) so schema changes in one workspace run one
   at a time.
2. **Apply** the requested operations in memory to get the desired schema.
3. **Validate**: name collisions, reserved names, relation targets, option
   values, type rules.
4. **Diff** current against desired into a list of operations.
5. **Classify** each operation:
   - Additive: create object, create an optional non-unique field, add or
     relabel a select option, change a label, description or label field,
     mark a field filterable/searchable.
   - Destructive: everything else: rename, remove option, delete field or
     object, add a required or unique field, change a field's required or
     unique flag either way, unmark filterable/searchable.
   - Not supported in the first release: changing a field's type. Create a
     new field and deprecate the old one instead.
6. **Apply or propose** (any change needs the `schema:write` scope):
   - All additive: apply in one transaction (metadata rows and
     `schema_version + 1`). No per-field index jobs in v1.
   - Destructive, requested by a `user` actor with `admin` scope: apply
     directly; the request is the approval.
   - Destructive, requested by anyone else (including an agent holding an
     `admin` key; scope alone is not human approval): store as `proposed`
     in `schema_changes` for such a user to approve or reject. Seed/upgrade
     operations use an explicit trusted administrative path and cannot
     bypass this rule on an agent's behalf.
   - Approving re-runs the engine against the schema as it is then, since it
     may have changed since the proposal. If it no longer validates, the
     change is marked `failed` with the error.

Making a field unique or required first checks existing records; if any
violate it, the change fails with the offending record IDs. Adding a
required or unique field is subject to the same check and approval, not an
additive shortcut. Record writers take a shared transaction-level advisory
lock keyed on the workspace (`pg_advisory_xact_lock_shared`) before record
locks; schema changes take the exclusive form, so a write cannot race the
check or commit against stale schema. Moving events between types (1.3)
takes the exclusive form too. Advisory locks, not `FOR SHARE` on
the workspace row: every write share-locking one hot row creates MultiXact
churn, and schema changes also update that row (`schema_version`). Unique
claims are populated atomically when uniqueness is enabled.

In v1, deleting schema metadata means deprecating it and hiding it from new
writes, not cascading away assertions. Deleting an object also deprecates
relations that point at it; protected objects and fields (1.1) and an
object's label field cannot be deleted. Removing an option needs approval
and fails while live records use it. A relation's target, cardinality and `onDelete` are fixed once
created; there is no operation to change them.

Standard objects ship as code (definitions with fixed `universal_id`s) and
are applied through the same engine, on its trusted path, when a workspace
is created.

**Upgrading existing workspaces.** After migrations, wherever they run (the
container's start, the AWS ops function's `migrate`), the server brings every
workspace up to the definitions of its release: the seed (base objects, base
event types, the internal-note type) and each template the workspace
applied. Elements are matched by `universal_id` whatever their status, so a
renamed element is found and one the workspace deleted is not re-created.
Only what the workspace never had is added: objects with their fields, and
fields of objects it still has. Options, labels, flags and settings of
existing elements are left as they are. The trusted path also protects every
element the protection lists (1.1) name, which workspaces created before
protection lack. An element the workspace's schema cannot take, such as a
base type whose name its own object already uses, is skipped and logged as a
conflict; everything else still applies. Each upgrade is one schema change by
`system:retainer`, run under the workspace's exclusive schema lock.
`workspaces.definitions_digest` records the definitions a workspace was last
fully upgraded to, so a run skips current workspaces without loading their
schema and retries conflicted or failed ones. A workspace that fails is
reported and keeps its schema; the others still run
(`docs/specs/workspace-upgrade.md`).

### 3.1 Base objects and templates

Every workspace is created with three base objects: `person` (name, emails,
phones, address, job title, company), `company` (name, domain, address,
people) and `task` (title, status, due date, assignee, person, company),
the base event type `conversation` (with `medium`), and the hidden
internal-note type (1.3). Nobody builds a workspace from scratch.

Templates add the objects and fields a kind of business needs. They ship
as code in `packages/server/src/templates/`, with fixed `universal_id`s
like the base objects, and are applied through the schema engine as owner
`system`. Every template operation is additive, so applying one never needs
approval.

| Template      | For                                     | Adds                                                                                                                                |
| ------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sales`       | B2B sales teams, founders selling       | `deal` (stage, amount, close date, company, point of contact); `company` gets industry and employee count                           |
| `services`    | Agencies, consultants, freelancers      | `project` (status, budget, start and end dates, company, primary contact); `proposal` (status, amount, sent date, company, project) |
| `clinic`      | Clinics, therapists, wellness practices | `appointment` (date and time, type, status, person); `person` gets date of birth and preferred channel                              |
| `real_estate` | Agents and brokers                      | `property` (address, type, price, status, owner); `viewing` (date, status, property, person, feedback)                              |
| `recruiting`  | Recruiters, hiring teams                | `job` (title, status, company); `application` (person, job, stage, source)                                                          |
| `blank`       | Anything else                           | Nothing; the agent extends the base objects itself                                                                                  |

**Choosing a template on init.** A new workspace has no template applied
unless the operator passed `--template` (7.1), and `describe_schema` says so (`initialized: false`). An agent that sees this
follows the `discover_schema` guide (6.2): it looks at its user's data,
proposes the closest template plus any additions, and applies them once the
user agrees. Without that, it calls `list_templates`, picks the closest one
from what it knows about the business, or asks its user when it is unsure,
and calls `apply_template`. Choosing `blank` marks the workspace initialized without
adding anything. An agent that cannot decide should not guess: base objects
work without a template, and a template can be applied later.

**Later.** Templates are additive, so a workspace can apply a second one
later (a consultancy that starts recruiting). If a template's object or field
name collides with an existing custom one, applying it fails validation and
the error lists the collisions; nothing is half-applied. Applying a template
the workspace already has is a no-op, whatever its version; a release that
changes a template adds its new objects and fields to workspaces that applied
it when they are upgraded (3), and records the new version.

The workspace records which templates it has applied, with their versions
(`workspaces.templates`).

---

## 4. Runtime

```
 AI agents ── MCP ───┐
 Apps / SDK ── REST ─┤──► API server ─────────────► Postgres
 Integrations ───────┘                              schema · records ·
                                │                     memory · job queue
                                ▼                          ▲
                            Workers ───────────────────────┘
                            └─ consolidate (scheduled)
```

One Docker image, started with a role: `api`, `worker`, `control` (accounts
mode, 7.3) or `all`.
Postgres is the only dependency, with the standard `pg_trgm`, `btree_gin`
and `unaccent` extensions for search (5.1); the job queue runs on Postgres
too. Retainer calls no language model and needs no model API key.

The same code also runs as AWS Lambda functions
(`packages/server/src/lambda/`), which is how the hosted service runs; its
infrastructure lives outside this repo. `api` serves the Hono app behind API Gateway,
`consolidate` makes one consolidator pass per scheduled run, and `ops` runs
migrations and the operator CLI. What the container does on start
(migrations, the first-boot key, the search rebuild) the deploy does once
through `ops`, with the API stopped, so a cold start never migrates and no
key is printed to the logs. In accounts mode a `control` function serves
`/account` (7.3), and an hourly scheduled run of it removes workspaces whose
deletion is over 7 days old (2.1); in a container the `control` or `all`
process does that. With `RETAINER_EDGE_SECRET` set, `api` and `control`
expect CloudFront in front of API Gateway: they refuse requests without that
secret in `x-retainer-edge-secret`, so none bypass the edge's per-client
limits, and take the caller's address from `CloudFront-Viewer-Address`.

### 4.1 How memory gets written

The agent reads the conversation with its own model and decides what is
worth keeping. Retainer only stores, validates and resolves. After a
meeting, call or email thread, an agent typically:

1. **Logs the event** with `log_event`: its type (`conversation`, with a
   `medium`, unless the workspace defines a type for that kind of event),
   channel, time, title, its own short summary, the type's other fields, the
   source's external ID, the
   participants as handles (emails, phones) and/or record IDs, and in
   `about` the records it concerns (1.3).
2. **Updates records** with `upsert_record`, citing the event as `source`
   so the values carry its date and provenance (rule 2.2).
3. **Stores facts** with `remember`, citing the same event and an optional
   quote.
4. **Creates tasks** someone committed to, as `task` records.

Participants are resolved synchronously when the event is logged:
handles are normalized (lowercased email, E.164 phone) and matched against
unique identifiers in `record_identifiers`. Matched participants are linked;
the response lists the unmatched ones so the agent can create those people
itself or leave them. After creating a person, the agent re-logs the same event
with the same handle and role plus the new record ID to link that participant.
Retainer never creates records on its own. Phones are not unique (numbers are shared and reassigned), so a participant known only
by phone stays unresolved unless the agent passes its record ID. Matching a
phone held by exactly one live record is a later option.

A record ID the agent passes, as a participant or in `about`, is used as
given, after following merges; an unknown or deleted one fails the call,
since the agent named it explicitly.
An email claimed by several live records (two unique email fields on
different objects) is not matched to any of them: it comes back `ambiguous`
with the candidates (1.2). `occurred_at` must carry a UTC offset and may not
be in the future (beyond a few minutes of clock skew): it decides precedence
(rule 2.2), so a time-zone slip would otherwise let a claim win for hours.

Each write is its own short transaction, and each follows the write rules,
so an agent that stops halfway leaves consistent data; it can resume, and
`external_id` and idempotency keys (6.2) make retries safe.

### 4.2 Consolidator (scheduled per workspace)

- Supersede exact duplicate facts (same record, same normalized text and
  validity interval) with a canonical fact, retaining the originals and all
  source links. Identical text at different effective times may describe
  separate events and is not an exact duplicate.
- Near-duplicates are never superseded in v1; they stay separate claims,
  each with its own wording, dates and citations.
- Contradictions remain separate, cited claims unless a user or an explicit
  correction in the source resolves them; model confidence alone cannot
  silently supersede a claim.
- Suggest merges of duplicate records (same person, two records), found
  through shared identifiers and similar names. Suggestions only; a `user`
  actor performs the merge (an agent's key scope is not human approval, as
  in 3). Suggestions are stored as rows (`merge_suggestions`: the two
  record IDs, reason, status) so `GET /v1/review` can list them.

Flagging stale field values is deferred: "stale" has no definition yet and
nothing reads the flag.

How this is built:

- **Scheduling.** The queue is Postgres. Every minute, a worker asks the
  `SECURITY DEFINER` function `retainer_workspaces_due(interval)` which
  workspaces last ran longer ago than `RETAINER_CONSOLIDATE_INTERVAL_MINUTES`
  (default 60). It runs each workspace in one transaction, under a
  per-workspace advisory try-lock, so several workers never run the same
  workspace twice. `consolidator_runs` holds the last start, the stats, and
  `compared_until`. A run holds the privacy lock (2.1) in shared mode.
- **Exact duplicate facts.** Duplicates are current facts of the same live
  record with equal text after trimming, collapsing whitespace and
  lowercasing, and equal `valid_from` and `valid_to`. The oldest is the
  canonical fact. It gains each duplicate's source links; the duplicates
  keep theirs and get `superseded_by`. The facts are locked and the groups
  found again before writing, so a fact retracted meanwhile is skipped.
- **Merge suggestions.** Two live records of the same object are suggested
  when they share an email, phone or website domain identifier
  (`shared email`, `shared phone`, `shared domain`), or when their labels
  have a pg_trgm similarity of at least 0.6 and are at least three
  characters long (`similar names`). The reason never copies values. Only
  records updated since the last run's `compared_until` (its start minus
  five minutes) are probed, and each kind adds at most 500 new suggestions
  per run; pairs that already have a row don't count toward that. A run
  that reaches the cap keeps the previous `compared_until`, so the next
  run picks up the pairs it left. A pair keeps one row, so a dismissed or accepted pair is never
  suggested again. When a record is merged away or deleted, its other
  pending suggestions are closed as `dismissed` in the same transaction,
  so review only lists live pairs. The facts pass likewise compares only
  records that gained a fact or changed since `compared_until`.
- **Dismissing.** `POST /v1/review/merges/:id/dismiss`, as a `user`.
- **Merging.** `POST /v1/records/:id/merge` with `{ "recordId": "<B>",
  "values"?: {…} }`, as a `user` with the `write` scope; `values` overrides
  any field. It takes an `Idempotency-Key`. Merging the record in the path
  into itself is `422`. If B is already merged into A it is a no-op
  (`merged: false`); if A was merged into B it is `409 record_merged`. On
  success the pair's pending suggestion becomes `accepted`, and records
  previously merged into B now point at A, so every merge chain is one hop.
  Only the fields B had claims for are recomputed.
- **Locks.** Ordinary writes lock their record `FOR NO KEY UPDATE`, and a
  relation write locks its target `FOR KEY SHARE`, following merges. A
  merge locks A and B `FOR UPDATE`, which waits for both. So a link to B
  written during a merge either commits first and is rewritten, or waits
  and then points at A. A relation write locks source then target, while
  merges and cascading deletes lock targets first, so the two can deadlock;
  any write Postgres aborts for a deadlock is rolled back and run again
  (up to three times). A merge that loses a race to another merge is
  retried too.
- **Self-links.** No field disallows them in v1, so a relation from A to B
  becomes a link from A to A.

**Merging** record B into A moves B's assertions, facts, links, identifiers
and participant matches to A, recomputes A's values with the normal write
rules, and soft-deletes B with `merged_into_id = A`. Reads of B return A.
The merge is one transaction locking both same-workspace, same-object
records in sorted ID order. Rewrite inbound relation assertions as well as
edges, preserving their provenance; reject self-links where disallowed.
Resolve canonical IDs before merging, prevent cycles, and revalidate unique
claims before committing. Otherwise a later cache rebuild undoes the merge.
Because composite assertions replace whole values, merely moving B's
identifiers would lose them on recomputation. For `emails`, `phones` and
`links`, the merge writes a composite assertion as the merging user: combine
the two current winners, deduplicate, keep A's primary if present (otherwise
B's), and place the remaining values in `additional`. The request may
override these defaults. Exceeding a field's `maxValues` fails for explicit
resolution; nothing is silently truncated. Other composites (`money`,
`full_name`, `address`) have no `additional` array and follow normal
whole-value precedence unless the request explicitly overrides them.
Identifiers are rebuilt from the resulting winners. Only current winners
are combined, never the full assertion history.

Not in the first release: inferring facts from other facts
(`kind = inferred`). The schema keeps the `kind` column and premise links
so it can be added without a migration.

### 4.3 No language model inside Retainer

Retainer never calls a language model or an embedding provider. Every
judgment about what a conversation means is made by the agent, with the
agent's own model. This keeps self-hosting free of model keys and LLM cost,
keeps full conversations with the agent, and keeps Retainer's behavior
deterministic and testable.

---

## 5. Read paths

| Operation                          | What it returns                                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe_schema`                  | The workspace (ID, name, applied templates, `initialized`), its objects and fields, and `builtIns`                                                 |
| `query_records`                    | Structured filter, sort and pagination over one object; for an event type, its built-in columns and `linked`; `event` for every type at once (1.3) |
| `get_record`                       | One record with its fields and links; an event also with its built-in columns, participants and `about`                                            |
| `search`                           | Keyword search (Postgres full-text) across records, events and facts                                                                               |
| `get_context(record, tokenBudget)` | A ready-to-use pack: key fields, current facts, open tasks, recent events, fitted to the budget                                                    |
| `get_timeline(record, filters)`    | The record's history, newest first: events, asserted field values and facts (6.2)                                                                  |

`builtIns` lists facts, apart from `objects`, so a person reading the
schema sees that the workspace keeps them and no client mistakes them for
something `upsert_record` writes. Event types are objects of class `event`
(1.3); the internal-note type is never listed. `valueFormats` says how to
write a value of each field type the objects use, from `FIELD_VALUE_FORMATS`
in `@retainer/shared`, whose object keys come from the schemas the validator
parses with; an invalid composite value's error repeats it as `expected`.

Filter values are checked against their column or field type before any
cast: record IDs, ISO 8601 times with a UTC offset, and dates in years 0001
to 9999, which is also the range writes accept. A malformed value is
`422 invalid_filter` naming the field, never a failed cast.

Every read hides soft-deleted parents/rows and superseded facts by default.
An explicit history mode can list retained assertions and facts with their
source and validity dates; exact `as_of` snapshots are deferred. Context
packs distinguish stated facts from current field values and show who wrote
each. They are assembled by rules (recency, precedence, the token budget),
not summarized by a model; summarizing is the agent's job.

### 5.1 Search

Search is Postgres full-text search, plus three standard extensions that
ship with Postgres and are offered by managed services: `pg_trgm` (fuzzy
name matching), `btree_gin` (combined indexes) and `unaccent` (accent
folding). No embeddings, no BM25 extension.

#### What is indexed

| Source    | Search text                                                                                                                                     | Column and index                                     |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `records` | Values of `is_searchable` fields, plus the domain of each email and link; the label field (usually the name, an event's title) weighted highest | `search tsvector`, GIN on `(workspace_id, search)`   |
| `records` | The label field as plain text, e.g. "Dana Levi"                                                                                                 | `label text`, trigram GIN on `(workspace_id, label)` |
| `facts`   | `content`                                                                                                                                       | `search tsvector`, GIN on `(workspace_id, search)`   |

The server computes every `search` and `label` value in the same
transaction that writes the row (for records, the one that recomputes
`records.data`). They are not Postgres generated columns, because which
record fields are searchable lives in schema metadata. Events are records,
so they share the records index; an event's title and summary are always
searchable (1.3). Each fact carries its `record_id` and each event hit its
linked record IDs (possibly none or several), so a hit on a fact or event
also points to records.

Every index leads with `workspace_id` (`btree_gin`), so a common word is
matched within one workspace inside the index instead of across every
tenant and filtered afterwards.

All `tsvector` columns use the `simple` configuration over text folded by
`retainer_fold`: lowercase, accents removed ("José" is stored as "jose"),
split on spaces and punctuation, no stemming and no language-specific rules.
It behaves the same for every language. Queries are folded the same way, so
"Jose" and "José" find each other. `retainer_fold` is `unaccent` with its
dictionary named, declared `IMMUTABLE` (plain `unaccent` is only `STABLE`),
so a query built from constants is computed once rather than once per row.
Every vector and query is built in `records/search-sql.ts`, so no call site
folds, or forgets to fold, on its own.

Postgres keeps an email or a host as one word ("dana@acme.com",
"www.acme.com"), so neither starts with "acme". Emails and links therefore
also add their bare domain ("acme.com"), and "acme" finds both.

Stored search values are rebuilt when the way they are built changes. Facts
are searched by their own column, so the migration that
makes the change computes their new values in SQL; a test checks that it
matches what the write path stores. Record search text depends on schema
metadata, so that migration sets it to null instead, and every server boot
rebuilds null values (`records/rebuild-search.ts`) with the statement that
schema changes use, in batches, before it serves requests. One process
rebuilds at a time; others boot without waiting, and stale records only
fail to match until they are rebuilt. A partial index on `search is null`
keeps the check free once nothing is stale. Merged-away records keep no
search value and are skipped. This assumes no older server writes after the
migration runs: it would store the old form, which nothing marks stale.
Upgrades stop the old version first (`docs/self-hosting.md`).

#### How a search runs

1. Postgres parses the query with `websearch_to_tsquery('simple', …)`, which
   handles quoted phrases, `OR` and `-word`. There is no custom parser. The
   server then turns every word into a prefix (`'dan':*`) by rewriting the
   parsed query's text, so "Dan" finds "Dana" and "meet" finds "meetings",
   for people typing in the web app and for agents alike.
2. The server runs one query each on entity records, events and facts.
   Workspace and liveness filters (and, for facts, "current, not
   superseded") apply before ranking and limit. The internal notes
   `remember` creates are left out: their text is the fact's, so it is found
   with the fact, or hidden with it once the fact is retracted.
3. Each list is ranked with `ts_rank_cd`, using length normalization so long
   texts do not outrank short, precise matches. Hits that match the words as
   typed rank above hits that only match a longer word, since `ts_rank_cd`
   scores a prefix match the same as an exact one.
4. If the records query finds nothing, even by prefix, the server matches
   `records.label` by trigram similarity, so "Dana Levy" finds "Dana Levi".
5. Results come back grouped by type. Each hit carries its record IDs and
   its text as stored: a record's label, a fact's content, an event's type,
   time, title and summary. A record hit says whether it matched the text or only
   a similar label. Scores from the three lists are not comparable and are
   not merged.

Prefixes cover endings ("meeting" finds "meetings"); agents cover other
word forms themselves: the `search` tool description tells them to add
variants with `OR` ("ran OR run").

`query_records` takes keywords too (`search`, within one object, as the web
app's record pickers use it): `plainto_tsquery`, every word required, each
matched as a prefix, accents folded.

#### Why not BM25

`ts_rank_cd` has no inverse document frequency: a word that appears
everywhere in a workspace counts as much as a rare one. BM25 handles that,
but Postgres has it only through extensions (for example ParadeDB's
`pg_search`) that many managed Postgres services do not offer, which would
break "plain Postgres is the only dependency". Within one workspace the
candidate set is small, and an agent reads the top results anyway.

There is no `ask` endpoint: answering questions is the agent's job. It
composes `search`, `query_records` and `get_context` with its own model.

---

## 6. Interfaces

### 6.1 REST (`/v1`)

| Route                                             | Purpose                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/me`                                      | Caller workspace, actor and scopes                                                                                                      |
| `GET /v1/schema/changes` · `/:id`                 | Paginated change history or one change                                                                                                  |
| `GET /v1/schema`                                  | Current schema                                                                                                                          |
| `POST /v1/schema/changes`                         | Request a schema change (applied or proposed)                                                                                           |
| `POST /v1/schema/changes/:id/approve` · `/reject` | Decide a proposed change                                                                                                                |
| `GET /v1/templates`                               | Templates and what each adds (3.1)                                                                                                      |
| `POST /v1/templates/:name/apply`                  | Apply a template (needs `schema:write`)                                                                                                 |
| `POST /v1/objects/:object/records`                | Create a record                                                                                                                         |
| `POST /v1/objects/:object/query`                  | Filter, sort and page records; optional object-scoped keyword lookup                                                                    |
| `POST /v1/objects/:object/aggregate`              | Count and per-field totals (empty, unique, sum, average, min, max) over a filter, optionally per option of a `select` field (`groupBy`) |
| `GET` · `POST /v1/objects/:object/views`          | The object's saved views (1.4), or save a new one                                                                                       |
| `GET` · `PATCH` · `DELETE /v1/views/:id`          | One saved view                                                                                                                          |
| `POST /v1/objects/:object/upsert`                 | Update or create a record found by `id` or `match`, with `ifMissing` (6.2)                                                              |
| `GET` · `PATCH` · `DELETE /v1/records/:id`        | One record                                                                                                                              |
| `GET /v1/records/:id/delete-impact`               | Records a delete would cascade to, at any depth, counted by object                                                                      |
| `POST /v1/records/delete-impact`                  | The same for several records deleted together, overlaps counted once                                                                    |
| `GET /v1/records/:id/assertions`                  | Paginated per-field assertion history                                                                                                   |
| `GET /v1/records/:id/events`                      | Paginated events attached to a record, newest first, each with `via`; `link` narrows to participant, about or field (1.3)               |
| `GET /v1/assertions/:id`                          | One assertion, including status and review details                                                                                      |
| `GET /v1/events/:id/claims`                       | Paginated assertions and facts citing an event                                                                                          |
| `GET /v1/records/:id/context`                     | Context pack                                                                                                                            |
| `GET /v1/records/:id/timeline`                    | The record's timeline (6.2): `types`, `fields`, `eventTypes` (comma-separated), `from`, `to`, `limit`, `cursor`                         |
| `POST /v1/records/:id/merge`                      | Merge another record into this one                                                                                                      |
| `POST /v1/records/:id/forget`                     | Hard delete for privacy requests (2.1)                                                                                                  |
| `GET` · `POST /v1/records/:id/facts`              | Facts about a record                                                                                                                    |
| `GET` · `POST /v1/records/:id/comments`           | Comments on a record, newest first; adding needs a `user` actor (1.3)                                                                   |
| `PATCH` · `DELETE /v1/comments/:id`               | Edit a comment (its author), or delete it (its author, or a `user` with `admin`)                                                        |
| `DELETE /v1/facts/:id`                            | Retract a fact (soft delete)                                                                                                            |
| `GET /v1/review`                                  | Pending assertions, suggested merges, participants matching deleted records                                                             |
| `POST /v1/review/merges/:id/dismiss`              | Dismiss a suggested merge (4.2)                                                                                                         |
| `POST /v1/assertions/:id/accept` · `/reject`      | Decide a pending assertion                                                                                                              |
| `POST /v1/events`                                 | Log an event: 201 when created, 200 for a retry; returns matched and unmatched participants (4.1)                                       |
| `POST /v1/events/query`                           | Query events of every event type: shared columns, `type`, `search` and `linked`, newest first (1.3)                                     |
| `POST /v1/events/move`                            | Move events to another event type, keeping IDs, identity, links and citations; a user with `admin`, or a dry run (1.3)                  |
| `GET` · `DELETE /v1/events/:id`                   | Read an event, or delete it and retract what cites it (2.1)                                                                             |
| `POST /v1/events/:id/links`                       | Add participants and `about` records (1.3)                                                                                              |
| `DELETE /v1/events/:id/participants/:pid`         | Remove a participant (a person only)                                                                                                    |
| `DELETE /v1/events/:id/about/:recordId`           | Remove an `about` record (a person only)                                                                                                |
| `POST /v1/search`                                 | Keyword search (5.1)                                                                                                                    |

Web sign-in and sign-out use `POST` and `DELETE /auth/session`, outside
`/v1`; see section 7 for cookie and CSRF rules. `GET /health`, also outside
`/v1` and needing no key, reports the version and database status (503
when the database is unreachable). Record reads optionally include
winning provenance, pending previews and relation references. Review responses
include totals and separate cursors for each collection (FRONTEND.md 9.1).

An OpenAPI document generated per workspace from its schema is planned but
not built yet; docs/rest-api.md lists every route.

### 6.2 MCP

Hosted on the API server at `/mcp` (Streamable HTTP). `@retainer/mcp` is a
small stdio bridge for local clients that only speak stdio. In accounts mode,
clients that cannot use an API key, such as Claude's web app, connect over
OAuth (7.3); OAuth tokens are accepted on `/mcp` only.

Tools are generic, not one per object. Custom objects would otherwise grow
the tool list without limit and break clients' tool caching.

`describe_schema`, `list_templates`, `apply_template`, `get_guide`,
`query_records`, `get_record`, `list_comments`, `search`, `get_context`, `get_timeline`, `upsert_record`,
`log_event`, `remember`, `propose_schema_change`, `move_events`. Events are listed with
`query_records` on their type, or on `event` for every type at once, so no
tool is needed per event type.

`remember`, `get_context` and `get_timeline` also take `workspace` and `me`
for workspace and personal memory (1.3). `describe_schema` lists them as the
`memory` built-in, with `me` only when the credential works for a person;
otherwise `me` answers `422 no_person`. The `memory` guide says what goes
where.

**Guides.** `get_guide(name)` returns step-by-step instructions, as
markdown, for a task an agent does rarely. Each guide is also an MCP prompt
of the same name, so a person can start it from their client (a slash
command in Claude Code); tools reach every agent, prompts only the clients
that show them. `discover_schema` has the agent
find and sample its user's sources on its own (an existing CRM first, then
spreadsheets, email and calendar), asking its user only for what it cannot
find, propose a template and additions tied to that evidence, wait for
the user's approval, then apply them with `apply_template` and
`propose_schema_change`. It changes only the schema;
importing data is a separate step. Guides are static text in
`packages/server/src/mcp/guides.ts`: Retainer reads none of the user's
sources and calls no model (4.3). The server instructions point an agent
at `discover_schema` when the workspace is not initialized.

`schema_design` holds the rules for growing or reviewing a schema in use;
`discover_schema` includes the same rules. Agents change the schema
mid-task, long after setup, so the `propose_schema_change` description
carries the short form and the server instructions point to the guide.
Each reserved object name carries its reason, so an object named
`interaction`, `event` or `fact` fails with the feature to use instead
(`log_event`, or an event type; `remember`).

In v1 an agent is connected to exactly one workspace through one API key.
Every call acts on that workspace, so no tool takes a workspace parameter.
`describe_schema` still returns the workspace's ID and name for logs and
for the agent's own context. Agents that work across several workspaces,
and any search or query across workspaces, are out of scope for v1.

Inputs are validated at runtime against the workspace schema, and validation
errors name the field and the allowed values, or a composite field's
expected format, so the agent can retry.

`remember(record, text, source?, quote?)` writes one `stated` fact at once,
citing `source` (an event ID) with an optional quote. Without `source`, it
creates an internal note for the fact to cite (1.3).

`upsert_record` accepts an optional `source` (an event ID). Values from a
conversation should cite it, so they carry the event's date as
`observed_at` (rule 2.2) and an older email cannot overwrite a newer claim.

The tool descriptions spell out the workflow in 4.1, so an agent knows to
log the event first and cite it in the writes that follow.

#### Finding the record to update

`upsert_record` finds its record in one of two ways:

- `id`: an explicit record ID. An ID merged into another record resolves to
  the surviving one.
- `match`: one unique field and its value, for example
  `{ "emails": "dana@acme.com" }`, looked up in `record_identifiers` with the
  conflict rules in 1.2. Only `is_unique` fields are accepted. Names and
  phones are rejected with an error that points the agent to `search` or
  `query_records`.

With neither, the call creates a new record.

`ifMissing` decides what happens when `id` or `match` finds nothing:
`"fail"` (the default) or `"create"`. The default is `"fail"` so that "update
Dana's address" can never create a new person by accident. With `"create"`,
the `match` value is written to the new record.

```
→ upsert_record {
    "object": "person",
    "match":  { "emails": "dana@acme.com" },
    "values": { "address": { "street1": "12 Rothschild Blvd", "city": "Tel Aviv" } } }
← { "id": "rec_9f2…", "created": false, "fields": { "address": "applied" }, "record": { … } }
```

The response reports each field as `applied`, `pending_review` or
`superseded` (rule 2.3), so an agent can tell its user that an update is
waiting for approval rather than claim it is done. `record` is the record
after the write, as `get_record` returns it, without its comments.

An agent that knows only a name or a phone number searches first
(`search` or `query_records`), then updates by `id`. With several
candidates, it tells them apart by company, email or recent events, or
asks its user.

Create-style writes (`remember`, record creation and merge requests) accept
a caller idempotency key scoped by workspace and operation. Store the request
hash and result atomically with the mutation; retries return the original
result, and reuse with a different payload fails. Identifier matching alone
does not make note creation or assertion history idempotent. A merge
request is already idempotent by state (B already merged into A is a
no-op). Keys are stored in `idempotency_keys` (workspace, operation, key,
request hash, result, expiry); `event_records.external_id` only covers
logging events.

Several agents can share a workspace. Each uses its own API key, so every
write is attributed to the agent that made it; between agents the latest
`observed_at` wins and the full history stays in `field_assertions`.

#### Responses of the memory tools

Record writes return the shape shown above. `log_event`, `remember`
and `get_context` return the following. IDs are UUIDs: version 7 for rows
created since migration 0038, random for older ones, so sort by `createdAt`
rather than by ID. The examples shorten them and add a type prefix for
readability.

```
→ log_event {
    "type": "conversation", "channel": "zoom", "externalId": "zoom-8812-3390",
    "occurredAt": "2026-10-29T14:00:00+02:00", "title": "Acme renewal call",
    "summary": "…", "fields": { "medium": "call" },
    "participants": [ { "handle": "dana@acme.com", "role": "customer" },
                      { "handle": "ron.peretz@acme.com", "role": "customer" } ],
    "about": [ "rec_a11…" ] }
← { "id": "evt_51b…", "type": "conversation", "created": true,
    "participants": {
      "matched":   [ { "id": "ip_1…", "handle": "dana@acme.com", "role": "customer", "recordId": "rec_9f2…" } ],
      "unmatched": [ { "id": "ip_2…", "handle": "ron.peretz@acme.com", "role": "customer", "reason": "no_match" } ] },
    "about": [ "rec_a11…" ] }
```

`created` is `false` when the same `(channel, externalId)` was already
logged with the same type, time and initial values (1.3); the response then
also has `added`, the participants and `about` records this call added, in
the same shapes, including stored participants resolved in place in
`added.participants.matched`. Handles come back normalized, in the order logged; `handle`
or `role` is `null` when not given. Each participant's `id` names the link,
for removing it. An unmatched
participant's `reason` is `no_match`, `phone_only` (phones never resolve a
participant on their own, 4.1), `deleted_record` (the handle belongs to a
soft-deleted record that was not merged; it is also listed in
`GET /v1/review`, 1.2), `ambiguous` (several live records claim the
handle; `candidates` lists their IDs, 1.2) or `suppressed` (the handle was
erased by `forget`; it is not stored, and `handle` is `null`, 2.1).

`DELETE /v1/events/:id` returns how far the retraction reached:
`{ id, deleted: true, retractedAssertions, recomputedRecordIds,
hiddenFactIds }`, the last being facts whose only live source it was.
`DELETE /v1/records/:id` returns the same counts when what it deletes
includes events.

```
→ remember {
    "record": "rec_9f2…", "text": "Legal review at Acme usually takes two weeks.",
    "source": "evt_51b…", "quote": "legal usually needs two weeks with these" }
← { "fact": {
      "id": "fct_77a…", "record": "rec_9f2…",
      "content": "Legal review at Acme usually takes two weeks.",
      "kind": "stated", "validFrom": "2026-10-29T12:00:00Z", "validTo": null,
      "writtenBy": { "type": "agent", "id": "…", "name": "Inbox agent" },
      "sources": [ { "event": "evt_51b…", "quote": "legal usually needs two weeks with these" } ] } }
```

`validFrom` is the cited event's `occurred_at` (rule 2.6). Without
`source`, the fact rests on an internal note (1.3), `validFrom` is the
write time, and its source is presented as
`{ "event": null, "internal": true, "quote": null }`. A `quote` needs a `source`. A retry with the
same idempotency key returns the same response.
`GET /v1/records/:id/facts` returns `{ record, facts, nextCursor }` with facts
in this shape, newest `validFrom` first, listing only live sources. It pages
with `limit` (default 100, at most 500) and `cursor`.

```
→ get_context { "record": "rec_5a1…", "tokenBudget": 1500 }
← { "record": {
      "id": "rec_5a1…", "object": "person", "label": "Noa Shapira",
      "fields": {
        "jobTitle": { "value": "Head of Data", "writtenBy": { "type": "user", … }, "observedAt": "…" },
        … } },
    "openTasks": [ { "id": "rec_c40…", "title": "Send SSO docs to Noa", "status": "todo", "dueDate": "2026-11-04" } ],
    "facts": [ { "id": "fct_1e2…", "content": "Needs SSO before agreeing to a pilot",
                 "validFrom": "2026-10-21T09:00:00Z", "writtenBy": { "type": "agent", … },
                 "sources": [ "evt_9d0…" ] } ],
    "recentEvents": [ { "id": "evt_9d0…", "type": "conversation", "occurredAt": "2026-10-21T09:00:00Z",
                        "title": "Globex data-platform demo", "summary": "…",
                        "via": { "kind": "participant" } } ],
    "omitted": { "openTasks": 0, "facts": 4, "recentEvents": 11 },
    "tokenEstimate": 1380 }
```

A context pack is assembled by fixed rules (5):

- The record's current field values are always included, each with who
  wrote it and when it was observed, so a value is never mistaken for a
  stated fact. The budget applies to the sections after it.
- The other sections fill in this order until the budget is spent: open
  tasks (tasks linked to the record through an active relation field whose
  status is not `done`, earliest due date first, undated last), current facts (not superseded or retracted,
  newest `validFrom` first; a fact resting only on an internal note is
  marked `internal: true`), then recent events in the record's history
  (attached directly or rolled up, newest first, each once with `via`, 1.3,
  without internal notes, whose text is already a fact). Items
  are never cut mid-text; a section stops at the last whole item that fits.
- `omitted` counts the items left out of each section, so the agent knows
  to read more with `search` or the REST routes.
- Tokens are estimated from characters, at about four per token. Retainer
  runs no tokenizer or model, so the budget is approximate. `tokenBudget`
  defaults to 2000 and is capped at 16000.
- The budget covers the whole response, keys, commas and `omitted` included:
  once the record's values fit, the pack's JSON is never longer than
  `tokenBudget × 4` characters. `tokenEstimate` is that length in tokens. No
  fixed row limit applies; the budget alone decides what is left out.

#### Timeline

`get_timeline` and `GET /v1/records/:id/timeline` show how a record got to
where it is. They return `{ record, items, nextCursor }`, assembled from the
source tables at read time:

| Item           | What is included                                                                     | `at`                     |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| `event`        | The record's event history: direct and rolled-up events, each once with `via` (1.3)  | The event's `occurredAt` |
| `field_change` | Each `active` or `superseded` assertion for one of its active fields                 | `observedAt`             |
| `fact`         | Its facts, current, superseded or ended; never retracted or resting on no live event | `validFrom`              |

A `field_change` is a value someone asserted, not proof the record ever
held it: `superseded` only means another assertion won later, or won
already. It carries the assertion ID, `status`, `current` (whether it is the
value the record holds now), the actor, confidence and the event it cites,
and the asserted value, never a diff. For a set that is the whole asserted
membership. A client wanting "added" or "removed" compares against the
winning value at that time, which the API does not claim to know. Pending
and rejected assertions stay in review and the assertion routes. Internal
notes never appear as events; a fact resting on one says `internal: true`.

Items are ordered by `at` descending, then kind (`event`, `field_change`,
`fact`), then ID descending. Each kind is read by keyset from its own table,
at most a page of each, and Postgres merges them, so equal times page
exactly; the event branch is the deduplicated rollup query (1.3), so an
event counts once before the limit. The opaque cursor holds the whole sort
key and a digest of the record and filters, and is refused (`invalid_cursor`)
for another record or other filters. Filters: `types`, `fields` (field
names, matched by field identity, so a rename keeps a cursor valid),
`eventTypes`, and `from` (inclusive) to `to` (exclusive). `fields` or
`eventTypes` alone narrows the page to its kind; with `types`, each filter
applies to its own kind and the others come back too.

Pages reflect current visibility and relations, not a snapshot: a backdated
event or a changed relation can change later pages. Exact intervals during
which a value was the winner, and an audit stream of retractions, are not
part of it.

---

## 7. Tenancy and auth

This section describes key mode, the default. Accounts mode, where people sign
in and have roles, is in 7.3.

The optional web app signs in at `POST /auth/session`, which turns a person's
API key into an HTTP-only `retainer_session` cookie (`SameSite=Strict`, path
`/`, 30-day max age, Secure except on localhost). The cookie contains the key;
revocation is checked on every request. `DELETE /auth/session` clears it.
`GET /v1/me` returns the workspace, actor and scopes. Explicit bearer headers
win over cookies, including when the header is invalid. Cookie-authenticated
mutations require `X-Retainer-Client: web` and reject a mismatched Origin;
this applies to the shared REST/MCP authentication middleware. Sign-in and
sign-out also require the header. The browser stores no key in local storage.

For TLS termination at a reverse proxy, set `RETAINER_PUBLIC_ORIGIN` to the
external origin (for example `https://retainer.example`). CSRF checks compare
the browser Origin to this configured value; forwarded headers are not trusted.
The setting also controls the cookie's public host and Secure handling.

Web read routes add paginated assertion history, record events, event
claims, review totals/cursors, and optional winning provenance
and batched relation references. Object queries accept an optional `search`
keyword string for full-text lookup within one object; workspace-wide search
is `POST /v1/search` (5.1). All use the same runtime role and RLS as other
routes. They do not change the assertion-backed write rules.

- Every row has `workspace_id`. Postgres row-level security uses a
  per-transaction `app.workspace_id` setting as a second line of defense
  behind the application's own checks. Runtime roles must not own tables or
  have `BYPASSRLS`; migrations use a separate role. On AWS the API and
  workers log in as `retainer_app` itself and are never given the owner's
  password. In a container, which needs the owner for its startup tasks,
  `RETAINER_RUNTIME_DATABASE_URL` gives the API's and workers' connections
  that login; without it they switch to it from the owner's login. Tenant
  foreign keys must include `workspace_id` (or equivalent enforced checks),
  since independent UUID foreign keys do not prevent cross-workspace
  references. Validate field/object compatibility in addition to tenant
  membership.
  `event_records`, `event_links` and `fact_sources` carry `workspace_id`, and
  tenant tables use composite foreign keys `(workspace_id, parent_id)`
  referencing a unique `(workspace_id, id)` on each parent.
- API-key lookup happens before the workspace is known, so `api_keys` is
  read through one narrow `SECURITY DEFINER` function that takes a key hash
  and returns the workspace, scopes and actor; the runtime role has no other
  access to that table. It rejects revoked keys, fixes its `search_path`, uses
  qualified table names and grants execution only to the runtime role.
- Background jobs carry their `workspace_id` and set the same setting, so
  workers are held to the same isolation as API requests.
- API keys are stored hashed, belong to one workspace, and carry scopes
  (`read`, `write`, `schema:write`, `admin`; `admin` implies the other
  three) and the actor they write as.
  Key provisioning/rotation is a trusted administrative operation; agent
  credentials cannot mint a key claiming a `user` actor to bypass approval.
- A self-hosted install starts with one default workspace and an admin key
  printed on first boot. A hosted service runs the same code with many
  workspaces. Accounts live in this repository (7.3); billing does not.

### 7.1 Managing workspaces and keys

Workspaces and keys are managed by an operator, never by an agent: no
workspace key can create another workspace. On a self-hosted install, the
server image includes a CLI that talks to the database directly:

```sh
docker compose exec retainer retainer workspace create --name "Acme Clinic" --template clinic
docker compose exec retainer retainer workspace list
docker compose exec retainer retainer key create --workspace acme-clinic \
  --name "Front-desk agent" --actor agent:front-desk --scopes read,write,schema:write
docker compose exec retainer retainer key list --workspace acme-clinic
docker compose exec retainer retainer key revoke <key-id>
```

`--template` is optional; without it, the first agent chooses one (3.1).
`--slug` overrides the slug made from the name; `--json` prints JSON.
`key create` prints the key once and stores only its hash. In accounts mode
people create workspaces and agent keys in the web app (7.3), and the CLI also
manages organizations and members (`org create`, `org list`, `member add`,
`workspace move`, and `--org` on `workspace create`), quotas (`org limit`) and
deleted workspaces (`workspace restore`, `workspace purge`). There is no
instance-wide admin HTTP API.

### 7.2 Per-record access

v1 isolates workspaces, plus one private audience: personal memory (1.3).
A restrictive policy, `private_to_user`, on the seven tables that carry the
column shows a private row only when `app.user_id` names its person, which
`inWorkspace` sets from the credential's person and nothing else. Every
read or write of `me` holds that person's membership advisory lock shared
and re-checks their access inside the transaction; removal and "Clear all"
take it exclusively. Otherwise every key sees every record in its
workspace. Wider per-record audiences, principals and roles may come later. They would be
rules stored in tables and enforced by a restrictive RLS policy
(`AS RESTRICTIVE`, with `USING` and `WITH CHECK`) next to
`workspace_isolation`, so Postgres applies them to every query. Application
code would only add clearer errors and pre-checks; it is never the
enforcement. Until then, new code keeps that path open:

1. Every read and write runs as `retainer_app` under RLS. The only
   `SECURITY DEFINER` functions are the API-key lookup,
   `retainer_session_access` (7.3), which returns a person's role in one
   workspace, `retainer_token_keys` and `retainer_token_access` (7.3), which
   return the public signing keys and a connected app's person, role and
   workspace, `retainer_workspaces_due` (4.2), which returns workspace IDs
   only, and `retainer_erase_private_derivatives`, which `forget` calls to
   delete private copies of what it erases and which returns nothing; no read
   takes a shortcut around RLS, including search and context.
2. Per-request database context is set in one place (`inWorkspace`).
3. A response mentions another record (conflict errors, merge candidates,
   relation labels, review items, context) only through one shared
   function, `references()`, so a visibility check can be added there
   later. The records a response is about, such as search hits or the
   record under review, come from their own RLS-bound queries.
4. Identifier claims are unique per workspace. If audiences arrive, claims
   become per audience and promoting a record becomes a merge. That cost is
   accepted.

### 7.3 Accounts

People log in, create workspaces, invite colleagues and connect agents, with no
operator.

**What is built.** All of it: signing in with Google, Microsoft or a passkey, organizations,
roles, self-serve workspaces, invitations, agent keys in the web app, the settings
pages, the `control` function with its NAT gateway on AWS, MCP OAuth with a
workspace picker and connected apps, scheduled workspace deletion, and the limits
below. The reasons, deviations and test results are in
[docs/specs/accounts-and-access.md](docs/specs/accounts-and-access.md). The workspace
stays the security boundary: RLS stays keyed on `workspace_id`, records get no
organization column, and a `Caller` still has exactly one workspace.

**Two modes.** Key mode, today's behavior, stays the default. Accounts mode starts
when `RETAINER_AUTH_SECRET` and a Google or Microsoft client are set. It turns off API
key sign-in in the web app, and signup is open: anyone with a verified Google or
Microsoft address can create their own organization, on a self-hosted install too. Agents use API keys in
both modes.

**Signing in.** [Better Auth](https://www.better-auth.com), an MIT library, runs in
our process and keeps its tables in our Postgres. People sign in with Google,
Microsoft (work, school and personal accounts) or a passkey. There are no passwords,
and no email sign-in, so Retainer stores no password and needs no email provider. A
person is identified by the provider account they first signed in with, by the
provider's own ID, never by email, and adds passkeys after that first sign-in. A
second provider joins the same person only when it verified the same address; for a
Microsoft work account that takes the `xms_edov` claim, the organization's proof that
it owns the domain. Passkeys are tied to the domain. MFA is
not offered at launch, because Better Auth's plugin only challenges password
sign-ins.

**A session is a second way to build a `Caller`.** Everything after `authenticate`
is unchanged:

1. An `Authorization` header means an API key or an OAuth token, and never falls back
   to the cookie.
2. A session cookie needs `X-Retainer-Workspace`. The server verifies the cookie's
   signature, then calls `retainer_session_access(session_token, workspace_id)`, which
   returns the user and their role. An unknown session gets 401, and a workspace the
   person cannot open gets 404.
3. In key mode, the cookie holds the key, as above.

Better Auth stores session tokens raw, so a token read from the database is not
enough: a valid cookie also needs the signature. The client names the workspace on
each request and never authorizes it, because a session holding an "active workspace"
would let a switch in one tab change where another tab writes. Access is checked on
every request, so removing someone applies at their next one.

**Organizations and roles.** An organization owns workspaces and members, and stays
hidden in the web app until someone needs it. Access is role-based at workspace level.
Roles are bundles of the existing scopes, so routes keep calling `requireScope`, and
the human-only rules stay a separate check.

| Role                  | Means                                                      |
| --------------------- | ---------------------------------------------------------- |
| Workspace `viewer`    | `read`                                                     |
| Workspace `editor`    | `read`, `write`                                            |
| Workspace `admin`     | `read`, `write`, `schema:write`, `admin`                   |
| Organization `member` | Only the workspaces they are added to, with the role there |
| Organization `admin`  | `admin` in every workspace; creates workspaces and invites |
| Organization `owner`  | Also billing and deleting the organization                 |

Accepting an invitation needs a verified address that matches it, from the provider
the person signed in with. Account
routes under `/account` take a session cookie only, so an agent's key can never
create a key, a member or a workspace.

**Where it runs.** On AWS, a `control` function loads Better Auth and serves
`/account` and the OAuth metadata. It is the only function with internet, through a
NAT gateway, because Google and Microsoft sign-in and OAuth client metadata need it. The `api`,
`consolidate` and `ops` functions keep no route to the internet, and `api` does not
import Better Auth: only an `accounts` module does, and only `index` and
`lambda/control.ts` import that. In a container with `RETAINER_ROLE=all`, everything runs in one process.

**Database roles.** Each function logs in with its own role: `ops` as the owner,
`api` and `consolidate` as `retainer_app`, and `control` as `retainer_control`, which
has the account tables, `workspaces` and `api_keys`, no `BYPASSRLS` and no DDL. It
creates an organization, workspace and seed in one transaction, switching to
`retainer_app` with `SET LOCAL ROLE` to seed under RLS. Account tables have RLS on,
with no policy or grants for the runtime role. Three `SECURITY DEFINER` functions join
the two in 7.2: `retainer_session_access`, `retainer_token_keys` and
`retainer_token_access`.

**MCP OAuth.** Better Auth's `mcp()` and `cimd()` plugins are the authorization
server, so clients such as Claude's web app can connect. The person picks the
workspace on the consent page, which checks their access to it before Better Auth
records the consent with that workspace as its reference. Access tokens are
one-hour EdDSA JWTs that name the workspace, and work on `/mcp` only. Without internet, `api` reads the
public signing keys through `retainer_token_keys`, verifies the token, then calls
`retainer_token_access` for the person's current role and consent. The request's
scopes are the token's scopes intersected with that role's and the consent's, so a
downgrade, removal or revoked consent applies at the next request. The actor is always an `agent`, with an
ID made from the client and the person, so the human-only rules still apply.
Removing a person from a workspace or organization deletes their consents there,
and a consent is the connection people see and disconnect in Settings.

**Personal memory.** A caller has a person when its credential names one: a
session, an OAuth token (the person who connected the app), or an API key
created with "This agent works for me" (`api_keys.acts_for_user`, which
stops reaching the person once they lose access). When a person loses
access to a workspace, by removal from it or the organization or a role
change, the same transaction deletes their personal memory there, revokes
keys that work for them and writes a `deletion_audit_log` row with counts
only. Settings → Memory shows both memories, with Remove and Clear all.

**Limits.** A per-workspace rate limit on `/v1` and `/mcp` (600 requests a minute
in accounts mode by default, off in key mode), counted in an unlogged table and
answered with `429` and `Retry-After`. Quotas on workspaces and members in
`organizations.limits`, checked under the organization's lock (null means
unlimited, as on a self-hosted install). A 25-second statement timeout on the API's
connection pool, set at connection start, so one slow query cannot hold a
connection past the 29-second request limit; with `RETAINER_ROLE=all` the API has
a pool of its own.

---

## 8. Repository layout

| Path              | License  | Contents                                                |
| ----------------- | -------- | ------------------------------------------------------- |
| `packages/shared` | MIT      | Field types, composite shapes, actor, schema types      |
| `packages/server` | AGPL-3.0 | API, MCP endpoint, workers, schema engine, database     |
| `packages/sdk`    | MIT      | TypeScript client                                       |
| `packages/web`    | MIT      | Optional static React app for people                    |
| `packages/mcp`    | MIT      | stdio bridge to the hosted MCP endpoint                 |
| `docker/`         | AGPL-3.0 | Dockerfile and Compose file                             |
| `docs/`           | AGPL-3.0 | Guides, plus design records in `specs/` and `research/` |

### Server layers

Each server module in `packages/server/src` belongs to a layer and imports only
from its own layer and the ones below it:

| Layer      | Modules                                                                                      | Holds                                                                             |
| ---------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Entry      | `index`, `cli`, `lambda`                                                                     | Starting the server, the CLI and the Lambda functions                             |
| Interfaces | `api`, `mcp`, `worker`, `operator`, `auth`, `http`, `accounts`                               | The ways in: REST, MCP, jobs, operators, people signing in, and handling requests |
| Admin      | `schema-engine`, `templates`, `workspaces`                                                   | Changing a schema and creating workspaces                                         |
| Features   | `views`, `comments`, `retrieval`, `reads`                                                    | Built on records and memory                                                       |
| Core       | `records`, `memory`, `privacy`                                                               | The write rules                                                                   |
| Foundation | `db`, `schema`, `caller`, `idempotency`, `stable-json`, `config`, `errors`, `log`, `version` | The database and reading a schema                                                 |

The schema engine sits above the records because a schema change rewrites
records and views, while records only need to read a schema: `schema` holds the
read side and `schema-engine` the write side. Events are records, so the core
modules may import each other. No other modules may form a cycle, and no files
may. `scripts/check-layers.mjs` enforces this as part of `pnpm lint`, and fails
when a new module has no layer. It also refuses MIT packages importing server
code.

## 9. Stack

TypeScript on Node 26, pnpm workspaces, Hono, postgres.js with plain SQL,
Drizzle for table definitions and drizzle-kit migrations, Zod, the
official MCP TypeScript SDK, and Better Auth with its JWT, MCP and client
metadata plugins for signing people in and for OAuth (accounts mode only, in the
`accounts` module). `jose` verifies OAuth access tokens in the API, which does not
import Better Auth. The job queue is Postgres itself (4.2), with
no queue library. No LLM SDK.
The optional web package uses Vite, React 19, TanStack Router/Query, Tailwind
CSS 4 and shadcn-style UI primitives. Static files are served by Hono at
`/app` when `RETAINER_WEB_DIR` is set; the Docker image includes the build.

PostgreSQL was tested against an alternative. In November 2026 a complete
SurrealDB backend was built on the `codex/surrealdb-v1` branch and parked without
merging. Its graph went unused on hot reads, which use stored rollups. Writes
were serialized per workspace: about 24 to 35 per second locally and a few per
second on SurrealDB Earth. Earth accepted duplicates through a unique index
defined inside a transaction. Whether SurrealDB's license allows a hosted service
is still unanswered. The branch holds the evaluation, the results and the
migration spec. If this is reopened, the deciding test is removing the shared
workspace revision record from the write path and relying on unique indexes and
per-record conflicts.

## 10. Scope

Not planned: embeddings and semantic search, and any language model inside
Retainer (server-side extraction, generated summaries, an `ask` endpoint).
Search is Postgres full-text only. A BM25 backend may come later as an
option (5.1).

Left out of the first release: phone-based participant matching, typed SQL
views, per-field index automation, field type changes, inferred facts,
automatic record merges, stale-field flags, exact historical belief
snapshots, versioned re-logging of edited sources, partial redaction on
`forget`, and agents connected to more than one workspace.

## 11. Testing

Every feature lands with its tests. Nothing is "done" until the layers
below that apply to it pass locally and in CI. Retainer has no language
model inside it, so every layer except 5 is deterministic.

| Layer                   | What it proves                                                                                                                                                               | How                                                                                                 | Runs                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------- |
| 1. Unit                 | Pure logic: the field-winner rules (2), schema validate/diff/classify (3), identifier normalization (emails, E.164 phones), value validation                                 | Vitest, no database                                                                                 | Every PR               |
| 2. Database integration | Rules only Postgres can prove: concurrent creates with one email make one record, per-record locking, unique claims, row-level security between workspaces, merges, `forget` | Vitest against real Postgres; each test file gets a fresh database                                  | Every PR               |
| 3. API                  | Every REST route: auth, scopes, validation errors, response shapes                                                                                                           | The Hono app called in-process against a real database                                              | Every PR               |
| 4. Agent scenarios      | End-to-end flows as an agent sees them: apply a template, create a person, update by `match`, log an event and cite it, review a conflict, search, get context               | The MCP client, directly and through the stdio bridge, and REST, against the app and real Postgres  | Every PR               |
| 5. Live agent           | Whether a real agent understands the tools and follows the workflow in 4.1: names, descriptions, error messages, what it chooses to write from a sample conversation         | A separate Claude Code or Codex session connected to Retainer's MCP endpoint, given realistic tasks | By hand, per milestone |

Browser tests use Playwright against the built app and real Postgres, with a
fresh database cloned from a migrated template per test. Run `pnpm build`
then `pnpm test:web`; CI runs these after the existing test layers.

### Rules

- **Fresh database per test file.** Migrations run once into a template
  database; each test file clones it (`CREATE DATABASE … TEMPLATE …`) and
  drops it after. Files never share rows, so they run in parallel without
  flaking. Browser tests clone one per test.
- **Real Postgres, never a mock,** for anything that touches the database.
  Locking, row-level security and unique constraints are the point of
  layers 2 and 3.
- **Concurrency is tested, not assumed.** Every rule in 2 that says
  "serialized", "atomic" or "idempotent" gets a test that runs the
  competing operations at the same time.
- **Scenarios follow the docs.** Each scenario in layer 4 matches a flow
  described here, so a change to the design shows up as a failing scenario.

### CI

A GitHub Actions workflow runs on every PR and on `main`: lint, build,
typecheck, layers 1–4, then the browser tests, with Postgres as a service
container. Pushing a `v*` tag runs the release workflow, which reruns CI
before publishing (docs/releasing.md). Retainer calls no model, so CI needs
no API keys.

PRs changing database migrations also run an advisory [migration compatibility
check](docs/migration-compatibility.md): old server tests on the new schema, with
an explicit machine-readable verdict. Breaking migrations remain allowed.
