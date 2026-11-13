# Member connections and the Tamloot extension: implementation spec

Status: implementation and local validation, 2026-11-13. Manifest,
persistence, member lifecycle, runtime scoping and the web connection UI
are committed. Managed-task reconciliation is implemented and tested against
real Postgres. The Tamloot bundle is implemented; its final verification and
commit follow the server support. Hosted rollout remains out of scope.
Implements the product spec
[extensions-tamloot.md](extensions-tamloot.md) on the platform in
[extensions.md](extensions.md) and [extensions-lambda.md](extensions-lambda.md).
Tamloot's side is implemented (Tamloot #2395, #2397, #2398;
`tamloot-monorepo/docs/integrations/retainer-api.md` §3–§7). Existing-code references were checked on `3d9bfa2` (the implementation
branch before this review). Paths below are relative to `packages/server/src`
unless a package is named. Line numbers are only navigation hints.

The work has two parts. Part A adds **member connections** to the extension
platform: a registration declares whether it connects once for the workspace
or once per member. Part A is generic. Nothing in it names Tamloot. Part B is
the Tamloot bundle that uses it.

Protecting `person.emails` (extensions-tamloot.md §3) is out of scope here
and tracked separately.

## 1. Decisions

| Question                                                   | Decision                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which extensions connect per member?                       | Each registration declares `connection: 'workspace'` or `'member'` in its manifest. Workspace registrations (Granola, company enrichment, last contact) behave exactly as today: the admin sets them up once and they apply to everyone. Only registrations whose source data belongs to one person, like Tamloot, declare `'member'`. |
| How are workspace installations stored after this change?  | Unchanged. They have no connection rows, and every per-installation table treats a null `connection_id` as the installation's own scope. No backfill and no change to existing bundles.                                                                                                                                                |
| What does the admin approve, and what does a member enter? | The admin installs and approves schema, actor, scopes, policies, consent and installation settings, as today. A member enters only connection settings: their own credential. A member registration may not declare installation-level secrets in v1.                                                                                  |
| What does a connection own?                                | Its secrets, KV, schedules, jobs, the one-run-at-a-time limit, the write budget, the source binding and the source scan state. The installation keeps release, grant, mapping, contributions and installation settings.                                                                                                                |
| How is a connection fenced?                                | A connection has its own `generation`. Jobs record it, run tokens carry it, and admission checks it beside the installation generation. Disconnect bumps it, exactly as disable bumps the installation's.                                                                                                                              |
| Whose rank do the writes carry?                            | The installation's granted actor (`integration`), never the member's `user` rank. The run actor names the connection, so history can show "Tamloot (Dana's account)".                                                                                                                                                                  |
| Who can connect?                                           | A person in accounts mode, or the user behind a user key in key mode. Agent keys, installation credentials and run tokens cannot. One connection per owner per installation.                                                                                                                                                           |
| What happens when a member leaves?                         | `endLostMemberships` disconnects owned connections wherever effective workspace membership ends, in the same transaction.                                                                                                                                                                                                              |
| Can a member registration take webhooks?                   | Not in v1. The manifest rejects `webhooks` with `connection: 'member'`. Tamloot polls (extensions-tamloot.md §5).                                                                                                                                                                                                                      |
| A task a person edited                                     | Kept and no longer synced (extensions-tamloot.md §6.1). The server checks all assertions under the task lock. A read followed by an ordinary delete can race a person's edit. Kept tasks are durably detached before source retraction (§4.6).                                                                                         |
| Create-people default                                      | `everyone`, as manifest ceiling and setting default (extensions-tamloot.md §6.2). The server already applies it (`sources/service.ts:552`).                                                                                                                                                                                            |
| Deleted sessions                                           | `onSourceDelete: 'retract'`. The policy is release-pinned today (`sources/service.ts:449`), so admins cannot switch it to `keep` in v1.                                                                                                                                                                                                |

## 2. Gaps in the current platform

- `connection` accepts only `'workspace'` (`packages/extension/src/index.ts:233`).
- Runtime state is installation-scoped: `extension_jobs` (one
  running job per installation, `extension_jobs_one_running_uq`),
  `extension_kv`, `extension_secrets`, `extension_pending_secrets`,
  `extension_write_budgets`, `extension_schedules`, `source_bindings` and
  `source_sync_state` (`db/schema.ts:1631-1870` and `2004-2065`). Jobs have
  an ID primary key and an installation/generation/dedupe unique constraint.
  Pending secrets have an ID primary key and `draft_installation_id`, not
  `installation_id`. The other tables have composite primary keys.
- Run tokens bind an installation and its generation, not a connection
  (`extension-runtime/tokens.ts:11-24`).
- Settings have one level, entered by the admin at install
  (`extensions/service.ts`). There is no way for a member to submit their own
  secret.
- No lifecycle hook runs per connection.
- The broker has SQL admission and adoption functions, separate role grants
  and authenticated encryption identity (`extension-runtime/secrets.ts`,
  `drizzle/0054_extension_secret_capabilities.sql`,
  `drizzle/0094_function_secret_admission.sql`). API scoping alone is unsafe.
- `sources/contract.ts` caps summaries at 20,000 characters and participants
  at 200. The product's uncapped notes need a larger bounded transport, with
  explicit errors rather than truncation. Keep a byte limit for requests.
- Public schema reads omit universal IDs (`test/api/schema.test.ts:111`).
  A bundle cannot resolve contributed fields through `describe_schema`.
- Assertion history is paginated (`api/routes/web-read.ts:48`, default 50,
  maximum 200). Reading its first page cannot prove a task was untouched.
- `db/migrate.ts` already requires Postgres 18 for `uuidv7()`. This work does
  not introduce a new Postgres 15 deployment requirement.

## 3. Part A: member connections

### 3.1 Manifest (`@retainer/extension`, MIT)

- `connection: z.enum(['workspace', 'member'])`.
- Each setting gains `level: 'installation' | 'connection'`, default
  `'installation'` when absent. Do not add a zod default: adding a serialized
  property would change existing release digests.
- Connection mode cannot change across releases of one registration. Use a
  new registration to change its ownership model.
- Two trigger kinds: `connect` and `disconnect`. They take lifecycle input
  like `install` and `uninstall` (`protocol.ts` `lifecycleInputSchema`).
- Validation in `defineExtension`:
  - `connection: 'workspace'` rejects `level: 'connection'` settings and
    `connect`/`disconnect` triggers.
  - `connection: 'member'` requires hosted execution and exactly one `connect` function, allows at
    most one `disconnect`, rejects `webhooks`, rejects
    `level: 'installation'` settings with `secret: true`, and requires
    `source.identity: 'account'` when `source` is present. Reject `change`,
    `route` and `serverRoute` triggers for members in v1: they have no owner
    selection contract. Reject connection-level sharing consent; consent is
    approved by the installer.
  - `source.verifyFunctionId` must be the `connect` function for a member
    registration.

### 3.2 Persistence

New table `extension_connections` (generated with `pnpm db:generate`):

| Column                                          | Notes                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `id`, `workspace_id`, `installation_id`         | Tenant FK to the installation, RLS like its siblings                                    |
| `owner`                                         | `jsonb` `Actor` of type `user`: the person (accounts mode) or the key's user (key mode) |
| `owner_id`                                      | Stored `text`, checked equal to `owner->>'id'`, for the unique index                    |
| `state`                                         | `connecting`, `active`, `setup_failed`, `needs_reconnect`, `disconnected`               |
| `health`, `last_error`                          | As on installations: `ok`, `needs_reconnect`, `degraded`                                |
| `generation`                                    | Fence, starts at 1, bumped by disconnect, reconnect and setup failure                   |
| `settings`, `settings_revision`                 | Non-secret connection settings                                                          |
| `created_at`, `connected_at`, `disconnected_at` |                                                                                         |

- Unique index on `(workspace_id, installation_id, owner_id)` where
  `state <> 'disconnected'`: one live connection per owner.
- A disconnected row stays, as provenance for the attribution in §3.6.
- `source_account_id` remembers the verified account after binding retirement.
  `disconnect_function_id` remembers the reviewed cleanup hook, so membership
  removal can queue it without importing the catalog into the lower layer.
- Check that `owner` is a user actor, generation and revisions are positive,
  and state and health use the allowed values. The tenant key is
  `(workspace_id, installation_id, id)`, unique for child FKs. A child cannot
  name another installation's connection, even inside the same workspace.
- RLS uses the workspace, like other runtime tables. Owner authorization is
  also enforced by the service. Never expose a broker table to the app role.

Add a nullable `connection_id` (tenant FK to `extension_connections`) to
`extension_jobs`, `extension_kv`, `extension_secrets`,
`extension_pending_secrets`, `extension_write_budgets`,
`extension_schedules`, `source_bindings` and `source_sync_state`. Replace
each scope primary key with a named `UNIQUE NULLS NOT DISTINCT` constraint
on `(workspace_id, installation_id, connection_id[, key/name/function_id])`.
A primary key cannot contain a nullable connection. Keep ID primary keys on
jobs and pending secrets. Change job dedupe to include both connection ID
and connection generation; retain installation generation too.
`extension_jobs_one_running_uq` becomes unique on
`(workspace_id, installation_id, connection_id) nulls not distinct` where
`status = 'running'`. Drizzle cannot express null equality on a partial
index, so use two generated partial indexes with the same effect: the null
workspace scope and the non-null member scopes. Connection ID and generation must both be null or both
present on a job. Pending-secret rows keep their draft installation ID and
bind an owner and draft connection ID before adoption.

Update every SQL `ON CONFLICT` target with the constraint change, including
broker functions. Drizzle generates the structural migration. Generate a
separate custom migration for SQL capabilities and role grants; never edit
a generated migration. Migration tests seed pre-change workspace state,
upgrade it, and prove KV CAS, secret adoption, job dedupe, scheduling and
source verification still work. Existing null-scope rows keep their values.

`source_bindings` gains a unique index on `(workspace_id, installation_id,
account_id)` across live connections, so the same Tamloot account cannot be
connected twice in one workspace (`source_account_in_use`).

Null `connection_id` keeps today's meaning everywhere, so workspace
installations need no migration of data.

### 3.3 Lifecycle

- **Connect.** `POST /v1/extensions/:id/connections` with connection
  settings and owner-bound pending secret references. Never accept an owner
  in the payload. Secrets go through the existing pending-secret broker
  (`extension_pending_secrets`), now with `connection_id`. The server creates
  the row in `connecting` and queues the `connect` function for it. `connect`
  verifies the account through `/source/verify`, which binds the
  connection's source account, then sets up its KV and children. Success
  moves the row to `active`; a failure moves it to `setup_failed` with the
  function's code. A member installation activates without running the
  connection hook or requiring a source binding. It has no schedules until
  someone connects. Approval validates only installation-level settings.
- **Reconnect.** `POST …/connections/:cid/reconnect` with new connection
  secrets and `expectedGeneration`. A stale form is refused before replacing
  a key. Bumps the connection generation, then runs `connect` with
  `previousVersion` set. A different source account is refused
  (`source_account_changed`); the member disconnects and connects again.
- **Disconnect.** `DELETE …/connections/:cid`. In one transaction: bump the
  generation, cancel its queued jobs, retire its schedules and source
  binding, schedule its secrets for deletion, set `disconnected`. Running
  attempts are fenced by admission. Then queue `disconnect` if declared, as a
  cleanup job without secrets or CRM access, admitted only for its current
  disconnected generation. The declared handler still runs; this is not
  the built-in system lifecycle job. Tamloot declares no disconnect hook.
  Imported records, events and provenance stay.
  Reconnecting the same account later resumes in the same source namespace,
  because source items are keyed by account.
- **Installation changes.** Disable, upgrade and uninstall act on the
  installation generation as today, which fences every connection. Enable and
  upgrade re-queue `connect` for every connection not `disconnected`.
  Uninstall disconnects every connection.
- **Member removal.** Extend `workspaces/leaving.ts:endLostMemberships`,
  which already covers organization removal, workspace removal, role loss
  and workspace moves. Disconnect only where effective membership is lost,
  in that same transaction. Connecting takes the shared member lock and
  rechecks membership; leaving takes its exclusive form. Use the existing
  organization, privacy, schema, membership, installation and queue lock
  order. Do not take the membership lock after the installation lock.
- **Workspace deletion.** `extension-runtime/workspace-deletion.ts` already
  starts uninstall and fences runs; it does not immediately remove state.
  Extend that transaction to disconnect members and retire their secrets.
  Final workspace deletion cascades all connection state. Imported CRM data
  survives a connection disconnect, not a workspace deletion.
- **Erasure.** Extend `privacy/extension-erasure.ts`. It can clear KV while
  advancing an installation generation today. Fence every affected member
  run, preserve connection generation checks when restamping durable jobs,
  and clear source cursors and task mappings that contain erased identities.
  A missing cursor starts a new head-before-backfill recovery. Erased source
  items remain blocked by source tombstones. Detachment is stored outside
  erasable KV and is itself erased with its record.

### 3.4 Runtime

- **Claim** (`queue.ts:774`). Cancel a job whose `connection_generation` no
  longer matches, or whose connection is not `active` (or `connecting` for
  its `connect` job), with code `connection_disconnected`.
- **Run token.** The binding gains `connectionId` (nullable) and
  `connectionGeneration`. `admitRun` checks the connection row under the same
  lock it takes for the installation. The job row must match both signed
  connection claims. Holding the installation lock shared drains admissions
  before a disconnect takes it exclusively. Broker admission uses that same
  order in its own transaction.
- **Runtime endpoints.** KV, checkpoint, secrets, write budget, source
  verify, source reservation and sync all read the connection from the run
  binding and scope to it. A run never names a connection in its request.
  Child jobs inherit the parent's connection and generation. Settings reads
  merge installation and connection values. Secret AAD adds the connection
  ID for member secrets; preserve old AAD for null scope. Stage and adoption
  bind owner, registration, installation, connection and expiry. Check them
  again under lock. Scope secret names, presence, rotation and retirement.
  Update SQL broker admission too. Disconnect revokes reads immediately;
  delayed ciphertext collection grants no access. Terminal auth failures
  affect only that connection. Reconnect cancels old jobs and schedules.
  Failed setup advances the fence and cancels its children. Retry, expiry
  and acknowledgement use the connection lifecycle, not installation failure.
  Child jobs inherit the parent's connection and generation; neither is an
  enqueue input. Settings reads merge installation and connection values.
  Secret AAD adds connection ID for member secrets; preserve the old AAD for
  null scope, so existing ciphertext still decrypts. Stage/adopt binds the
  owner, registration, installation, connection and expiry, checked again
  under lock. Secret names, presence, rotation and deletion are scoped too.
  Update SQL broker admission, not just the TypeScript wrapper. Disconnect
  revokes broker reads immediately; delayed ciphertext collection grants no
  access. Terminal provider auth errors affect only the current connection.
  Reconnect cancels old work before advancing its generation and removes
  stale schedules. Failed connection setup advances the fence and cancels
  its setup children. Retry, expiration and acknowledgement must use the
  connection lifecycle rather than failing the whole installation.
- **Schedules.** One `extension_schedules` row per connection and schedule
  function, created when the connection becomes `active`. The minute tick is
  unchanged otherwise.
- **Fair scheduling.** Discovery currently selects one candidate per
  installation, ordered by job availability. Select one per
  `(installation, connection)`, so one member's backfill cannot hide another's. The instance and workspace caps stay. Add a
  per-installation cap of 4 running connections, so one installation with
  many members cannot take every slot. Discovery SQL, capacity SQL and the
  executor's capacity accounting must agree. The current workspace
  cap is already 4, so the installation cap must not widen it. Order scopes
  by their last claim, not just oldest queued time, or an old backfill still
  monopolizes a slot. Add `last_claimed_at` to installations and connections,
  update it on claim, and use it in bounded discovery. Reclaim expired
  attempts before testing capacity.
- **Write budget.** 60 writes a minute per connection, inside the
  workspace's limit.

### 3.5 Who may do what

| Action           | Member (owner)   | Workspace admin            | Agent key, MCP            |
| ---------------- | ---------------- | -------------------------- | ------------------------- |
| Connect self     | Yes              | Yes, for themself          | No                        |
| Reconnect        | Own              | Own                        | No                        |
| Disconnect       | Own              | Any                        | No                        |
| List connections | Own              | All, with owner and health | Read-only, own key's user |
| See runs         | Own connection's | All                        | Read-only                 |

Installing still needs an admin. A member can connect only to an active
installation.

### 3.6 Attribution

Writes keep the installation's actor type and ID. The run actor gains
`name` "Tamloot (Dana's account)", built at token issue from the
registration's display name and the owner's stored name. Admission must
return this name on every request: changing token issue alone is insufficient,
because `admitRun` currently rebuilds an unnamed actor. No privileged read of
`users` is added to the app role. History shows it
as it does any actor name. No new actor field, so assertions, review and
winner logic are unchanged.

### 3.7 Interfaces

- REST: `GET/POST /v1/extensions/:id/connections`,
  `POST /v1/extensions/:id/connections/secrets` stages an owner-bound key,
  `POST /v1/extensions/:id/connections/:cid/reconnect`,
  `DELETE /v1/extensions/:id/connections/:cid`. `GET /v1/extensions/:id/runs`
  takes `connection`.
- SDK: `extensionConnections`, `connectExtension`, `reconnectExtension`,
  `disconnectExtension`, plus `stageExtensionConnectionSecret`.
  `reconnectExtension` overloads its existing workspace reconnect signature;
  existing clients keep that signature and its reviewed-plan flow.
- MCP: read-only, as for installations. MCP cannot connect.
- Web (`packages/web/src/routes/extensions.tsx`): a member registration's
  page shows "Your Tamloot connection" to everyone (connect, reconnect,
  disconnect, last sync, failed items) and, for admins, a table of every
  connection with its owner and health. Installation settings stay on the
  admin form.

## 4. Part B: the Tamloot bundle

### 4.1 Contract (`packages/runner/src/tamloot-contract.ts`)

```ts
defineExtension({
  manifestVersion: 1,
  universalId: TAMLOOT.registration,
  name: 'tamloot',
  execution: 'hosted',
  runtimeVersion: 'node24',
  protocolVersion: 1,
  requestedActor: 'integration',
  scopes: ['read', 'write'],
  connection: 'member',
  createPeople: 'everyone',
  onSourceDelete: 'retract',
  settings: {
    shareMeetings: {
      type: 'boolean',
      level: 'installation',
      consent: true,
      required: true,
      default: false,
      label: 'Members’ connected meetings are visible to the whole workspace',
    },
    createPeople: {
      type: 'string',
      level: 'installation',
      required: true,
      default: 'everyone',
      options: ['never', 'contacted_first', 'everyone'],
    },
    backfillDays: { type: 'number', level: 'connection', required: true, default: 31 },
    apiKey: {
      type: 'string',
      level: 'connection',
      secret: true,
      required: true,
      reconnect: true,
      label: 'Tamloot API key (read-only)',
    },
  },
  source: {
    provider: 'tamloot',
    identity: 'account',
    verifyFunctionId: TAMLOOT.connect,
    syncFunctionIds: [TAMLOOT.sync],
    scanFunctionIds: [TAMLOOT.scan, TAMLOOT.poll],
    eventTypeIds: [BASE_EVENT_TYPE_IDS.conversation],
    revisionOrder: 'integer',
  },
  schema: [
    {
      kind: 'field',
      objectId: BASE_OBJECT_IDS.task,
      definition: {
        universalId: TAMLOOT.taskIdField,
        name: 'tamlootTaskId',
        label: 'Tamloot task',
        type: 'text',
        isUnique: true,
        isSearchable: false,
        isNullable: true,
      },
    },
  ],
  views: [],
  functions: [
    fn(TAMLOOT.connect, 'connect', { kind: 'connect' }),
    fn(TAMLOOT.scan, 'scan', { kind: 'job' }),
    fn(TAMLOOT.poll, 'poll', { kind: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' }),
    fn(TAMLOOT.sync, 'sync-session', { kind: 'job' }),
  ],
});
```

The hosted bundle name is `tamloot` (within the 12-character limit). Revisions
are Tamloot txids, compared as `BigInt` by `sources/policy.ts:20`.

### 4.2 Tamloot client (`tamloot-provider.ts`)

Base URL from the release, never from settings: `https://api.tamloot.cc`.
The implemented `/v1/me` wraps `{user_id, email}` in `data`. Every response is parsed
with zod. 401 reports `provider_unauthorized`, which marks only the connection as
`needs_reconnect`. 429 and 5xx return retry with
the `Retry-After` hint: Tamloot's 10 requests a second is one limit for all
callers (retainer-api.md §2). Endpoints: `GET /v1/me`,
`GET /v1/changes/head`, `GET /v1/changes?cursor&limit=25`,
`GET /v1/sessions?from&to&limit=25&offset`, `GET /v1/sessions/{id}`,
`GET /v1/tasks?session_id`.

### 4.3 `connect`

1. `GET /v1/me`. Verify the source account as `user_id`; the server refuses a
   different account on reconnect.
2. On a first connect, or when `cursor` is missing: `GET /v1/changes/head`,
   then checkpoint `{cursor}` in KV and a `backfill` child for
   `now − backfillDays` in one call. On reconnect with a cursor, keep it.
3. Every connection setup also queues retained-item recovery through
   `GET /v1/extensions/:id/source-items`. It pages local IDs for this account,
   including reserved items whose import failed. Re-enable and upgrade cancel
   old-generation jobs too: retaining the feed cursor alone would lose that
   accepted work. Recovery never queues erased items. A retracted or deleted
   item is queued only when it has managed tasks still awaiting cleanup; that
   run can remove tasks but cannot recreate its meeting.

### 4.4 `backfill`

Read `GET /v1/sessions?from=&to=&limit=25&offset=`. The API returns
`pagination: {has_more, next_offset}`; it does not accept a session cursor.
Use fixed bounds per scan, follow `next_offset`, reject a stalled page, and
checkpoint the offset with children. List rows have no revision; completed
rows enqueue a fetch rather than comparing an absent revision. Reserve at
most 30 source items per batch, as the current runtime contract requires.

Use the platform's scan clocks and atomic checkpoint completion so the UI
reports enumeration and failed imports separately. Offset paging is not a
snapshot: concurrent deletion or movement can shift rows and skip an older
unchanged session. Do a second overlapping enumeration after the first;
report this upstream limit honestly. A head captured before enumeration
covers changed sessions, but cannot prove every unchanged row was listed.
Do not sweep retained items merely because a list omitted them.

### 4.5 `poll`

The schedule starts a typed updated-mode scan. Each scan job reads one
`/v1/changes` page of up to 25 entries and checkpoints its next page child.
Small pages keep each transaction and provider call bounded.
Each page collapses entries to session IDs (a task entry uses its
`session_id`). Reserve local source IDs in batches of at most 30, then
checkpoint the next cursor with every child in one transaction. Use a page
cursor hash in dedupe keys, together with the local
source item, so a task-only change still fetches an unchanged session
revision. Job input is only `{sourceItemId}`, never a provider ID or revision.

On a missing cursor after erasure, or `410 cursor_expired`, fetch `head` **before** the recovery enumeration,
then atomically checkpoint that cursor and a backfill child. Also refetch
previously imported live source items, including ones outside backfillDays:
otherwise an expired deletion could leave an old meeting and its tasks live
forever. The runtime list is `GET /v1/extensions/:id/source-items?limit&cursor`: only
local IDs, only this account, only pinned scan/setup functions.
After privacy clears KV, use the same recovery. Completed source task work
is tracked durably (§4.6); an unchanged evidence receipt cannot skip it.

### 4.6 `sync-session`

An entry's `op` is a hint; the fetch decides (retainer-api.md §4.4).

1. Resolve the provider ID from the admitted local source item. Fetch session
   detail. A definitive 410 or 404 means deletion; a 401 or 5xx never does.
   Fetch the tasks as well before changing evidence. Non-completed sessions
   wait for a later change. Keep numeric revisions as exact decimal strings;
   reject unsafe JavaScript integers rather than silently rounding a txid.
2. Import the session through `syncSourceEvent`, using **detail** `revision`,
   not the feed revision (a task entry has its own txid). Read the current
   revision for CAS. Prepare participant handles first as the source runtime
   requires. Join every note's title and Markdown content in returned order.
   Dedupe normalized emails; reject overflow explicitly. No silent note cap.
3. Reconcile the fetched tasks against durable task bindings under the source
   item and record locks. Do this even if the evidence import is unchanged:
   task changes do not advance Tamloot's session revision. Fetching session
   and tasks uses separate snapshots; repeat on a later feed entry and never
   treat their reads as an atomic provider snapshot.
4. A source-linked task a person edited is kept and permanently detached.
   The server checks **all** assertions, regardless of page or status, under
   the same record lock as update/delete. A person edit racing reconciliation
   either commits first and protects the task, or waits and sees the result.
   Never follow a merged task ID to delete a survivor. Persist detachment in
   a source-task binding, not by merely dropping a KV map entry. A replay,
   source restore, reconnect or a task moved between sessions must not attach
   it again. Untouched missing tasks are soft-deleted. A locally deleted or
   forgotten task never reappears. A task moved between Tamloot sessions may
   reuse its server-removed record; it never creates a second identity.

**Server support for kept tasks.** The outcome in the product spec §6.1 stays
settled. Its claim that no server work is needed cannot hold under concurrent
edits or evidence replacement. Replacing or deleting source evidence retracts
its task assertions before an adapter can inspect them. Add a release-pinned
managed-task capability, a durable `(account, provider task ID)` binding and
server reconciliation. Before retracting old evidence, detach edited tasks
under their locks. Preserve their current values as installation-ranked
assertions without a live source dependency, retaining the original sourced
assertions in history. Never create user-ranked assertions on their behalf.
Untouched tasks are reconciled to the new event. A failed task write remains
pending and replayable even after the source event receipt has committed.
Keep this operation inside the existing privacy/schema/source/record lock
order. Test updates and source retraction concurrently.

**Schema bindings.** Declare task output fields by universal ID in the reviewed
managed-task capability; the server resolves them under its schema lock.
Return current API names and binding health on a bounded runtime surface,
as the enrichment mapping does. Do not expose every schema universal ID to
normal callers or add field-name guesses to the adapter. Resolve the task
object, title, status, person relation and contributed ID field. Missing or
incompatible task fields skip task reconciliation and report degraded health;
meeting sync continues. `todo` is not protected: verify that the installed
status options still include it before writing. Match contact emails through
unique identifiers; conflicting people stay unresolved, never choose the
first match. Contribute no protection for `person.emails` in this work.

**Limits.** Notes are not truncated to 20,000 characters. Raise the managed
source summary limit consistently with the HTTP body limit and canonical
hashing; reject a transport overflow explicitly. The API returns at most 500
tasks without a pagination flag. A response at that ceiling is incomplete
for deletion purposes: upsert returned tasks, report degraded health, and
skip absence-based deletion. Test this with fixtures. No Tamloot-side change
is part of this work.

### 4.7 Managed tasks on the server

The source policy gains `tasks`: object, identity, title, status and optional
person-field universal IDs, plus the source's open/done status mapping. The
identity field must be a contributed unique text field. The server resolves
all bindings under the schema lock. No client picks a field or record ID.
`GET /v1/extensions/:id/source-tasks/schema` returns current names and binding
health to a live run, without changing public schema reads.

`source_tasks` binds `(account, provider task ID)` to one record, its current
source item/event, the installation and its display actor. States distinguish
synced, human-detached, locally deleted and provider-removed tasks. This
survives KV erasure, reconnect and reinstall. A moved task can restore only a
record this reconciler removed; it never restores a local deletion, follows a
merged ID to delete a survivor, or reattaches a human-detached task.

`POST /v1/extensions/:id/source-items/:item/tasks` accepts the current event
revision, the task-write revision read before fetching provider state, the
fetched task list and whether that list is complete. Only the
item's pinned ingestion job can call it. It checks the revision under the
account task lock, then sorted source item rows for every affected item,
then the source event and sorted task records. The account lock serializes
moves across sessions and avoids hundreds of advisory locks for a large list.
A concurrent task snapshot that already advanced the task-write revision rejects the older
snapshot. A task moved between items also advances the previous item’s
task-write revision; a stale old-session snapshot must refetch. An unchanged
task writes no assertions. User history is checked under those same locks.
Each request changes at most 30 task roots and returns `hasMore` and a server checkpoint. It
charges the connection's write budget for changed roots. Ordinary relation
cascades use the normal deletion lifecycle, including event retraction. If a
cascade would delete another edited managed task, removal fails with
`source_task_delete_conflict`; it must not silently discard that edit.
A child ingestion job continues from that checkpoint, so a large regeneration does not exhaust
one job's retry allowance. Each child refetches current provider state.
Task creates and updates use the normal value validator. Added required fields
produce field-specific errors; the importer cannot bypass workspace constraints.

Retraction detaches edited managed tasks before retracting their source
assertions, including ordinary event deletion. It copies current sourced
values as installation-ranked direct assertions; existing human assertions
keep normal precedence. The original sourced assertions stay in history.
This does not manufacture user-ranked writes or change general precedence.

Privacy erasure is stronger than provider removal. It erases associated task
records and mappings, including detached copies derived from that source,
and writes keyed task-identity tombstones. Forgetting a task suppresses that
task without erasing its meeting. Recovery and retries check those tombstones.
Workspace deletion cascades the new store. No raw provider task ID or copied
text stays in an erasure receipt, KV, job input or diagnostic.

Polling starts a typed operation-clock scan and queues a page job, as Granola
does. That job drains the feed and completes the scan checkpoint. The same
page function handles created-mode backfill and updated-mode feed scans.
Provider cursors still decide what to read; these clocks do not filter the
feed. This preserves the platform's scan/import status distinction.

## 5. Hosted rollout (`retainer-cloud`)

Add `tamloot` to the production bundle list and apply its Lambda through the
local tfvars, as for company enrichment. The Tamloot base URL is part of the
release. Retainer already requires Postgres 18. Hosted verification is part of
rollout, not an instruction to access or change retainer-cloud here.

## 6. Tests

Real Postgres, a fresh database per file, no mocked database.

- **Manifest:** member/workspace validation rules in §3.1; old manifests keep
  their digests.
- **Connections:** connect, reconnect, disconnect, admin disconnect, member
  removal; a workspace installation unaffected; runs, KV, secrets and
  budgets isolated between two members.
- **Concurrency:** two members connecting the same Tamloot account at once
  (one wins, `source_account_in_use`); disconnect racing a running job (the
  job's writes are fenced); member removal racing a connect; two polls for one
  connection (one runs).
- **Adapter, against Tamloot fixtures:** backfill; edit and regenerated
  notes (new revision, derived evidence retracted); task regeneration with
  an untouched task removed and a person-edited task kept; session deletion
  (tombstone, 410, 404, and a delete hint for a restored session);
  `cursor_expired`; 401 to `needs_reconnect`; 429 back-off; two members
  recording one meeting (two events in v1).
- **Migration and broker:** upgrade populated null-scope tables; tenant FKs
  reject another installation's connection; RLS isolates tenants; the app
  cannot read ciphertext; swapped connection ciphertext fails AAD; staged
  secrets cannot be stolen by another owner; broker read races disconnect.
- **Privacy and lifecycle:** forget while a member run holds content; cursor
  loss recovery; workspace deletion; effective membership loss through every
  path; reconnect and setup failure fence children; one 401 cannot fail peers.
- **Task races:** an edit beyond the first assertion page; source replacement
  and deletion preserve edited tasks; retry and reconnect cannot reattach;
  moved tasks, merged-away tasks, missing status option, task-only feed change,
  partial failure after evidence import and a 500-task response.
- **Web:** a member connects, sees status and disconnects; an admin sees
  every connection.

## 7. Delivery sequence

1. Manifest and validation (MIT package), with old-digest tests. Done in
   `baea95a`; full typecheck, lint and tests passed.
2. Migration: `extension_connections`, connection scope constraints, broker
   SQL capabilities and populated workspace-state upgrade tests. Persistence
   and null-scope compatibility, member broker admission and lifecycle are
   implemented and tested locally.
3. Lifecycle, REST, SDK, read-only MCP and effective member removal. Implemented
   and tested locally.
4. Runtime scoping: claim, run token, admission, runtime endpoints,
   schedules, fair claims, budgets and account-scoped recovery reads. Implemented
   and tested locally.
5. Web: connection card, staged member credentials, reconnect generation
   preconditions and admin table. Implemented and tested locally, including
   real-Postgres browser coverage.
6. Managed-task server support and schema bindings are implemented and
   tested. The Tamloot bundle and provider fixtures are implemented; final
   verification and their own commit follow the server support.
7. Hosted rollout and a live test with a real Tamloot key. Out of scope for
   this branch task; do not access retainer-cloud.

## 8. Later

Tamloot webhooks with a per-connection `route`, the transcript as a `files`
field, `medium`, a `tamlootUrl` link, merging one meeting recorded by two
members, organization-wide Tamloot keys, an admin choice of
`onSourceDelete`, and protecting `person.emails`.
