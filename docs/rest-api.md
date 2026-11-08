# REST API

Everything an agent can do over MCP, and the review operations people use, is
available over REST under `/v1`. The [TypeScript SDK](sdk.md) wraps every
route.

## Authentication

Send an API key as a bearer token:

```sh
curl https://retainer.example/v1/me -H "Authorization: Bearer rtn_…"
```

The key decides the workspace and the actor every write is attributed to.
Nothing in a request body can change either. See
[Self-hosting](self-hosting.md#workspaces-and-api-keys) for scopes and actor
types.

The web app authenticates with a session cookie instead (`POST` and
`DELETE /auth/session`). Cookie-authenticated writes must send
`X-Retainer-Client: web` and come from the configured origin. A bearer header
always wins over a cookie.

### Accounts mode

In [accounts mode](self-hosting.md#accounts-mode) people sign in with Google,
Microsoft or a passkey, and one session reaches every workspace they have a role in. A
request with the session cookie names its workspace by ID:

```http
X-Retainer-Workspace: 0b9a3c52-1f4e-4d2a-9a43-7f3c2e8d1a10
```

Without it the API answers `400`, and for a workspace the person has no role
in, `404`, the same as one that does not exist. The person's role sets the
scopes, and their writes are attributed to them as a `user` actor. A bearer
request needs no header; one that names another workspace than its key's gets
`400`. `/auth/session` does not exist in accounts mode.

`/account` holds the routes the web app uses for people: signing in
(`/account/auth/…`), the person and where they have access (`GET /account`),
workspaces, members, invitations, API keys and connected apps. They take only
a session cookie and refuse an API key or an OAuth token, so no agent
credential can create a key, add a member or create a workspace. The one
exception is `GET /account/providers`, which needs no session: it tells the
sign-in page which providers are on, as `{ "providers": ["google", "microsoft"] }`.
`GET /account` includes the same `providers`.

Deleting a workspace (`DELETE /account/workspaces/:id` with its name as
`{ "name": "…" }`, for an organization owner or admin) takes effect at once:
every request to it gets `404`, and its keys and connected apps stop working.
The data is removed for good 7 days later. Until then an operator can undo it
with `retainer workspace restore`.

### OAuth

In accounts mode, apps such as Claude's web app can connect to `/mcp` over
OAuth instead of with a key: the person signs in, picks a workspace and
allows the app (see [Connecting agents](agents.md#connecting-claudes-web-app-over-oauth)).
`/mcp` without a credential answers `401` with a `WWW-Authenticate` header
naming the resource metadata,
`/.well-known/oauth-protected-resource/mcp`, which points to the
authorization server under `/account/auth`. OAuth access tokens work on
`/mcp` only, not on `/v1`.

The token names the workspace, and on every request Retainer checks that the
connection still exists and what the person's role is now. The app gets the
scopes it asked for that the role allows, never `admin`, and writes as an
`agent` actor named after both, such as "Claude for Dana Cohen". Removing the
person, lowering their role, disconnecting the app or deleting the workspace
applies at the app's next request.

## Rate limits

Each workspace may make a fixed number of requests a minute to `/v1` and
`/mcp`, counted across all its keys and connections: 600 in accounts mode and
no limit in key mode unless the operator sets `RETAINER_RATE_LIMIT_PER_MINUTE`.
Past it the API answers `429` `rate_limited` with a `Retry-After` header in
seconds, and `details.retryAfter` with the same number.

## Errors

Errors are JSON with a stable `code`, a readable `message`, and sometimes
`details` naming the field and the allowed values or expected format:

```json
{ "error": { "code": "stale_write", "message": "the record changed since expectedUpdatedAt", "details": { … } } }
```

| Status | Typical codes and meaning                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`: the body or a filter does not have the expected shape                                                                                                                           |
| 401    | Missing, unknown or revoked key, or an OAuth token whose connection was removed                                                                                                                    |
| 403    | The key lacks the scope, or the action needs a `user` actor                                                                                                                                        |
| 404    | Not found in this workspace (other workspaces' IDs are reported as not found too)                                                                                                                  |
| 409    | A conflict: a unique value another record holds, an erased handle, or something already decided or retracted; `limit_reached` when an organization's quota is full                                 |
| 412    | `stale_write`: the record changed since `expectedUpdatedAt`                                                                                                                                        |
| 422    | `invalid_values`: field values fail validation (`details.errors` lists each); `invalid_filter`; `invalid_aggregate` (`details.field`, `details.allowed`); `invalid_view`; `idempotency_key_reused` |
| 429    | `rate_limited`: the workspace made too many requests this minute; wait `Retry-After` seconds                                                                                                       |
| 503    | The database is unreachable; `timeout`: a database query ran past 25 seconds and was stopped; or `not_configured`: `forget` without `RETAINER_SUPPRESSION_KEY`                                     |

`unique_conflict` and `suppressed` also list the field in `details.errors`,
in the same shape as `invalid_values`, so a client can show every per-field
error the same way.

## Pagination

List routes take `limit` and `cursor` and return `nextCursor`, which is `null`
on the last page. `GET /v1/review` pages each collection separately with
`pendingAssertionsCursor`, `unresolvedParticipantsCursor` and
`mergeSuggestionsCursor`, and returns `nextCursors` and `totals` for each.
`GET /v1/events/:id/claims` does the same for assertions and facts with
`assertionsCursor` and `factsCursor`.

## Idempotency

Creating a record, `remember`, merging and adding, editing or deleting a
comment accept an `Idempotency-Key` header
(1–200 characters). A retry with the same key and the same body returns the
original response; the same key with a different body fails with 422
`idempotency_key_reused`. Logging an event is idempotent through its
`(channel, externalId)` instead: logging it again with the same `type`,
`occurredAt`, title, summary and `fields` returns it with `created: false`
(status 200 instead of 201), after adding any participants and `about`
records it did not have yet (listed in `added`). Nothing is removed by
logging again; a different payload is a 409 `event_conflict`, and the
identity of a deleted or erased event is a 409 `event_retracted`.

## Routes

| Route                                             | Scope            | Purpose                                                              |
| ------------------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `GET /health`                                     | none             | Server version and database status (503 when the database is down)   |
| `GET /v1/me`                                      | any              | The caller's workspace, actor and scopes                             |
| `GET /v1/schema`                                  | `read`           | The workspace schema                                                 |
| `POST /v1/schema/changes`                         | `schema:write`   | Request a schema change (applied, or proposed for approval)          |
| `GET /v1/schema/changes` · `/:id`                 | `read`           | Change history, or one change                                        |
| `POST /v1/schema/changes/:id/approve` · `/reject` | `admin`, user    | Decide a proposed change                                             |
| `GET /v1/templates`                               | `read`           | Templates and what each adds                                         |
| `POST /v1/templates/:name/apply`                  | `schema:write`   | Apply a template                                                     |
| `POST /v1/objects/:object/records`                | `write`          | Create a record                                                      |
| `POST /v1/objects/:object/upsert`                 | `write`          | Update or create a record found by `id` or `match`, with `ifMissing` |
| `POST /v1/objects/:object/query`                  | `read`           | Filter, sort and page records of one object                          |
| `POST /v1/objects/:object/aggregate`              | `read`           | Count, and per-field totals over, the records a filter matches       |
| `GET` · `POST /v1/objects/:object/views`          | `read` · `write` | List the saved views the caller can see, or save one                 |
| `GET` · `PATCH` · `DELETE /v1/views/:id`          | `read` · `write` | Read, change or delete a saved view                                  |
| `GET /v1/records/:id`                             | `read`           | One record; `?include=provenance,relationReferences,counts`          |
| `PATCH /v1/records/:id`                           | `write`          | Update fields; optional `source` and `expectedUpdatedAt`             |
| `GET /v1/records/:id/delete-impact`               | `read`           | What a delete would take with it through cascades, counted by object |
| `POST /v1/records/delete-impact`                  | `read`           | The same for `{ "ids": [...] }` (at most 200) deleted together       |
| `DELETE /v1/records/:id`                          | `write`          | Soft-delete a record; for events, also retract what cites them       |
| `GET /v1/records/:id/assertions`                  | `read`           | Per-field history; `?field=`                                         |
| `GET /v1/records/:id/events`                      | `read`           | The record's event history, rollups included, with `via`; `?link=`   |
| `GET` · `POST /v1/records/:id/facts`              | `read` · `write` | List facts, or `remember` one                                        |
| `DELETE /v1/facts/:id`                            | `write`          | Retract a fact                                                       |
| `GET` · `POST /v1/records/:id/comments`           | `read` · `write` | List comments, newest first, or add one; adding needs a `user` actor |
| `PATCH` · `DELETE /v1/comments/:id`               | `write`          | Edit (author only), or delete (author, or a `user` with `admin`)     |
| `GET /v1/records/:id/context`                     | `read`           | Context pack; `?tokenBudget=` (default 2000, at most 16000)          |
| `GET /v1/records/:id/timeline`                    | `read`           | Events, field values and facts, newest first; filters, cursor        |
| `POST /v1/records/:id/merge`                      | `write`, user    | Merge `recordId` into this record                                    |
| `POST /v1/records/:id/forget`                     | `admin`, user    | Erase a person for a privacy request; not reversible                 |
| `POST /v1/events`                                 | `write`          | Log an event; returns matched and unmatched participants             |
| `POST /v1/events/query`                           | `read`           | Filter, sort and page events of every event type at once             |
| `POST /v1/events/move`                            | `admin`, user    | Move events to another event type; `schema:write` for a dry run      |
| `GET` · `DELETE /v1/events/:id`                   | `read` · `write` | Read an event, or delete it and retract what cites it                |
| `POST /v1/events/:id/links`                       | `write`          | Add participants and `about` records; idempotent                     |
| `DELETE /v1/events/:id/participants/:pid`         | `write`, user    | Remove one participant                                               |
| `DELETE /v1/events/:id/about/:recordId`           | `write`, user    | Remove a record from the event's `about` list                        |
| `GET /v1/events/:id/claims`                       | `read`           | Assertions and facts citing an event; `?own=false` omits its own     |
| `POST /v1/search`                                 | `read`           | Keyword search across records, events and facts                      |
| `GET /v1/review`                                  | `read`           | Pending values, merge suggestions, unresolved participants           |
| `GET /v1/assertions/:id`                          | `read`           | One assertion with its review state                                  |
| `POST /v1/assertions/:id/accept` · `/reject`      | `write`, user    | Decide a pending value                                               |
| `POST /v1/review/merges/:id/dismiss`              | `write`, user    | Dismiss a merge suggestion                                           |

"user" means the key's actor must be a `user`; agents get 403 even with the
scope. Request and response shapes are exported as TypeScript types from
`@retainer/shared`, and [ARCHITECTURE.md section 6](../ARCHITECTURE.md#6-interfaces)
shows annotated examples.

`POST /v1/objects/:object/aggregate` takes the same `filter` and `search` as
a query, plus `aggregates: [{ "field": "amount", "op": "sum" }]` (at most 50),
and returns `{ "total": 42, "values": [{ "field", "op", "value" }] }`. The
operations are `countEmpty`, `countNotEmpty`, `percentEmpty`,
`percentNotEmpty`, `countUnique`, `sum`, `avg`, `min` and `max`;
`aggregateOps(field)` in `@retainer/shared` says which a field supports.
Money totals are `{ amountMicros, currency }`, or `null` with
`"mixedCurrencies": true` when the matching records use several currencies.
With `"groupBy": "stage"` (a filterable single-select field) it also returns
`groups: [{ "value", "total", "values" }]`, one per value the matching
records hold, with `null` for records that have none.

Every filter value is checked against its column or field before it
reaches the database: `id` takes a record ID, `createdAt`, `updatedAt` and
`occurredAt` an ISO 8601 time with a UTC offset, relation fields record IDs,
and dates and times years 0001 to 9999. A malformed value, including one
element of an `in` list, is 422 `invalid_filter` with `details.field`.

A saved view is a named filter, sort and column set for one object, shown
as a `table`, a `board` (needs `groupBy`, a single-select field) or a
`calendar` (needs `dateField`, a date or date-time field):

```json
{
  "name": "Pipeline",
  "kind": "board",
  "groupBy": "stage",
  "filter": { "amount": { "gte": 10000000000 } },
  "sort": [{ "field": "closeDate", "direction": "asc" }],
  "columns": { "order": ["name", "amount"], "aggregates": { "amount": "sum" } },
  "hiddenGroups": ["lost"],
  "groupAggregate": { "field": "amount", "op": "sum" },
  "visibility": "workspace"
}
```

Fields are named as in the schema; the filter and sort are checked like a
query's, and a bad one fails with 422 `invalid_filter` or `invalid_view`.
`PATCH` changes only the keys sent, and `null` clears one. A `private` view
is visible only to the key's actor that created it (others get 404), and
only that actor can change `visibility` (403 otherwise). A view follows a
renamed field. A schema change that removes a field or option, or stops a
field being filterable, rewrites the views that named it; anything a read
still has to drop is named in the view's `issues`. Saved views are display settings: they never change
records, and moving a board card is a record `PATCH`.

Events are records of event types (`class: "event"` in `GET /v1/schema`):
`conversation` (meetings, calls, emails and chats, told apart by its
`medium` field), and any type the workspace adds. `channel` is
where an event came from (the source system or account) and is part of its
identity; `medium` is what kind of conversation it was, and can be corrected
later like any field.
They are logged with `POST /v1/events` and never created through
`POST /v1/objects/:object/records` (422 `use_log_event`), but an existing
event's fields can be corrected like any record's. Query them with
`POST /v1/objects/:object/query` on their type, which also filters and
sorts by the built-in `occurredAt`, `channel` and `externalId`, and takes
`linked`: the events attached to one record, as a participant, `about` it,
or through one of the event type's own relation fields, narrowed by `link`
(`participant`, `about` or `field`). Merged record IDs resolve to their
survivor. The notes `remember` creates for facts without a source are
internal and never listed. An event's participants and `about` name entities
only: an event in `about`, or the event itself, is a 422 `invalid_link`, and
an event as a participant a 422 `invalid_participants`. Links to events made
before this rule still read and can be removed.

Comments are plain text people write on any record, entity or event. Only a
key whose actor is a `user` can add one; any other gets 403, whatever its
scopes. A comment is never evidence: it can't be a `source`, and it isn't in
timelines, event lists or context packs. Merges move comments to the
survivor, and `forget` erases them.

```json
// POST /v1/records/rec_5a1…/comments
{ "body": "Their procurement moves slowly. Loop in legal early." }
// 201
{
  "id": "…",
  "record": "rec_5a1…",
  "body": "Their procurement moves slowly. Loop in legal early.",
  "author": { "type": "user", "id": "dana" },
  "createdAt": "2026-11-06T09:00:00.000Z",
  "updatedAt": "2026-11-06T09:00:00.000Z",
  "editedAt": null
}
```

`GET /v1/records/:id/comments` returns `{ record, items, total, nextCursor }`.

```json
{
  "linked": { "record": "rec_5a1…", "link": "participant" },
  "filter": { "occurredAt": { "gte": "2026-10-01T00:00:00Z" } },
  "sort": [{ "field": "occurredAt", "direction": "desc" }]
}
```

`POST /v1/events/query` (also `POST /v1/objects/event/query`) takes the same
body and returns events of every event type in one page, newest first
unless `sort` says otherwise. Its filters and sorts take only what every
event type shares: `occurredAt`, `channel`, `externalId`, `id`, `createdAt`
and `updatedAt`. Filters also take `type` (event type API names, with
`eq`, `neq` or `in`); it is not a sort. `search` matches the events' searchable text, such as their title and
summary, and `linked` works as above; rollups are not included. A type's own
fields, such as `medium`, come back on each event but are filterable only
with that type's own query. Each event carries `type` beside its fields and
`event` details, and `include: ["relationReferences"]` adds labels for
relation values, participants and `about` records. Internal notes are
never listed.

```json
{
  "filter": { "type": { "in": ["conversation", "payment"] }, "channel": "gmail" },
  "linked": { "record": "rec_5a1…" },
  "include": ["relationReferences"]
}
```

### Moving events to another type

`POST /v1/events/move` changes the type of logged events, for example every
`meeting` to `conversation`. Each event keeps its ID, its `occurredAt`,
`channel` and `externalId`, its participants and `about` records, and every
value and fact that cites it, so nothing is retracted and its source is still
deduplicated against it. Deleting and re-logging, by contrast, retracts what
cites the events and blocks their identity for good.

```json
{
  "from": "meeting",
  "to": "conversation",
  "fields": { "agenda": "topic" },
  "drop": ["recordingId"],
  "defaults": { "medium": "meeting" },
  "dryRun": true
}
```

- `events` (optional, at most 1000) moves only those events, which must all
  be live events of `from`; without it, every live event of `from` moves, in
  one transaction: all of them or none.
- Fields map by name; `title` and `summary` always map to the target's.
  `fields` maps source fields named differently. A field moves only to one of
  the same type, and its values must fit: an option the target lacks, or a
  relation to a record the target field cannot point at, is refused.
- Values the target has nowhere to keep are refused with 422
  `unmapped_fields`, whose `details.fields` lists each source field, the
  reason, and how many events and assertions hold values for it. Map it with
  `fields`, or list it in `drop` to delete those values; nothing is dropped
  unless named.
- `defaults` sets target fields on the moved events that have no value for
  them, as the event's own initial value (citing the event, observed when it
  happened). A later log of the same source with that value then matches the
  moved event, as a retry would. A required target field with no value on
  some moved event is 422 `invalid_values`; give it in `defaults`.
- Records whose relation values point at the events through an active field
  that cannot point at the target type make it 409 `referenced_by_relations`,
  listing the fields with the records holding such a value (`records`) and
  those holding it now (`current`). Earlier, superseded values count too,
  since retracting the claim that replaced one would restore it. Clear the
  current values; if earlier ones remain, replace the field with one that can
  point at both types. A deleted field never blocks a move.
- Moving into or out of the hidden internal-note type is impossible: it
  resolves as not found, as everywhere.

Moving needs a `user` key with the `admin` scope, like approving a schema
change: an agent's key is not a person's approval, whatever its scope. With
`"dryRun": true` it needs `schema:write`, runs the same checks and the same
move, rolls back, and returns what would have happened. The move holds the
workspace's schema lock, so other writes wait for it.

The response lists what happened:

```json
{
  "id": "…",
  "dryRun": false,
  "from": "meeting",
  "to": "conversation",
  "eventIds": ["…"],
  "fields": [
    { "from": "title", "to": "title", "events": 85 },
    { "from": "agenda", "to": "topic", "events": 12 }
  ],
  "dropped": [{ "field": "recordingId", "events": 40, "assertions": 40 }],
  "defaults": [{ "field": "medium", "events": 85 }]
}
```

`id` names the move's entry in the workspace's move log (who moved which
events, with the field mapping; never values). It is `null` for a dry run, or
when `from` had no live events.
