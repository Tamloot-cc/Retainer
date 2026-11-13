# Member connections and the Tamloot extension: implementation spec

Status: proposed, 2026-11-13. Not implemented. Implements the product spec
[extensions-tamloot.md](extensions-tamloot.md) on the platform in
[extensions.md](extensions.md) and [extensions-lambda.md](extensions-lambda.md).
Tamloot's side is implemented (Tamloot #2395, #2397, #2398;
`tamloot-monorepo/docs/integrations/retainer-api.md` §3–§7). Line references
are to `main` at `2f3d41f`.

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
| What happens when a member leaves?                         | `removeFromOrganization` (`accounts/people.ts`) disconnects every connection that person owns, in the same transaction.                                                                                                                                                                                                                |
| Can a member registration take webhooks?                   | Not in v1. The manifest rejects `webhooks` with `connection: 'member'`. Tamloot polls (extensions-tamloot.md §5).                                                                                                                                                                                                                      |
| A task a person edited                                     | Kept and no longer synced (extensions-tamloot.md §6.1). The adapter reads the task's assertions and keeps it if any actor is a `user`. No server change: both routes accept run tokens today (`web-read.ts:48`, `records.ts:79`).                                                                                                      |
| Create-people default                                      | `everyone`, as manifest ceiling and setting default (extensions-tamloot.md §6.2). The server already applies it (`sources/service.ts:552`).                                                                                                                                                                                            |
| Deleted sessions                                           | `onSourceDelete: 'retract'`. The policy is release-pinned today (`sources/service.ts:449`), so admins cannot switch it to `keep` in v1.                                                                                                                                                                                                |

## 2. Gaps in the current platform

- `connection` accepts only `'workspace'` (`packages/extension/src/index.ts:233`).
- Every runtime table is keyed by installation alone: `extension_jobs` (one
  running job per installation, `extension_jobs_one_running_uq`),
  `extension_kv`, `extension_secrets`, `extension_pending_secrets`,
  `extension_write_budgets`, `extension_schedules`, `source_bindings` and
  `source_sync_state` (primary keys on `(workspace_id, installation_id[, …])`,
  `db/schema.ts:1631-1870` and `2004-2065`).
- Run tokens bind an installation and its generation, not a connection
  (`extension-runtime/tokens.ts:11-24`).
- Settings have one level, entered by the admin at install
  (`extensions/service.ts`). There is no way for a member to submit their own
  secret.
- No lifecycle hook runs per connection.

## 3. Part A: member connections

### 3.1 Manifest (`@retainer/extension`, MIT)

- `connection: z.enum(['workspace', 'member'])`.
- Each setting gains `level: 'installation' | 'connection'`, default
  `'installation'`, so existing manifests and their digests are unchanged.
- Two trigger kinds: `connect` and `disconnect`. They take lifecycle input
  like `install` and `uninstall` (`protocol.ts` `lifecycleInputSchema`).
- Validation in `defineExtension`:
  - `connection: 'workspace'` rejects `level: 'connection'` settings and
    `connect`/`disconnect` triggers.
  - `connection: 'member'` requires exactly one `connect` function, allows at
    most one `disconnect`, rejects `webhooks`, rejects
    `level: 'installation'` settings with `secret: true`, and requires
    `source.identity: 'account'` when `source` is present.
  - `source.verifyFunctionId` must be the `connect` function for a member
    registration.

### 3.2 Persistence

New table `extension_connections` (generated with `pnpm db:generate`):

| Column                                          | Notes                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `id`, `workspace_id`, `installation_id`         | Tenant FK to the installation, RLS like its siblings                                    |
| `owner`                                         | `jsonb` `Actor` of type `user`: the person (accounts mode) or the key's user (key mode) |
| `owner_id`                                      | `text`, `owner->>'id'`, for the unique index                                            |
| `state`                                         | `connecting`, `active`, `setup_failed`, `needs_reconnect`, `disconnected`               |
| `health`, `last_error`                          | As on installations: `ok`, `needs_reconnect`, `degraded`                                |
| `generation`                                    | Fence, starts at 1, bumped by disconnect, reconnect and setup failure                   |
| `settings`, `settings_revision`                 | Non-secret connection settings                                                          |
| `created_at`, `connected_at`, `disconnected_at` |                                                                                         |

- Unique index on `(workspace_id, installation_id, owner_id)` where
  `state <> 'disconnected'`: one live connection per owner.
- A disconnected row stays, as provenance for the attribution in §3.6.

Add a nullable `connection_id` (tenant FK to `extension_connections`) to
`extension_jobs`, `extension_kv`, `extension_secrets`,
`extension_pending_secrets`, `extension_write_budgets`,
`extension_schedules`, `source_bindings` and `source_sync_state`. Replace
each primary key or unique key that ends in `installation_id` with a unique
index `nulls not distinct` that adds `connection_id` (Postgres 15 or later;
Compose runs 18, and hosted must be confirmed). `extension_jobs` also gains
`connection_generation`. `extension_jobs_one_running_uq` becomes unique on
`(workspace_id, installation_id, connection_id) nulls not distinct` where
`status = 'running'`.

`source_bindings` gains a unique index on `(workspace_id, installation_id,
account_id)` across live connections, so the same Tamloot account cannot be
connected twice in one workspace (`source_account_in_use`).

Null `connection_id` keeps today's meaning everywhere, so workspace
installations need no migration of data.

### 3.3 Lifecycle

- **Connect.** `POST /v1/extensions/:id/connections` with connection
  settings. Secrets go through the existing pending-secret broker
  (`extension_pending_secrets`), now with `connection_id`. The server creates
  the row in `connecting` and queues the `connect` function for it. `connect`
  verifies the account through `/runtime/source/verify`, which binds the
  connection's source account, then sets up its KV and children. Success
  moves the row to `active`; a failure moves it to `setup_failed` with the
  function's code.
- **Reconnect.** `POST …/connections/:cid/reconnect` with new connection
  secrets. Bumps the connection generation, then runs `connect` with
  `previousVersion` set. A different source account is refused
  (`source_account_changed`); the member disconnects and connects again.
- **Disconnect.** `DELETE …/connections/:cid`. In one transaction: bump the
  generation, cancel its queued jobs, retire its schedules and source
  binding, schedule its secrets for deletion, set `disconnected`. Running
  attempts are fenced by admission. Then queue `disconnect` if declared, as a
  system job without secrets. Imported records, events and provenance stay.
  Reconnecting the same account later resumes in the same source namespace,
  because source items are keyed by account.
- **Installation changes.** Disable, upgrade and uninstall act on the
  installation generation as today, which fences every connection. Enable and
  upgrade re-queue `connect` for every connection not `disconnected`.
  Uninstall disconnects every connection.
- **Member removal.** `removeFromOrganization` disconnects the person's
  connections in every workspace of the organization, in its own
  transaction, before the membership row is deleted.
- **Workspace deletion.** `extension-runtime/workspace-deletion.ts` already
  removes per-installation state; extend it to connection rows and their
  secrets.

### 3.4 Runtime

- **Claim** (`queue.ts:774`). Cancel a job whose `connection_generation` no
  longer matches, or whose connection is not `active` (or `connecting` for
  its `connect` job), with code `connection_disconnected`.
- **Run token.** The binding gains `connectionId` (nullable) and
  `connectionGeneration`. `admitRun` checks the connection row under the same
  lock it takes for the installation.
- **Runtime endpoints.** KV, checkpoint, secrets, write budget, source
  verify, source reservation and sync all read the connection from the run
  binding and scope to it. A run never names a connection in its request.
- **Schedules.** One `extension_schedules` row per connection and schedule
  function, created when the connection becomes `active`. The minute tick is
  unchanged otherwise.
- **Fair scheduling.** The claim order that rotates across installations
  rotates across `(installation, connection)`, so one member's backfill
  cannot starve another member's. The instance and workspace caps stay. Add a
  per-installation cap of 4 running connections, so one installation with
  many members cannot take every slot.
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
registration's display name and the owner's current name. History shows it
as it does any actor name. No new actor field, so assertions, review and
winner logic are unchanged.

### 3.7 Interfaces

- REST: `GET/POST /v1/extensions/:id/connections`,
  `POST /v1/extensions/:id/connections/:cid/reconnect`,
  `DELETE /v1/extensions/:id/connections/:cid`. `GET /v1/extensions/:id/runs`
  takes `connection`.
- SDK: `extensionConnections`, `connectExtension`, `reconnectExtension`,
  `disconnectExtension`.
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
    shareMeetings: { type: 'boolean', level: 'installation', consent: true,
      required: true, default: false,
      label: 'Members’ connected meetings are visible to the whole workspace' },
    createPeople: { type: 'string', level: 'installation', required: true,
      default: 'everyone', options: ['never', 'contacted_first', 'everyone'] },
    backfillDays: { type: 'number', level: 'connection', required: true, default: 31 },
    apiKey: { type: 'string', level: 'connection', secret: true, required: true,
      reconnect: true, label: 'Tamloot API key (read-only)' },
  },
  source: {
    provider: 'tamloot',
    identity: 'account',
    verifyFunctionId: TAMLOOT.connect,
    syncFunctionIds: [TAMLOOT.syncSession],
    scanFunctionIds: [TAMLOOT.backfill, TAMLOOT.poll],
    eventTypeIds: [BASE_EVENT_TYPE_IDS.conversation],
    revisionOrder: 'integer',
  },
  schema: [{ kind: 'field', objectId: BASE_OBJECT_IDS.task, definition: {
    universalId: TAMLOOT.taskIdField, name: 'tamlootTaskId', label: 'Tamloot task',
    type: 'text', isUnique: true, isSearchable: false, isNullable: true } }],
  views: [],
  functions: [
    fn(TAMLOOT.connect, 'connect', { kind: 'connect' }),
    fn(TAMLOOT.backfill, 'backfill', { kind: 'job' }),
    fn(TAMLOOT.poll, 'poll', { kind: 'schedule', cron: '*/5 * * * *', timezone: 'UTC' }),
    fn(TAMLOOT.syncSession, 'sync-session', { kind: 'job' }),
  ],
});
```

The hosted bundle name is `tamloot` (within the 12-character limit). Revisions
are Tamloot txids, compared as `BigInt` by `sources/policy.ts:20`.

### 4.2 Tamloot client (`tamloot-provider.ts`)

Base URL from the release, never from settings. Every response is parsed
with zod. 401 throws `needs_reconnect`. 429 and 5xx throw `RetryLater` with
the `Retry-After` hint: Tamloot's 10 requests a second is one limit for all
callers (retainer-api.md §2). Endpoints: `GET /v1/me`,
`GET /v1/changes/head`, `GET /v1/changes?cursor&limit=500`,
`GET /v1/sessions?from&cursor`, `GET /v1/sessions/{id}`,
`GET /v1/tasks?session_id`.

### 4.3 `connect`

1. `GET /v1/me`. Verify the source account as `user_id`; the server refuses a
   different account on reconnect.
2. On a first connect, or when `cursor` is missing: `GET /v1/changes/head`,
   then checkpoint `{cursor}` in KV and a `backfill` child for
   `now − backfillDays` in one call. On reconnect with a cursor, keep it.

### 4.4 `backfill`

Pages `GET /v1/sessions?from=`. For each page: reserve the session IDs as
source items, queue one `sync-session` per session whose
`recording_status` is `completed` and whose stored revision differs, and
checkpoint the page cursor with the children. Same shape as Granola's
`scan` (`granola.ts:260-330`).

### 4.5 `poll`

Drains `/v1/changes` from the KV cursor, page by page, within its deadline.
Each page collapses entries to session IDs (a task entry uses its
`session_id`) and checkpoints the next cursor with one `sync-session` child
per session, dedupe key `session:<id>:<revision>`. It never reads a time
window, so a missed run loses nothing. `410 cursor_expired` queues a
`backfill` over `backfillDays` and resets the cursor from `head`, in one
checkpoint.

### 4.6 `sync-session`

An entry's `op` is a hint; the fetch decides (retainer-api.md §4.4).

1. `GET /v1/sessions/{id}`. 410 or 404: `markSourceUnavailable` with
   `deleted`, then remove its tasks (step 4 with an empty list), and stop.
   Not `completed`: stop.
2. `syncSourceEvent` with `providerRevision: revision`, `conversation`,
   `occurredAt: session_date`, `title`, `summary`: the notes' Markdown joined
   in order, no length cap, and `participants`: every email of every listed
   participant, with its name. `medium` empty, no transcript, no extra
   conversation field.
3. `GET /v1/tasks?session_id=`. For each task, `upsert_record` on `task`
   with `match: {tamlootTaskId}`, `ifMissing: 'create'`, `source`: the event
   from step 2, `title`: content, `status`: `open` → `todo`, `done` → `done`,
   `person`: the record matched by `contact_emails`, if exactly one.
4. Reconcile. KV key `tasks:<sessionId>` holds the Tamloot task IDs synced
   last time with their Retainer record IDs. For each one missing from the
   new list: read `GET /v1/records/:id/assertions`. If any assertion's actor
   is a `user`, keep the task and drop it from the map (it no longer syncs).
   Otherwise `DELETE /v1/records/:id`. Checkpoint the new map.

The task field and the base task fields are resolved by universal ID through
`describe_schema`. A missing `tamlootTaskId` field skips steps 3 and 4 and
reports `degraded`; the session still syncs.

## 5. Hosted rollout (`retainer-cloud`)

Add `tamloot` to the production bundle list and apply its Lambda through the
local tfvars, as for company enrichment. The Tamloot base URL is part of the
release. Confirm the hosted Postgres is version 15 or later for
`nulls not distinct`.

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
- **Web:** a member connects, sees status and disconnects; an admin sees
  every connection.

## 7. Delivery sequence

1. Manifest and validation (MIT package).
2. Migration: `extension_connections`, `connection_id` columns and indexes.
3. Lifecycle, REST, SDK and member removal.
4. Runtime scoping: claim, run token, admission, runtime endpoints,
   schedules, fair claims, budgets.
5. Web: connection card and admin table.
6. Tamloot bundle, fixtures and tests. Can start beside step 3, against the
   new manifest.
7. Hosted rollout and a live test with a real Tamloot key.

## 8. Later

Tamloot webhooks with a per-connection `route`, the transcript as a `files`
field, `medium`, a `tamlootUrl` link, merging one meeting recorded by two
members, organization-wide Tamloot keys, an admin choice of
`onSourceDelete`, and protecting `person.emails`.
