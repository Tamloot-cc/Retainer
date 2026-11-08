# Changelog

All notable changes to Retainer are listed here. Versions follow
[semantic versioning](https://semver.org); before 1.0, a minor version may
include breaking changes.

## 0.1.0

The first release.

### Server (`@retainer/server`, Docker image)

- Schema as data: base objects, six templates (`sales`, `services`, `clinic`,
  `real_estate`, `recruiting`, `blank`) and a schema engine that applies
  additive changes and holds destructive ones for a person's approval.
- Assertion-backed records: every field value is the winner among assertions
  from people, integrations and agents, with precedence, `observed_at`
  ordering and a review queue for agent values that would overwrite people.
- Interaction log with participant matching on normalized emails, `about`
  links to the records an interaction concerns, re-logging that adds the
  participants and `about` records it was missing, filtering and counting
  with `query_interactions`, and facts that cite the interactions they came
  from. `describe_schema` lists interactions and facts as built-ins.
- Keyword search over records, facts and interactions (Postgres full-text,
  with every word matched as a prefix and exact matches ranked first, accents
  ignored, email and website domains indexed, and a trigram fallback for
  misspelled names), and token-budgeted context packs.
- Consolidator: fact deduplication and supersession, merge suggestions,
  record merges, and `forget` for privacy requests with keyed-hash
  suppression of erased emails and phones.
- REST API under `/v1`, MCP over Streamable HTTP at `/mcp`, API keys with
  scopes and actors, row-level security between workspaces, and the operator
  CLI for workspaces and keys.
- Optional web app at `/app`, signed in with a personal API key: a review
  inbox for pending values, proposed schema changes and unresolved
  participants; record tables with filters, sorting and resizable,
  reorderable columns, a total count, per-column calculations (empty,
  unique, sum, average, min, max), row selection with bulk delete and merge,
  and editing cells in place; records in a side sheet or a full page, with
  provenance, inline field editing and retraction of facts and interactions;
  a schema page with objects, fields and change history; record creation
  from a schema-driven form; delete, merge (with a field-by-field comparison)
  and erase-for-privacy from a record's actions menu; suggested merges in the
  review inbox; ⌘K search across records, facts and interactions; and
  saved views shown as a table, a board grouped by a single-select field
  (with per-column counts and totals) or a month calendar, where cards and
  records move between columns and days by mouse, touch or keyboard.
- Saved views: `GET`/`POST /v1/objects/:object/views` and
  `GET`/`PATCH`/`DELETE /v1/views/:id`, with workspace or private
  visibility; fields are stored by key, so views follow renames, and a
  schema change that removes a field or option rewrites the views that
  named it.
- `groupBy` on `POST /v1/objects/:object/aggregate`: the same totals per
  value of a single-select field.
- `RETAINER_DB_POOL_MAX` sets the API's database pool size (default 10).
- Deleting records, facts and whole workspaces no longer scans a table for each
  deleted row: three foreign keys gained the index their delete needs, and
  purging a workspace of 360,000 records went from over 9 minutes to 16 seconds.
- An `invalid_filter` error for a bad value carries what a write's error does:
  the field, the message, and the allowed values.
- MCP guide and prompt `log_from_chat`: what an agent logs from a chat with
  its user, which source it cites, and when it asks before creating a
  record. The server instructions point agents to it.
- Workspace memory and personal memory: `workspace` and `me` name two hidden
  profile records that hold facts only. `remember`, `get_context`,
  `get_timeline` and `GET /v1/records/:id/facts` take them. Workspace memory
  is shared by everyone in the workspace; personal memory is private to one
  member in one workspace, enforced by row-level security, and is deleted
  when they leave it. An agent reaches `me` through a session, an app the
  person connected, or an API key created with "This agent works for me";
  any other key gets `422 no_person`. `describe_schema` lists the profiles in
  a `memory` built-in, and the `memory` guide tells agents what goes where.
- `remember` takes `supersedes`: the ID of a current fact it corrects (same
  record) or moves (another record or profile). The old fact keeps its
  history and leaves current memory.
- `POST /v1/records/me/forget` clears the signed-in person's personal memory
  in the workspace; `forget` on a record also erases private copies of what
  it removes.
- Web app: Settings → Memory lists both memories with Remove and Clear all,
  and agent keys have a "This agent works for me" option.

### `@retainer/sdk`

- Typed client for every REST route, including search, context packs,
  aggregates, merges, merge-suggestion dismissal and `forget`; typed
  `RetainerApiError`.
- `facts`, `remember` and `context` take `workspace` and `me`; `remember`
  takes `supersedes`; `clearMyMemory()`.

### `@retainer/mcp`

- stdio bridge (`retainer-mcp`) for MCP clients that only speak stdio,
  configured with `RETAINER_URL` and `RETAINER_API_KEY`.

### Claude Code plugin (`plugins/retainer`)

- Installs from this repository's marketplace with
  `/plugin install retainer@retainer`: the Retainer MCP server over OAuth,
  a background Stop hook that asks Claude Haiku (through the person's own
  sign-in) whether a turn holds CRM information and wakes Claude to follow
  the server's `log_from_chat` guide. `RETAINER_CRM_HOOK=off` turns the
  check off.

### `@retainer/shared`

- Field types, value validation, schema definitions and the public request and
  response types shared by the server, the SDK and the web app. Merge
  suggestions carry the object and label of both records (`records`).
