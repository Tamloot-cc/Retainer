# Tamloot extension

Status: proposal, 2026-11-11. Not implemented. Extends
[extensions.md](extensions.md). The Tamloot API work is specified in the
Tamloot monorepo at `docs/integrations/retainer-api.md`. The implementation
plan is [extensions-tamloot-implementation.md](extensions-tamloot-implementation.md).

## 1. Decision

Tamloot ingestion is a **hosted first-party adapter that pulls from Tamloot's
public API**, the same pattern as Granola. This replaces §1 of extensions.md,
which describes Tamloot as a standalone app writing through the public API.
The reasons:

- The `install`, `job` and `schedule` triggers already run on
  `feat/extensions`. Installation OAuth for standalone apps does not exist.
- A pull adapter keeps Retainer-specific code out of Tamloot. Tamloot stores
  no Retainer credentials, base URLs or retry state.
- Polling also reaches private self-hosted servers, which a Tamloot push
  cannot.
- The Tamloot API changes are generic, so the same work serves other
  connectors.

The standalone model still fits Tamloot _reading_ Retainer later, for example
meeting prep that pulls CRM context. That is out of scope here.

V1 polls. Tamloot webhooks and Retainer's `route` ingress come later (§5).

## 2. Member connections

Tamloot's data and keys belong to one user, and the organization-wide
credentials are blocked on Tamloot's access model v2. Each workspace member
therefore connects their own Tamloot account. This brings the **personal
connections** that §1 of extensions.md defers into v1, as one connection per
member under a workspace installation. The installation itself stays as it
is: one per workspace and registration.

**Manifest.** `connection: 'member'` joins `'workspace'`. Each registration
chooses one. Extensions an admin sets up once for everyone, such as company
enrichment and Granola, stay `'workspace'`. Settings get a level:
installation settings (no secrets) are approved by the admin, and connection
settings (the Tamloot API key, `secret: true`, `reconnect: true`) are entered
by each member. Where the operator configured Tamloot's OAuth client, a member
connects with **Connect with Tamloot** instead, and the key stays a secondary
option; the method is fixed per connection
([extensions-tamloot-connect.md](extensions-tamloot-connect.md)).

**Who does what.**

- A human admin installs once. Before setup, Tamloot's catalog card says that
  what members connect is visible to everyone in the workspace. During setup
  the admin gives this consent, chooses the create-people and
  source-deletion policies, and reviews the schema and the actor
  (`integration`). The review shows those choices as rows, not as
  warnings.
- A member opens the installation and connects their own account. The
  connection is owned by the member's identity: the person in accounts mode,
  or the user actor of their key in key mode.
- A member can disconnect their own connection, and an admin can disconnect
  any. Removing a member from the workspace disconnects their connections in
  the same transaction.
- Disable, enable, upgrade and uninstall act on every connection.

**Store.** A new table, `extension_connections`, holds:

- workspace, installation, owner identity;
- the source account ID (the Tamloot `user_id` from `GET /v1/me`);
- a secret reference, state, health, generation/fence, created and
  disconnected times.

It is unique on `(installation, owner)` and on
`(installation, source account)`, so the same Tamloot account cannot be
connected twice in one workspace.

**Scoping.** Secrets, KV, schedules, jobs, write budgets and the
one-run-at-a-time limit move from the installation to the connection. Run
tokens gain a `connectionId` claim. Admission checks the installation and the
connection fence. Fair scheduling spreads work across connections so that one
member's backfill cannot starve another member's.

**Attribution.** Writes use the installation's actor, never the member's
`user` rank. The connection owner is stored as `triggeredBy`-style attribution
(§8 of extensions.md) and shown in history as "Tamloot (Dana's account)".

**Revocation.** Disconnect fences the connection's runs exactly as disable
fences an installation, cancels its jobs and deletes its secret. Imported
records, events and provenance stay. Reconnecting the same Tamloot account
resumes in the same source namespace. A different account needs a new
connection.

**Self-hosted key mode** works the same way. Each person's user key owns that
person's connection. An agent key cannot connect.

**UI.** Every member sees a "Your Tamloot connection" card: connect,
reconnect, disconnect, last sync, and failed items. Admins see every
connection with its owner and health.

## 3. Adapter

**Functions.**

- `configure` (configure trigger, read-only, uses the model): suggests where
  meetings, tasks and people go before the install review (§3.1).
- `connect` (an install-type hook, run per connection): calls `/v1/me`, binds
  the source account, stores `/v1/changes/head` as the cursor in KV, and
  enqueues the backfill.
- `backfill` (job): pages `GET /v1/sessions?from=<now-31d>`. A member can
  request up to 3,650 days. Enqueues one `sync-session` per completed session.
- `poll` (schedule, `*/5 * * * *`): reads `/v1/changes`, collapses entries
  to session IDs, then checkpoints the new cursor and the child jobs
  atomically, with dedupe key `session:<id>:<revision-or-change-id>`. A task
  change enqueues `sync-session` for the task's `source_session_id`. Each run
  drains the feed: it checkpoints page after page until `has_more` is false,
  within its time budget, and the next run continues from the saved cursor.
  It never reads a time window, so missed or failed runs lose nothing; the
  cursor waits. Tamloot's cursor cannot skip a late-committing change
  (retainer-api.md §4.3). On `410 cursor_expired` (an outage longer than
  Tamloot's 90-day retention), it rescans the backfill window and restarts
  from `head`.
- `sync-session` (job): fetches the session detail and the session's tasks. It imports the session revision, then reconciles the tasks
  (below). A feed entry's `op` is only a hint (retainer-api.md §4.4): a
  tombstone also enqueues `sync-session`, and the fetch decides. 200 imports,
  410 or 404 is the deletion. Tamloot can keep a `delete` entry for a session
  that was restored in a racing transaction, so acting on `op` alone could
  remove a live session.
- `disconnect`: reads `oauthTokens` and gives Retainer's Tamloot sessions up
  with `DELETE /v1/access`, retrying for up to 24 hours. A key connection has
  nothing to clean up, because no webhooks are registered. The same hook runs
  with `{ keep: 'current' }` after a failed OAuth connect, to give up the
  sessions that connect no longer wants
  ([extensions-tamloot-connect.md](extensions-tamloot-connect.md) §4.7, §5.7).

**Why the session is the unit.** Tamloot regenerates notes by deleting every
task of the session and creating new ones, and writes the tasks before the
notes commit. Tasks are written citing the current revision's event. If a
task synced on its own before its session's new revision, it would cite the
old event and lose its values when that event's derived assertions are
retracted. Syncing both in one job, revision first, avoids that.

**Session → `conversation` event**, imported through `sync_source_event`
(§10 of extensions.md):

- source item: `(registration, Tamloot user_id, session id)`;
  `providerRevision` is Tamloot's integer `revision`, compared numerically.
- `channel: "tamloot"`, `externalId`: the session ID.
- `occurredAt: session_date`; `title`; `summary`: the notes as Markdown, in
  the order Tamloot returns them, AI notes and the user's own notes alike,
  with no length cap.
- `participants`: the emails of every contact Tamloot lists in
  `participants`. Tamloot already leaves out rooms, group calendars and the
  owner's own addresses. Unmatched participants follow the install's
  create-people policy, which uses the participant's `name`.
- `medium` stays empty, and there is no transcript and no contributed field
  on `conversation` in v1 (see §5).
- Only sessions with `recording_status: completed` are imported. Scheduled
  and failed sessions are skipped until they complete.

**Tasks → `task` records.** The user chose to sync Tamloot's tasks under the
same registration.

- Contributed field on the base `task` object: `tamlootTaskId` (text,
  `isUnique`, not searchable).
- Each task: `upsert_record` with `match: {tamlootTaskId}`,
  `ifMissing: "create"`, and `source`: the current revision's event. Values:
  `title`: the task content; `status`: `open` becomes `todo`, `done` stays
  `done`; `person`: the person matched by the task's `contact_emails`, if one
  exists.
- Tamloot leaves out requests addressed to Tamloot itself.
- A Tamloot task that is gone (a tombstone, or missing from the session's
  current task list) has its Retainer task soft-deleted, unless a person has
  edited it in Retainer. In that case it is kept and no longer synced
  (decided, §6).
- **Rank.** Tamloot's tasks are model output written as `integration`, so an
  agent's different value goes to `pending_review`. A person's edit still
  wins.

**Matching and workspace schema changes.** The adapter sends participant
emails; the server matches them when it imports the event, as it does for any
logged event (ARCHITECTURE.md 1.2 and 4.1). Matching never uses field names:

- A lowercased email is looked up among the values of every unique email
  field in `record_identifiers`. With the base schema, that is
  `person.emails`, found by its universal ID. An email claimed by two records
  is reported as `ambiguous` and linked to neither.
- Renaming objects or fields changes nothing. The base objects and
  `task.status`/`task.dueDate` are protected, and the adapter resolves every
  other field by universal ID through `describe_schema`, never by name.
- `person.emails` is not protected today. If a workspace deletes it or makes
  it non-unique, participants come back unmatched, and no person can be
  created from a meeting. The sync then shows the admin a warning. Because the
  create-people policy makes the server depend on that field,
  `person.emails` joins `PROTECTED_FIELD_IDS` in the same change, as the
  protection rule requires.
- The field this extension contributes (`tamlootTaskId`) is tracked by
  universal ID. If it is removed, task sync is skipped and the connection reports `degraded`; the rest of the sync
  continues. The same applies to the unprotected base task fields the
  adapter writes (`title`, `person`).

**Deletion.** `onSourceDelete: "retract"` is the default for this
registration. Deleting a session in Tamloot is a deliberate act and arrives as
a feed tombstone, verified by a 410 or 404 from the session fetch. Admins can
choose `keep` with the optional "Meetings deleted in Tamloot" setting, at setup
or later in Settings.

**Limits.** A 31-day backfill of 60 sessions with 5 tasks each is about 360
writes, or 6 minutes at the default 60 writes a minute per connection.

### 3.1 Suggested bindings

Workspaces have no built-in objects, so meetings, tasks and people may live
under other names: a `call` event type, an `action` object with a `state`
select, a `contact` object. The server's fixed default matches by name only
(no-built-in-objects §5.4) and would create new objects beside them. So the
release has a `configure` function (configure spec §2) that asks a model.

`configure` is read-only, declares `uses: ['model']` and reads no secret: it
runs at access approval, before any member connects Tamloot, so it never
calls Tamloot. Code: `packages/runner/src/tamloot-configure.ts`.

**Input.** One structured call to `claude-opus-5-5` through the model proxy
(`model-call.ts`, shared with Enrichment). The user message is JSON:

```ts
{
  bindings: {                        // TAMLOOT_BINDINGS, in order
    key: 'meeting' | 'task' | 'person';
    label: string; description: string; required: boolean;
    fields: {                        // title, status, person; name, emails
      key: string; label: string; description?: string;
      types: FieldType[]; required: boolean;
      values?: string[];             // status: ['open', 'done']
      target?: string;               // task.person targets 'person'
    }[];
    candidates: {                    // objects of the binding's class, at most 25
      name: string;                  // API name
      label: string; description: string | null;
      recentRecords: string[];       // up to 3 labels of recently updated records, 120 chars each
      fields: {                      // writable fields of a type some binding field takes
        name: string; label: string; type: string; description: string | null;
        options?: { value: string; label: string }[];  // select fields
        targets?: string[];                            // relation fields
      }[];
    }[];
  }[];
  currentBindings?: Record<string, { // on an upgrade or "Suggest again"
    objects: string[];
    fields: Record<string, { field: string; values: Record<string, string> }>;
  } | null>;
}
```

The system prompt describes the three bindings, asks for a meaning match over
a name match, prefers create over a doubtful match, and treats names, labels
and record labels as data, never instructions.

**Output.** JSON constrained by a schema built from `TAMLOOT_BINDINGS`, one
key per binding, every key required:

```ts
{
  [binding: 'meeting' | 'task' | 'person']: {
    action: 'existing' | 'create' | 'skip';  // skip only for optional bindings
    object: string | null;                   // API name for existing
    reason: string;                          // one sentence for the admin
    fields?: {                               // bindings with fields
      [field: string]: {
        action: 'existing' | 'create' | 'skip';  // skip only for optional fields
        field: string | null;
        reason: string;
        values?: { open: string | null; done: string | null };  // task.status
      };
    };
  };
}
```

**Checks.** The runner keeps a choice only if the server would take it: an
existing object of the binding's class among the candidates; an existing field
that is writable, not a core field, not an inverse relation and of an allowed
type; a relation that targets the object chosen for its `target` binding; a
status value mapped to one of the field's options. A choice that fails is left
out, so the server's fixed default applies to that binding or field. What's
left is saved with `PUT /runtime/suggestions`, with each reason under
`meeting`, `task.status` and so on.

**Fallback.** No model on the server, a refusal, output that doesn't parse or
any provider error saves nothing, and the run succeeds with
`suggestions_ready_without_model`: the review opens with the fixed default.
The admin approves every binding either way.

## 4. Retainer prerequisites

In dependency order:

1. `sync_source_event` with immutable revisions and retraction of derived
   assertions (§10 of extensions.md).
2. Member connections (§2 here).
3. Field contributions on base objects, with `isUnique`. The manifest already
   accepts them; this needs an end-to-end test.
4. The adapter bundle in `packages/runner` and a catalog entry, then the
   acceptance scenarios: backfill, edit/regeneration, task regeneration,
   deletion, reconnect, disconnect, a member leaving, and two members recording
   one meeting.

The `files` field is not needed, because v1 imports no transcript. The
change feed, webhook ingress (extensions.md §9.4 and §9.3) and standalone
OAuth are not needed for v1.

## 5. Later

- Tamloot webhooks (`session.updated` and others, Standard Webhooks signing)
  plus a Retainer `route` trigger, so new meetings arrive within seconds.
  Polling stays as the safety net.
- Organization-wide Tamloot keys, after Tamloot's access model v2.
- More fields, each an additive Tamloot API change (retainer-api.md §5):
  the transcript as a `files` field (needs `files`), `medium` from the session
  kind, a `tamlootUrl` link, and `calendarEventUid` for linking or merging the
  same meeting recorded by two members. V1 keeps both members' events.
- Tamloot as a standalone reader of Retainer.

## 6. Decisions

Both former open questions are decided (2026-11-13). The implementation spec
keeps these outcomes and refines the task-write steps for concurrency.

1. **A task a person edited is kept.** A kept task is no longer synced.
   Managed task support checks all assertion history and applies removal under
   record locks. An adapter-only history read followed by deletion would race
   a person's edit; the implementation spec §4.7 gives the server steps.
   Tamloot keeping completed tasks on regeneration (retainer-api.md §7) would
   make this case rarer, but is not required.
2. **Create-people defaults to `everyone`.** The manifest ceiling and the
   setting's default are both `everyone`. Tamloot's participants are its
   linked contacts, which already leave out rooms, group calendars and the
   owner's own addresses (#2394), and calendar sync links every invitee.
   Colleagues on a call are still created. The server applies this policy
   when it imports a source event; admins can lower it to `never`. Tamloot
   v1 does not expose outbound-contact evidence, so its bundle does not offer
   `contacted_first` (the platform requires that evidence).
