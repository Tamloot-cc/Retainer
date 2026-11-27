# Changelog

All notable changes to Retainer are listed here. Versions follow
[semantic versioning](https://semver.org); before 1.0, a minor version may
include breaking changes.

## 0.1.1

### Workspace agent and dashboards

- Chat with the workspace agent in Retainer or run `retainer agent chat`.
  CLI chats can read within the signed-in account's permissions. Writes
  require an active elevation for the workspace.
- Ask the workspace agent to build a live dashboard. Save dashboards to
  the workspace and reopen them with fresh results from Retainer.
- Routines and extensions can give the workspace agent a task. Routine
  run history shows the resulting agent conversations.

### API, SDK, and docs

- Upsert multiple records in a single request with
  `POST /v1/records/upsert`, `RetainerClient.upsertRecords()`, or the
  `upsert_records` MCP tool. The response includes a result for each input.
- The documentation site includes setup guides, the REST reference with
  an OpenAPI contract, and dedicated CLI and TypeScript SDK documentation.

### Extensions and hosted operations

- Extensions can add record buttons, including on-demand company and
  person enrichment. Upgrade previews preserve valid destinations, and
  run history shows inputs and outputs.
- **Extension SDK import change:** import `modelClient` from
  `@retainer/extension/model` and add `@anthropic-ai/sdk` to bundles that
  use it. Existing deployed first-party extension releases with a
  compatibility range covering `0.1.1` can continue to run.
- Hosted upgrades can apply reviewed independent migrations while
  serving traffic. Preflight checks all admitted builds before online DDL,
  and the schema-lock path keeps supported session reads available.

## 0.1.0

The first release.

### Server (`@retainer/server`, Docker image)

- Schema as data: objects and fields are rows, changed only through a schema
  engine that applies additive changes at once and holds destructive ones
  (rename, remove, required, unique) for a person with `admin` to approve.
  Each change keeps its diff, with labels, in the schema history. A new
  workspace starts empty apart from hidden system types.
- Templates: `starter` (Person, Company, Task and the `conversation` event
  type) and `sales`, `services`, `clinic`, `real_estate` and `recruiting`,
  which extend it. A template is a one-time copy into an empty workspace.
  A person or operator can pick one when creating a workspace. An agent's
  `apply_template` is a proposal, and approving it rechecks that the
  workspace is still empty. After migrations, the server brings existing
  workspaces up to the release's system definitions.
- Assertion-backed records: every field value is the winner among assertions
  from people, integrations and agents, with precedence, `observed_at`
  ordering and a review queue for agent values that would overwrite people.
  Field types include composite emails, phones, links, names, addresses and
  money, relations (with polymorphic and many-to-many fields) and `files`.
- Events: event types are objects of class `event`, such as Starter's
  `conversation` with its `medium` (meeting, call, email, message).
  `log_event` takes a channel and external ID, so logging a source twice
  returns the same event. Participants are matched on normalized emails and
  phones, and `about` links the records an event concerns. Logging an event
  again adds the participants and `about` records it was missing and
  resolves participants that had no match. Relation fields with
  `rollUpEvents` show a record's events on the records it belongs to, one
  hop. `query_records` lists one event type, or every type with `event`, and
  `move_events` changes the type of events already logged.
- An event's full text: an email body or a meeting transcript is stored
  apart from the summary. `get_event_content` and
  `GET /v1/events/:id/content` read it, a whole thread at a time, and search
  matches it.
- Facts cite the events they came from; `remember` without a source logs an
  internal note for the fact to cite. Comments are what people tell each
  other about a record: only people write them, nothing cites them, and
  agents read them with `get_record` and `list_comments`.
- Workspace memory and personal memory: `workspace` and `me` name two hidden
  profile records that hold facts only. `remember`, `get_context`,
  `get_timeline` and `GET /v1/records/:id/facts` take them. Personal memory
  is private to one member in one workspace, enforced by row-level security,
  and is deleted when they leave it. An agent reaches `me` through a
  session, an app the person connected, or an API key created with "This
  agent works for me". `remember` takes `supersedes` to correct or move a
  fact, and `POST /v1/records/me/forget` clears the caller's personal memory.
- Keyword search over records, events, event full text and facts (Postgres
  full-text, with every word matched as a prefix and exact matches ranked
  first, accents ignored, email and website domains indexed, and a trigram
  fallback for misspelled names). Context packs fitted to a token budget
  give a record's fields, linked records, facts and recent events.
  `GET /v1/records/:id/linked` lists the records linked to a record in both
  directions.
- Consolidator: fact deduplication and supersession, merge suggestions from
  shared emails, phones or URLs and similar names, and record merges.
  `forget` erases a person for a privacy request: their emails, phones and
  erased event identities are kept only as keyed hashes, and the suppression
  key can be rotated with `RETAINER_SUPPRESSION_PREVIOUS_KEYS`.
- Change feed: `GET /v1/changes`, `list_changes` and `get_change` return
  record changes in commit order.
- Files: an optional byte service (`docker/compose.files.yml`) stores
  private attachments for `files` fields, uploaded and downloaded through
  short-lived signed URLs, with quotas and durable erasure.
- REST API under `/v1` with idempotency keys, saved views (table, board and
  calendar, stored by field key so they follow renames) and aggregates with
  `groupBy`. MCP over Streamable HTTP at `/mcp` has generic tools that never
  grow with the schema. `describe_schema` returns each field type's
  `valueFormats`, and validation errors name the field and the expected
  value. Guides, also MCP prompts, cover `discover_schema`, `schema_design`,
  `log_from_chat` and `memory`.
- Key mode, the default: API keys with scopes (`read`, `write`,
  `schema:write`, `admin`) and actors, with row-level security between
  workspaces. `retainer-ops`, the operator CLI in the image, manages
  workspaces, keys, organizations, members, quotas, deleted workspaces and
  model usage directly in the database.
- Accounts mode, turned on by `RETAINER_AUTH_SECRET` and a Google or
  Microsoft client: people sign in with Google, Microsoft or a passkey,
  belong to organizations, and get a viewer, editor or admin role in each
  workspace. Sign-up is open. Members invite people by link and create agent
  keys in the web app. MCP clients such as Claude's web app connect over
  OAuth, choosing a workspace on a consent page. `/mcp/w/<workspace ID>`
  pins a connection to one workspace, and `list_workspaces` gives each
  workspace's address. Accounts mode also adds a per-workspace rate limit,
  optional organization quotas and workspace deletion that can be undone for
  7 days.
- Extensions (development preview when self-hosted): reviewed first-party
  releases that an operator adds to the catalog, which is empty by default.
  An admin approves each installation's access, secrets, model use and
  destinations (where its data goes in this workspace's schema), with an
  optional read-only configure step that suggests them. Extensions can be
  upgraded, automatically when nothing needs a new approval, disabled and
  uninstalled. Runs execute in fresh, isolated containers behind an egress
  proxy (`docker/compose.extensions.yml`). Source sync keeps provenance and
  honors erasure. Members can connect their own accounts over OAuth or with
  a key, and public webhooks are verified.
- Standalone apps: reviewed services that run their own code connect to an
  installation with an installation key or OAuth. They can own fields, call
  and publish tools, and add a sign-in link to the web app's sidebar.
- Model proxy: extensions and routines may call an Anthropic model with
  `RETAINER_MODEL_API_KEY`, which they never hold. The proxy records token
  counts, never content. Without a key, it answers `503 model_unavailable`.
  The core never calls a model.
- Routines: a workspace's own automations as short TypeScript, written by an
  agent over MCP or by the built-in builder from a description, and approved
  by an admin. They run on a record change, on a schedule in the workspace's
  time zone, or from a button on a record. Code runs in a closed sandbox
  with no network or credentials and writes as an agent. A retry replays
  recorded effects instead of repeating them. A routine pauses after three
  failed runs in a row. Routines appear only on servers that configure the
  routine runner.
- One image runs as `api`, `worker`, `control`, `extensions`, `files` or
  `all` (`RETAINER_ROLE`). It requires Postgres 18 or later.
  `RETAINER_RUNTIME_DATABASE_URL` gives the API and workers their own
  database login, and `RETAINER_DB_POOL_MAX` sets the API's pool size.
- Web app at `/app`, signed in with a personal API key in key mode, or with
  an account at `/app/w/<slug>/` in accounts mode. Home is a feed of new
  conversations, new records and grouped updates. The review inbox has four
  categories: proposed updates, structure changes, possible duplicates and
  participant issues.
- Web app records: tables with filters, sorting, resizable and reorderable
  columns, compact or expanded rows, per-column calculations, bulk delete and
  merge, inline editing, field descriptions on hover, and copying emails,
  phones and links. Saved views can show a table, a board grouped by a
  single-select field, or a month calendar. Records open in a side sheet or
  on a full page with provenance, linked records, activity, comments and
  Markdown text fields that follow the text's direction. An add-record
  composer creates records, and a schema page shows objects, fields, a
  diagram and change history.
- Web app tools: a ⌘K command palette searches records, facts and events and
  moves around the app. The Extensions, Routines and Settings pages cover
  members, invitations, agents and connected apps, memory and the
  workspace's time zone. The app works on phones and from the keyboard, and
  it keeps open forms through a maintenance pause.

### Bundled extensions (`packages/runner`)

Reviewed releases built from this repository. An operator packages and
enables each one; none is on by default.

- Company enrichment: fills company details such as employee count,
  LinkedIn URL and headquarters through Exa, with a model picking the
  matching company when one is available.
- Tamloot: each member connects their own Tamloot account and imports
  completed meetings, with notes and participants, and their tasks into the
  shared workspace. Setup can ask a model to suggest destinations, or be done
  by hand. Connect with Tamloot uses OAuth where the server has a registered
  client, and an API key otherwise.
- Gmail, through Nango: read-only. It imports a member's messages to and
  from existing People as conversations, with full bodies and threads.
- Granola: syncs shared Granola meeting notes, attendees and transcripts,
  with optional webhooks.
- Last contact: keeps a last-contact date on people and companies from their
  conversations.

### `@retainer/shared`

- Field types, value validation and formats, schema definitions, roles, MCP
  address parsing, schedule descriptions and the public request and response
  types shared by the server, the SDK, the CLI and the web app.

### `@retainer/extension`

- Build-time contracts for reviewed extensions: `defineExtension`,
  `defineFunction`, `defineTool` and `defineView` validate manifests, and
  `modelClient`, `RetryLater` and webhook and cron helpers serve the code
  that runs.

### `@retainer/sdk`

- Typed client for every REST route, including events, search, context
  packs, linked records, aggregates, views, comments, merges, files, the
  change feed, extensions and routines; `RetainerAccountClient` for accounts
  mode; typed `RetainerApiError`.
- `facts`, `remember` and `context` take `workspace` and `me`; `remember`
  takes `supersedes`; `clearMyMemory()`.
- Retries a server's maintenance response within a bounded budget: reads
  always, writes only when the server says they never ran or when they carry
  an idempotency key.

### `@retainer/mcp`

- stdio bridge (`retainer-mcp`) for MCP clients that only speak stdio,
  configured with `RETAINER_URL` and `RETAINER_API_KEY`.

### `@retainer/cli`

- `retainer`, a CLI for accounts mode that signs in through the browser.
  It lists workspaces, members, keys, connections, pending reviews,
  extensions and routines, and gives a workspace's MCP address. Decisions
  such as approving schema changes, merging duplicates or creating keys need
  a short window that a person approves in the browser, with passkey
  verification when they have one. The web app shows those decisions as made
  "through Retainer CLI".

### Claude Code plugin (`plugins/retainer`)

- Installs from this repository's marketplace with
  `/plugin install retainer@retainer`: the Retainer MCP server over OAuth
  (`RETAINER_URL` for a self-hosted server in accounts mode), and a
  background Stop hook. The hook asks Claude Haiku, through the person's own
  sign-in, whether a turn holds CRM information, and if so wakes Claude to
  follow the server's `log_from_chat` guide. `RETAINER_CRM_HOOK=off` turns
  the check off. A `retainer-cli` skill teaches Claude the CLI.
