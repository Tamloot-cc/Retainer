# Conversations and the Activity UI: spec

Status: **implemented** November 5, 2026. Open question 2 (7) is resolved:
events can be moved between types (`POST /v1/events/move`, `move_events`).
Open questions 1, 3 and 4 remain open. **Amended** by the
[comments spec](comments.md): D1 and 4.1 (`note` left the base template),
D7 and 5.4 (Write a note is gone; people write comments).
The SDK method is `queryEvents` (the client has no namespaces), and the
events query's `search` uses the records' search index: the core title and
summary, plus any searchable fields of the type.

This spec amends the [merged schema, events and history spec](schema-events-and-history.md)
(6.1 base event types, 7.1 direct retrieval) and [FRONTEND.md](../../FRONTEND.md)
(5.3 object list, 5.3a shell, 5.6 event, 5.7 schema). It keeps the
entity/event split, event links, rollups and the record timeline as they are.
It changes which event types every workspace starts with, adds one query and
makes the split visible in the web app.

## 1. Why

The findings come from dogfooding the "Live Test" workspace after the event
upgrade (schema v12–v13): 88 Tamloot recordings re-logged as events from a
backup, plus one new meeting logged with facts and tasks, 89 events in all.

### 1.1 System design

- **Four base types share one shape.** Meeting, call, email and message all
  have exactly the core: title, summary, `occurredAt`, `channel`,
  `externalId`, participants and `about`. Retainer's own `schema_design`
  guide says to prefer "one multi_select of tags … over separate objects for
  kinds of company or person that share the same fields". The base template
  breaks that rule for events.
- **The boundaries are fuzzy, and a wrong guess is permanent.** A recorded
  Zoom conversation is a meeting or a call depending on who logs it. In Live
  Test, 4 of the 88 recordings became calls only because the source labeled them
  that way. An event's type cannot change: re-logging under another type is
  `event_conflict`. Deleting the event retracts every assertion and fact that
  cites it, and its identity stays suppressed for good: logging the same
  `(channel, externalId)` again returns `event_retracted`. Re-logging needs a
  new `externalId`, after which the source can no longer be deduplicated
  against the event.
- **Type overlaps with channel.** Channel already says where an event came
  from (gmail, zoom, whatsapp), so type mostly repeats it. The two still
  differ: channel `tamloot` holds both meetings and calls. Nothing documents
  which one an agent should rely on.
- **There is no workspace-wide view across types.** The upgrade removed
  `query_interactions` and `POST /v1/interactions/query`. `query_records`
  takes one object, and the timeline is per record. "Everything logged this
  week" or "every conversation with someone at Team8" now takes one query
  per event type.
- **Every workspace starts with five event types.** Live Test uses two of
  them (85 meetings and 4 calls) and none of the others. The guide's "start lean" rule
  says to add structure when the data shows it.

### 1.2 Frontend

- **The main sidebar hides the split.** `main.tsx` passes only `name` and
  `label` to the shell, which lists Meetings, Calls, Emails, Messages and
  Notes in one "Objects" list beside Companies and People.
- **The split is visible only to admins.** The schema page lists event types
  apart, with an "Event" badge and their built-in columns. People who work in
  record lists never see it.
- **Event lists hide actions without saying why.** New and Merge are missing
  for events, so the list looks broken rather than different.
- **The words drift.** The API says "event", the old model said
  "interaction", and people say "activity". The UI uses all three.
- **Developers can't see the model from the UI.** A record page doesn't show
  its API name, class, ID or which tool writes it.

## 2. Scope

In scope: the base event types, one cross-type event query, the guide and
schema text that steer agents, and the web app's navigation, event lists,
an activity feed, wording and a developer view.

Out of scope: the evidence model, event identity, links, rollups, the
timeline, internal notes and custom event types. They stay as the merged spec
defines them.

## 3. Decisions

| #   | Decision                                                                                                                                                                                                    | Replaces                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| D1  | The base template adds two event types: `conversation` and `note`. _Amended by [comments spec](comments.md) C5: only `conversation`._                                                                       | meeting, call, email, message, note     |
| D2  | `conversation` has a `medium` select (meeting, call, email, message). It is an ordinary field, editable after logging.                                                                                      | The event type as the medium            |
| D3  | Channel is the source system or account and is part of identity. Medium is what kind of conversation it was. Both are documented.                                                                           | Undocumented overlap                    |
| D4  | A new event type is for an event whose fields a conversation would never use: payment, form submission, site visit.                                                                                         | No rule                                 |
| D5  | Events can be queried across all event types, workspace-wide.                                                                                                                                               | One `query_records` call per type       |
| D6  | The web app shows two areas, **Records** and **Activity**. "Event" stays the API word.                                                                                                                      | One flat "Objects" list; three words    |
| D7  | People can write notes in the web app. Every other event is still logged by agents and integrations. _Amended by [comments spec](comments.md) C6: people write comments; no event is written from the app._ | "Only agents log events" for every type |
| D8  | A developer view shows API names, class, IDs and the write tool across the app.                                                                                                                             | Schema page only                        |

## 4. System design

### 4.1 Base event types (D1–D4)

The base template adds, beside person, company and task:

- **`conversation`**: "A meeting, call, email thread or chat between
  people." Core fields as in merged spec 6.2, plus:
  - `medium`: select, nullable, filterable. Options `meeting`, `call`,
    `email`, `message`. Workspaces may add options (for example `workshop`
    or `voice_note`) with `add_option`.
- **`note`**: "A note someone wrote down." Core fields only. This is the
  type people write in the web app (D7). The hidden internal-note type that
  `remember` uses is unchanged (merged spec 6.4).

Neither type is protected. A workspace can delete them under normal object
deletion rules, the same as the base types they replace.

**Why `medium` is a field and not the type.** A field can be corrected after
logging, with provenance, through `upsert_record`, and it ranks like any other
assertion. Correcting the type means deleting the event, which retracts its
citations and suppresses its identity (1.1). A misclassified medium then costs
one edit, not a delete and a re-log under a new identity.

**Channel and medium.** `describe_schema` and the guides say:

- `channel` is where the record came from: the source system or account
  (`gmail`, `zoom`, `tamloot`, `whatsapp-business`). It is part of identity,
  is fixed at logging and must tell apart sources whose IDs could overlap.
- `medium` is what happened: a meeting, a call, an email, a message. It is
  optional, and an agent that can't tell leaves it empty.

**When to add an event type (D4).** The `schema_design` guide gains this rule:
add an event type only when the event has fields a conversation would never
use. A payment has an amount and an invoice. A form submission has a form
name and answers. A site visit has an address and an outcome. Conversation
details such as duration, direction or a recording link are optional fields
on `conversation`, added from evidence, not new types.

`durationMinutes` is not in the base type (see 7, open question 1).

### 4.2 Cross-type event query (D5)

Add `POST /v1/events/query` and accept `object: "event"` in `query_records`.
`event` is already a reserved object name, so the meaning is unambiguous.

- It returns events of every visible event type, newest first by default.
  Internal notes are never included.
- It filters and sorts on what every event type shares: `occurredAt`,
  `channel`, `externalId`, `type` (event type API name, `eq` and `in`), and
  `search` over the core title and summary.
- It takes `linked: { record, link? }` as per-type queries do, so "every
  event attached to Team8" is one call. Rollups are not included; that stays
  with `GET /v1/records/:id/events` and the timeline.
- Type-specific fields such as `medium` are not filterable here, because
  they can differ by type. Filter one type with `query_records` on that type.
- Each item carries `type`, the core fields, built-in columns, its
  participants and `about` IDs, and its type's other field values (such as
  `medium`), as a per-type `query_records` returns them. They are returned,
  not filterable.
- Same pagination, cursor and limits as `query_records`.

The SDK gains `events.query`. The web app's Activity feed (5.2) uses this
route.

### 4.3 Agent-facing text

- Server instructions and `log_event` say: "Log meetings, calls, emails and
  chats as `conversation` with a `medium`. Use another event type only when
  the workspace defines one for that kind of event."
- The reserved-name reason in `schema-engine/validate.ts` for `interaction`
  and `event` names `conversation`.
- `discover_schema` and `schema_design` replace their meeting/call/email lists
  with the D4 rule.

### 4.4 Existing workspaces

Retainer is unreleased, so the merged spec's rule holds: no compatibility
shims or backfills. Workspace upgrade only adds, so an existing workspace
gains `conversation` and keeps its old types until someone deletes them.

Moving events between types is a separate problem. Event identity spans
types, so an event can't be re-logged as `conversation` while its old record
exists. Deleting the old record retracts what cites it and suppresses its
identity for good, so a re-log needs a new `externalId` and the source can't
be deduplicated against it again. In Live Test, one of the 89 events is cited
by 4 facts, 6 new tasks and a project's next step. Open question 2 resolved
this: a move changes an event's type in place and keeps all of that.

## 5. Frontend design

### 5.1 Shell (D6)

The sidebar has two labeled groups:

- **Records**: entity objects, standard ones first, as today.
- **Activity**: each event type. **Home** sits above both groups, followed by
  Find anything and Review inbox.

`main.tsx` passes each object's `class` to the shell. The collapsed icon
rail keeps a divider between the groups. Event types use icons from one
family, so the two groups are told apart at a glance.

### 5.2 Home — `/app/`

The workspace landing page now combines events, new records and grouped
entity writes. The former `/app/activity` route redirects here. Review
moves to `/app/review`. The current design and endpoint contract are in
[FRONTEND.md 5.3c](../../FRONTEND.md#53c-home--app).

The feed orders by added time, distinguishes occurrence dates, and keeps
filters in the URL. It uses `POST /v1/feed/query`; `POST /v1/events/query`
remains the event-only API. Grouped writes use a separate transaction time
on assertions, without changing conflict resolution. Facts, comments and
cross-request import grouping remain deferred.

### 5.3 Event type lists — `/app/o/:object` for event types

Same grid as entities, with event defaults:

- Default sort `occurredAt` descending.
- Default columns: `occurredAt`, title, `medium` (for conversations),
  participants, `about`, channel. Summary is available but hidden.
- Calendar view on `occurredAt` is offered without configuration.
- In place of the missing New button, the toolbar shows one muted line:
  "Logged by agents and integrations." It links to a short help popover that
  names `log_event` and `POST /v1/events`. For `note`, the line is replaced
  by **Write a note**.
- Merge is not offered, as today. The selection bar says "Events can't be
  merged" when two are selected, so the missing action is explained.

### 5.4 Writing a note (D7)

_Removed by the [comments spec](comments.md) (C6)._

A dialog with title, body (the summary), date (default now) and "About",
a multi-record picker. It sends `POST /v1/events` with type `note`, channel
`web`, a generated `externalId` reused on retry, and the user as actor.
Participants are not asked for: a note is about records, not with people.

This changes FRONTEND.md 5.6 ("only agents log events") for notes only. A
person can already add or remove participants and `about` links, so writing
a note is the same permission with no new risk.

### 5.5 Record and event pages

- The record header shows a quiet class label before the object name:
  "Record · Company" or "Activity · Conversation".
- The record page's Events tab is renamed **Activity**. The timeline keeps
  its name.
- The event page (5.6) shows medium beside type and channel, and lists
  channel as "Source".

### 5.6 Wording (D6)

| The UI says  | The API says        | Where                           |
| ------------ | ------------------- | ------------------------------- |
| Records      | entity objects      | Sidebar group, schema tab       |
| Activity     | events, event types | Sidebar group, record tab, feed |
| Conversation | `conversation`      | Type label                      |
| Medium       | `medium`            | Field label                     |
| Source       | `channel`           | Event page, list column header  |
| Participants | participant links   | Event page and rows             |
| About        | `about` links       | Event page and rows             |

"Interaction" no longer appears in the UI or the docs, except where
ARCHITECTURE.md records history.

### 5.7 Developer view (D8)

The account menu's **View** control has three levels: Standard, Developer
and Agent ([agent-view.md](agent-view.md)). Each adds to the one before, so
Agent includes all of Developer. Remembered per browser in `localStorage`,
available to every actor. At Developer:

- Object and field labels show their API names beside them in lists,
  headers, filters and forms.
- Record and event headers show the class (`entity` or `event`), the record
  ID with a copy button, and the write path: `upsert_record` /
  `POST /v1/objects/:object/upsert` (or `PATCH /v1/records/:id` for this
  record) for entities, `log_event` / `POST /v1/events` for events.
- Event rows show the raw `via` and `externalId`.
- A **JSON** tab on record and event pages shows the REST response as
  returned.

It changes what is displayed, never what is sent.

### 5.8 Schema page

- The Objects tab opens with one paragraph per class: what a record is, what
  an event is, and how each is written.
- The diagram draws event types with a distinct card style. It draws `about`
  as a dashed "any record" edge from each event type, so the link appears in
  the model without a fake relation field.

## 6. Implementation order

| Phase | Work                                                                                                                     | Depends on |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1     | Shell groups (5.1), class label (5.5), wording (5.6), event list defaults and explanations (5.3, except the note button) | none       |
| 2     | Developer view (5.7), schema page text and diagram (5.8), writing notes (5.4) with the note list button                  | none       |
| 3     | Base template change (4.1), guide and instruction text (4.3), reserved-name reasons                                      | none       |
| 4     | Cross-type event query: REST, MCP, SDK (4.2)                                                                             | none       |
| 5     | All activity feed (5.2)                                                                                                  | 4          |

Phases 1 and 2 are web-only and fix most of what people see. Writing notes
needs only the existing `POST /v1/events`. Phase 1 alone
is a small change to `main.tsx`, `ui/shell.tsx` and `routes/views/objects.tsx`.

## 7. Open questions

1. **Duration in the base type.** 87 of the 88 recordings migrated from the
   Live Test backup carry a duration. Should `conversation` ship with an optional `durationMinutes`, or
   should templates and agents add it from evidence? Recommendation: leave it
   out of the base and let the recording-source templates add it.
2. **Moving events between types. Resolved: built.** Should the server
   offer an admin-approved operation that changes an event's type while
   keeping its record ID, identity, links and citations, mapping fields by
   name? Without it, a workspace that wants `conversation` must delete and
   re-log under new `externalId`s. That loses the claims citing the old
   events, and the suppressed identities mean a later resync from the source
   can't be deduplicated against the new ones.

   **What was built.** `POST /v1/events/move`, the `move_events` MCP tool and
   the SDK's `moveEvents` move one or more named events of a type, or every
   live event of it, to another event type (ARCHITECTURE.md 1.3, "Moving
   events between types"). The record ID, `event_records` row, participants,
   `about` links, and the assertions and facts citing the event stay as they
   are. The event's own assertions are re-pointed at the target type's
   fields, by name or by an explicit `fields` mapping, and its data, links,
   identifiers and search text are rebuilt from them. `defaults` fills target
   fields the events have no value for, such as `medium: "meeting"`. Each
   move is logged in `event_moves`. No web surface: see the first decision
   below.

   Decisions, each the safer of the options:
   - **A separate admin operation, not a schema proposal.** A move needs a
     `user` key with the `admin` scope, as approving a destructive schema
     change or `forget` does; the request is the approval, and an agent's key
     is not. A move changes no schema, so it does not go through the schema
     engine or `schema_changes`. Storing it as a proposal would also be
     unsafe: approving "move every meeting" a week later would move meetings
     logged since, which the approver never saw. Instead, a key with
     `schema:write` runs it as a dry run (the same code, rolled back) and
     shows a person exactly what it would do, and the person runs it. With
     no stored proposal, the approval flow needs no web surface.
   - **Refuse lost values unless named.** Values for source fields the
     target has no field for, or that don't fit the mapped field, are refused
     with a list (`unmapped_fields`), until the caller maps the field or names
     it in `drop`, which deletes those assertions. A dropped value cannot be
     recovered, so it is never dropped by default.
   - **Defaults are initial values.** A default is written as the event's own
     initial value, citing the event, so a resync that logs the source as
     `conversation` with the same `medium` matches the moved event instead of
     conflicting. The old type carried that information at logging.
   - **The schema lock, exclusively.** A move holds the workspace schema lock
     exclusively, as schema changes do, so no write in the workspace
     interleaves with it, and moving a whole type is one transaction.
   - **Refuse what would break other records.** Records whose relation
     values, current or superseded, point at the events through an active
     field whose targets exclude the new type block the move
     (`referenced_by_relations`); relation targets never change. Superseded
     values count because a retraction can restore one without checking its
     target again.
     Unique values another record claims block it too, rather than going to
     review silently.

   **Live Test.** Not migrated by this change. Its 85 `meeting` and 4 `call`
   events can be moved by a person with an admin user key: first a dry run of
   `{ "from": "meeting", "to": "conversation", "defaults": { "medium": "meeting" }, "dryRun": true }`
   (and the same for `call` with `medium: "call"`), to see each field's
   mapping and anything the target has no field for; then the same requests
   without `dryRun`. Once both types have no live events, deleting them
   retracts nothing.
3. **A `direction` field.** Inbound versus outbound matters for email and
   calls. Add it only when an agent first has data for it.
4. **Saved views for the feed.** Views are per object today. A cross-type
   view needs a home in `views`; deferred until people ask for it.

## 8. Acceptance

- A new workspace has `conversation` and `note` as its only base event
  types. `describe_schema` documents channel versus medium.
- `medium` can be changed on a logged conversation with `upsert_record`, and
  re-logging the same identity with a different `medium` still conflicts as
  for any field value (merged spec 6.2).
- `query_records` with `object: "event"` and `POST /v1/events/query` return
  events of several types in one page, filter by `type`, `channel`, time and
  `linked`, and never return internal notes. Integration tests run against
  real Postgres with several event types and an internal note present.
- The sidebar shows Records and Activity groups. An event type list explains
  why it has no New button and why it can't be merged.
- A person can write a note from the feed and from the note list. It appears
  in the `about` records' timelines, and a retried submit creates one note.
- With Developer view on, a record shows its API name, class, ID and write
  path. With it off, none of these appear.
- Playwright covers the two sidebar groups, the feed's filters, writing a
  note and the developer switch.

## 9. Documents to update

ARCHITECTURE.md (base template, events query), FRONTEND.md (5.3, 5.3a, 5.4,
5.6, 5.7, 9.1), `docs/rest-api.md` (new route), the MCP server instructions,
the `schema_design` and `discover_schema` guides, the template definitions
and the reserved-name reasons in `schema-engine/validate.ts`.
