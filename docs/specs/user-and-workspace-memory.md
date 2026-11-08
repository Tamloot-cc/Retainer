# Personal and workspace memory: spec

Status: **draft**, November 8, 2026. Not built.

This spec amends [ARCHITECTURE.md](../../ARCHITECTURE.md) sections 1.3
(memory), 2 (write rules), 6.2 (MCP), 7.2 (per-record access) and 7.3
(accounts). It adds two places to remember things that are not about a CRM
record:

- **workspace memory**: what the business is and how it works, shared by
  everyone in the workspace;
- **personal memory**: what an agent learns about the person it works for,
  private to that person.

## 1. Why

### 1.1 Memory only hangs off CRM records

Every fact, field value and event in Retainer belongs to a record
(`facts.record_id` is not null). An agent can remember everything about Dana
at Acme. It has nowhere to put:

- "We sell a 12-month plan; we never discount more than 15%."
- "Don't call clients before 10am, and never on Fridays."
- "Maayan likes short follow-ups and writes to Israeli clients in Hebrew."
- "Maayan's goal this quarter is three new clinics."

The first two are about the business. The last two are about the person the
agent is working for. Today an agent either loses them at the end of the
conversation, keeps them in its own client (where other agents and the next
session can't see them), or puts them on some unrelated record.

### 1.2 Agents start every session blind

`get_context` needs a record. At the start of a session there is no record
yet, so the agent has no way to load who it works for or what the business
is. It relearns both, conversation after conversation.

### 1.3 A workspace is not always one company

A sales team's workspace stands for its company. A solo consultant's stands
for one person; a clinic's may stand for a practice with several branches; a
fund's for the fund, not its portfolio. Forcing workspace memory onto a
`company` record would fit some and mislead others, so workspace memory gets
its own home.

## 2. What this is not

- **Not chat history.** Full conversations stay with the agent, as they do
  today. Both memories hold short plain-language facts the agent chose to
  record.
- **Not settings.** Nothing in these memories changes how Retainer behaves.
  Agents read them; the server stores them.
- **Not a second memory system.** Both are facts on records, with the same
  sources, superseding, retraction and erasure as every other fact.
- **Not encrypted.** Private means hidden from other people and their agents
  inside Retainer. Whoever runs the database (the operator of a self-hosted
  install, or us on the hosted service) can still read it.

## 3. Decisions

| #   | Decision                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Every workspace has one **workspace profile**: a record of a hidden, protected entity type, seeded with the workspace. Everyone in the workspace, and every agent connected to it, can read and write it.                           |
| M2  | Every member of a workspace can have one **personal profile** there: a record of a second hidden, protected entity type, **private to that member**.                                                                                |
| M3  | Both profiles hold **facts only**: no fields, no relations, no events about them. They are never participants, `about` records or relation targets.                                                                                 |
| M4  | Agents name them with two aliases, `workspace` and `me`, wherever the tools below take a record. They never need the profiles' IDs.                                                                                                 |
| M5  | **Private is enforced by Postgres**, with a restrictive row-level security policy, not by application code. Only the person and agents acting for them can see a personal profile. Workspace admins and organization owners cannot. |
| M6  | An agent acts for a person when its credential names one: an OAuth token (the person who connected the app), a session (the person), or an API key created with "works for me". Everything else has no `me`.                        |
| M7  | Personal memory is **per workspace**, never across workspaces, so nothing learned in one client's workspace can surface in another's.                                                                                               |
| M8  | When a person leaves a workspace, their personal profile there is **deleted**, with its facts and private internal notes. Keys that work for them are revoked.                                                                      |
| M9  | Private facts may cite shared events. Nothing shared can cite a private fact or a private internal note.                                                                                                                            |
| M10 | Key mode has no people, so it has workspace memory only. `me` fails with `422 no_person`.                                                                                                                                           |
| M11 | The server instructions tell agents to load `me` and `workspace` at the start of a session, and the guides tell them what belongs where (5).                                                                                        |
| M12 | `remember` takes an optional `supersedes`: the new fact replaces an old one, which stays in history. The new fact may be on another record, which is how a fact moves. Agents still cannot delete a fact.                           |

## 4. System design

### 4.1 Profile types (M1–M3)

Two new hidden object types join the internal-note type (ARCHITECTURE 1.3),
each with a fixed universal ID in `@retainer/shared`:

| Type               | Class    | Records                              | Visible to                        |
| ------------------ | -------- | ------------------------------------ | --------------------------------- |
| `workspaceProfile` | `entity` | Exactly one per workspace            | The whole workspace               |
| `memberProfile`    | `entity` | At most one per member per workspace | That member and their agents only |

Both are hidden the same way internal notes are: `describe_schema` omits
them, and query, view, record, relation, participant and write routes resolve
them as not found. That one check removes most leak paths before any privacy
rule runs: a personal profile cannot show up as a meeting participant, a
deal's owner, a search hit on records, or a row in a view.

Both are protected (ARCHITECTURE 1.1) and have no fields. Their label is
computed: the workspace's name, or the person's name.

The workspace profile is seeded at workspace creation. Existing workspaces
get it from the workspace upgrade ([workspace-upgrade.md](workspace-upgrade.md)).

A personal profile is created on the first write to `me`, not when someone
joins: most members may never have an agent write about them. Reading `me`
before then returns an empty context. After taking the shared membership
lock (4.3), creation takes a separate transaction-scoped exclusive advisory
lock on `(workspace, user)` in a **different lock namespace**, then checks
again whether the profile exists. Two first writes both succeed and make
one profile. Never upgrade the shared membership lock to exclusive mode.

### 4.2 Privacy (M5)

New column `private_to_user uuid null` on every table that holds rows of a
personal profile or of the internal notes `remember` creates for it:

- `records`
- `facts`, `fact_sources`
- `field_assertions` (the internal notes' title and summary)
- `event_records`, `event_links` (the internal notes and their `about` link)
- `idempotency_keys` (stored responses to writes that read or change private
  facts, including moves from `me` to a shared record)

It is null for everything else. The server sets it, never a client. It is
copied onto each row rather than read through a join, so the policy is one
comparison per row.

`inWorkspace` gains an optional `userId` and sets `app.user_id` for the
transaction beside `app.workspace_id`. Each of those tables gets a second
policy next to `workspace_isolation`:

```sql
create policy private_to_user on facts as restrictive
  using (private_to_user is null
         or private_to_user = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (private_to_user is null
         or private_to_user = nullif(current_setting('app.user_id', true), '')::uuid);
```

Without `app.user_id`, no private row is visible or writable. This is the
first restrictive policy that 7.2 anticipates, limited to one rule (owner
only); general audiences and roles stay out of scope.

`references()` needs no change: a private row is invisible to it already.

**Retries are private too.** Idempotency claims are scoped by workspace,
operation, the resolved person (or an explicit no-person scope), and key.
The unique constraint and replay lookup use that same scope; RLS alone
cannot separate competing claims on the old workspace-wide unique key.
Resolve aliases and check access and membership before claiming or replaying.
The request hash includes `supersedes` and the resolved destination. Stored
results involving private facts get `private_to_user`, even when the new
fact is shared. Another person reusing the same key gets an independent
claim, never another person's response. Erasure removes cached responses
that contain erased facts, notes or sources; clearing personal memory also
removes that person's private cached responses. Expiry is not erasure.

### 4.3 Who is `me` (M6, M10)

| Credential                                 | `app.user_id`                     |
| ------------------------------------------ | --------------------------------- |
| Session cookie (accounts mode)             | `Caller.userId`                   |
| MCP OAuth token                            | `Caller.connectedBy`              |
| API key with `acts_for_user` set           | That user                         |
| API key without it, or any key in key mode | Not set: no `me`                  |
| Consolidator and other background jobs     | Not set: they see no private rows |

`api_keys` gets `acts_for_user uuid null`. In the web app, creating an agent
key offers "This agent works for me", which sets it to the creator. Nobody can
set it to someone else, and the CLI does not set it, so an operator cannot
mint a key into a person's private memory.

`me` with no person behind the credential is `422 no_person`, naming the
credential kinds that have one.

**Membership is checked inside the write.** Access is checked at the start of
every request, but a member can be removed while a write is in flight. Every
read or write of `me` takes the `(workspace, user)` advisory lock in shared
mode and re-checks membership in the same transaction through the existing
`SECURITY DEFINER` access functions. Removal takes the lock exclusively (4.6).
This also applies when `supersedes` names a personal fact by ID rather than
the destination being `me`, and before returning an idempotent replay.
So a write either commits before removal and is deleted with the rest, or
starts after it and fails with `403`. A test runs the two concurrently.

### 4.4 Tools and routes (M4)

`workspace` and `me` are accepted in place of a record ID by:

- `remember(record, text, source?, quote?)` and its REST route;
- `get_context(record, tokenBudget)`;
- `get_timeline(record, filters)`, which lists facts only for a profile;
- fact retraction.

The owning session also accepts `me` on `POST /v1/records/me/forget` for
"Clear all", with the separate authorization rules in 4.6. Workspace memory
cannot be forgotten through that exception.

Any other tool given an alias, or a profile's ID, answers `422
profile_not_supported` and names the tools above. `upsert_record`,
`log_event` and record creation refuse profile types as they refuse hidden
types today.

A profile's context pack holds its current facts, newest first, fitted to the
budget, with who wrote each and its source. It has no fields, tasks or events.

`search` finds workspace-profile facts like any other fact, and personal
facts only for their owner (RLS does that). A hit on a profile fact names
`profile: "workspace"` or `profile: "me"` instead of a record ID the caller
cannot open.

`describe_schema`'s `builtIns` gains `profiles`: `["workspace", "me"]`, or
`["workspace"]` when the credential has no person. `GET /v1/me` gains
`person: true | false` for the same.

### 4.5 Citations (M9)

- A personal fact may cite any shared event. Its `fact_sources` row is
  private; the event is not.
- `remember("me", …)` without a source creates a **private** internal note
  (`private_to_user` set on its rows). `remember("workspace", …)` creates an
  ordinary internal note.
- A shared fact cannot cite a private internal note or private fact. Check
  the source's privacy against the destination explicitly: an owner's
  `app.user_id` makes their own private rows visible, so visibility alone
  does not establish that a source is safe to share. Internal notes remain
  unavailable as caller-supplied sources, as today. A move publishes a copy
  of an internal note under the destination's privacy (4.9).

### 4.6 Leaving, deleting and erasing (M8)

When a person stops being a member of a workspace (removed from it, removed
from the organization, or their account deleted), in one transaction:

1. take the `(workspace, user)` advisory lock exclusively;
2. switch to `retainer_app` with `SET LOCAL ROLE`, set `app.workspace_id` and
   `app.user_id` to that workspace and person;
3. hard-delete their personal profile, its facts and sources, and its private
   internal notes with their assertions and links, and private cached
   idempotency responses;
4. revoke API keys in that workspace whose `acts_for_user` is that person;
5. write a `deletion_audit_log` row with counts only, no text.

This runs in the `control` function, which already handles removals. The
deleted facts are gone; there is no grace period in v1.

A person can also clear their own memory: `forget` on `me` is a session-only
REST operation used by "Clear all". It requires the owning person's current
workspace access, without requiring workspace admin or the `write` scope.
It deletes their profile, private facts, notes and cached responses in one
transaction under the exclusive membership lock, but keeps their membership
and agent keys. This is an explicit exception to the admin requirement for
forgetting shared records. API keys and OAuth agents cannot clear memory,
and MCP exposes no `forget` tool. Another person's profile cannot be named.

Deleting a workspace deletes everything in it, profiles included, as today.

`forget` on a shared record must also erase private derivatives of the
sources it deletes. Before foreign keys can clear source IDs, delete private
`fact_sources` rows citing those sources, including quotes; delete affected
private facts left without a live source, and cached responses containing
erased data. Facts with another live source retain only their surviving
citations. The existing application query under the requester's RLS cannot
perform this cleanup.

This cleanup runs in one new `SECURITY DEFINER` function, the only exception
this spec adds to ARCHITECTURE 7.2's list:

- It takes the workspace and the shared records and events being erased,
  never a user ID or a private row's ID.
- It runs inside the `forget` transaction, under the privacy lock, as a
  dedicated role with only the privileges the cleanup needs, a fixed
  `search_path` and schema-qualified tables.
- It returns nothing private: no text, IDs, owners or counts of private rows
  reach the requester.

Every other read and write stays under RLS.

A personal fact that merely names an erased contact in its text and does
not depend on an erased source stays, exactly as plain text in any other
fact does today (ARCHITECTURE 2.1 erases by record, handle and source, not by
text).

### 4.7 Consolidator

The consolidator runs without `app.user_id`, so it does not see personal
facts and does not supersede duplicates among them in v1. It still
consolidates workspace-profile facts. Agents are told (5) to check `me`
before writing to it, which keeps duplicates rare.

### 4.8 Web app

One new screen, **Settings → Memory**, in plain words:

- **About this workspace**: the workspace profile's facts, who wrote each and
  when, with "Remove" for people with `write`.
- **About you**: the person's own facts in this workspace, with "Remove" and
  "Clear all", and one line explaining that only they and their agents see
  it, and that it is deleted if they leave the workspace.

People don't write facts here; agents do. The page is for reviewing and
removing. Agent keys get the "This agent works for me" checkbox (4.3).

### 4.9 Correcting and moving facts (M12)

Over MCP, `remember` only adds a fact. When a preference changes ("I prefer
long emails now"), the old and new facts both stay current, and every later
session sees both. A customer fact written into `me` by mistake has no way
out. Profiles hit this more than CRM records, because what they hold changes
over time.

`remember(record, text, source?, quote?, supersedes?)` and
`POST /v1/records/:id/facts` gain `supersedes`, the ID of a current fact.
Context packs, timelines and search already return fact IDs. In one
transaction the server writes the new fact and sets the old one's
`superseded_by` to it. It also records a permanent `replaced_at` timestamp
on the old fact, separate from `valid_to` (world time). Current-fact reads,
search and consolidation exclude facts with `replaced_at` set; history
shows them as superseded even if the replacement has been erased. The
existing `ON DELETE SET NULL` foreign key may clear `superseded_by`, but
must never clear `replaced_at` or restore the original to current memory.
The consolidator's existing duplicate superseding does not set this marker:
an explicit replacement has different semantics from deduplication. Rule
2.6 still holds: facts are superseded, never deleted.

- **Correcting:** `remember("me", "Prefers long emails", supersedes: <old>)`.
- **Moving:** the new fact names a different record than the old one:
  `remember("<Acme's ID>", "Legal review takes two weeks", supersedes: <the
  fact in me>)`. This works between any two records the caller can see,
  profiles included.

Rules:

| Case                                                                                   | Answer                                                                                 |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The old fact is retracted, already superseded or not found                             | `409 fact_not_current`, or `404` when the caller can't see it                          |
| The old fact is shared and the new one would be private (`me`)                         | `422 private_replacement`: colleagues would lose the fact and not see what replaced it |
| The old fact is private and the new one is shared                                      | Allowed: the person's own agent chose to share it                                      |
| The old fact was written by a `user` or `integration` actor and the caller is an agent | `403 supersedes_person`, as agents never silently overwrite people (rule 2.3)          |
| Two writes supersede the same fact at once                                             | One wins; the other gets `409 fact_not_current`                                        |

The old fact's row is locked `FOR UPDATE` and its current status includes
`replaced_at is null` and at least one live source. A move locks both records
in sorted ID order, as multi-record writes do (rule 2.5). Source locks still
precede record locks, as in existing writes, so moves must collect and lock
inherited sources before locking records and re-check eligibility afterward.

**Moving preserves evidence.** A different destination means a move: text
must match the old fact after the usual input trimming, and `source` and
`quote` must be omitted (`422 invalid_move` otherwise). Copy all live shared
event citations and their quotes, and preserve `valid_from` and `valid_to`.
Retracting or erasing an inherited shared source affects the replacement
exactly as it would the original. For an internal-note source, create a
destination-owned copy with the same content and occurrence time and the
destination's privacy; do not leave a shared fact citing a private note or
a note whose `about` link still belongs to the old record. A move from `me`
to shared memory explicitly publishes that copy, which survives clearing
the original personal memory. The new fact records the moving actor; the
old fact retains its author and sources in history until erased.

**Correcting supplies new evidence.** On the same record, `source` and
`quote` retain their normal meaning. Without `source`, the correction gets
its own internal note, private if it is in `me` (4.5). To change both content
and location, correct first, then move the resulting fact.

Agents get no tool to delete a fact. Removing one without a replacement hides
data, which stays a person's decision: the web app's "Remove", or
`DELETE /v1/facts/:id`.

## 5. Rules agents follow

The server instructions gain one paragraph, and `get_guide` gains a short
`memory` guide (also an MCP prompt):

- **At the start of a session**, call `get_context("workspace")` and, if
  `builtIns.profiles` includes it, `get_context("me")`.
- **What goes where:**

| What the agent learned                                   | Where it goes                                  |
| -------------------------------------------------------- | ---------------------------------------------- |
| About a customer, contact, deal or other record          | That record: a field value or `remember`       |
| How the business works, rules for everyone               | `remember("workspace", …)`                     |
| About the person it works for: preferences, style, goals | `remember("me", …)`                            |
| A remark for colleagues                                  | Nowhere: that's a comment, written by a person |
| Passwords, tokens, health or other sensitive data        | Nowhere                                        |

- **Never put customer knowledge in `me`.** Colleagues and their agents can't
  see it, and it is deleted when the person leaves.
- **Check before writing.** Read the profile first. Skip a fact that is
  already there; if what you learned changes one, pass its ID as
  `supersedes`.
- **Fix a misplaced fact by moving it:** `remember` it on the right record
  with unchanged text and `supersedes` naming the old one. Omit `source` and
  `quote`; the server preserves its evidence. Correct separately if needed.
- **Cite a source** when adding or correcting a fact learned from a logged
  conversation.

## 6. Testing

- **Leak matrix.** For every read path (search, `get_context`,
  `get_timeline`, `get_record`, `query_records` on every object and on
  `event`, the Activity feed, review, timelines of shared events that a
  private fact cites, exports), a person's personal facts and private notes
  are invisible to: another member's session, another member's agent, a
  workspace admin, an organization owner, a key without `acts_for_user`, and
  the consolidator. These run against real Postgres with RLS on, as the
  runtime role.
- **RLS without the app.** A raw query as `retainer_app` with only
  `app.workspace_id` set returns no private rows from any protected table,
  including cached idempotency results.
- **Concurrency.** Removal racing `remember("me")`; two first writes to `me`
  both succeeding and creating one profile without a lock upgrade; removal
  racing a move from `me` or an idempotent replay.
- **Removal.** After each of the three ways to leave, the profile, its facts,
  sources, notes, private cached responses and keys are gone, and shared
  events the facts cited are untouched. Session-only "Clear all" works for
  viewers too, preserves keys and membership, and rejects API keys, OAuth
  agents and requests targeting someone else's memory.
- **Retry isolation.** Two people using the same idempotency key and
  `remember("me", …)` input get independent results. Private-to-shared moves
  also have private cached responses. Replays cannot return erased content
  or bypass membership checks.
- **Source erasure.** Forget a shared event cited by personal facts owned by
  multiple people. Verify private quotes and orphaned facts are physically
  gone, surviving multi-source facts retain only live citations, cached
  responses are gone, and no private details or counts reach the requester.
  Direct calls to the erasure function cannot cross workspaces or erase a
  personal profile. A shared fact cannot cite even the caller's own private
  note or fact.
- **Key mode.** `me` is `422 no_person`; `workspace` works.
- **Supersedes.** Every row of the table in 4.9, including two concurrent
  writes superseding the same fact, and a move between two records racing a
  merge of either one. Erasing a replacement never makes the old fact
  current again. Moves preserve shared citations, quotes and validity dates;
  source retraction and erasure affect the replacement. Internal-note copies
  have the destination's privacy and attachment; published copies survive
  clearing personal memory. Changed-text or explicit-source moves fail.

## 7. Decided after review (November 8, 2026)

1. **Agents write workspace memory freely.** Any credential with `write` can
   `remember("workspace", …)`, with no review step. A wrong fact is fixed the
   way any fact is.
2. **No cap on facts per profile.** Context packs already fit a token budget.
3. **No pointers to records for now.** Neither a workspace pointer to the
   record that is "us" nor a member pointer to their `person` record. A
   workspace fact covers what agents need ("We are Acme; @acme.com addresses
   are colleagues, not customers"). Revisit if agents still treat colleagues
   or the workspace's own company as customers.
4. **One "my memory" view across workspaces** is deferred.
5. **Agents correct and move facts with `supersedes` on `remember`** (4.9).
   They still cannot delete one.
6. **"Clear all" is the person's, not their agent's** (4.6). It is a
   session-only REST call; no API key or OAuth agent can clear personal
   memory, and MCP has no `forget`. An agent that cannot remove one fact
   should not be able to remove all of them.
7. **A move keeps the text and the evidence** (4.9). Changing text and
   location takes two calls, correct then move, so a moved fact never loses
   the sources that erasure depends on.
8. **One `SECURITY DEFINER` function for erasure** (4.6). Forgetting a shared
   record must remove other people's private facts and quotes that rest on
   it, which no RLS-bound query can see. The function is narrow and returns
   nothing private.
