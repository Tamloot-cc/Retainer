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
before then returns an empty context. Creation takes a transaction-scoped
advisory lock on `(workspace, user)`, so two first writes make one profile.

### 4.2 Privacy (M5)

New column `private_to_user uuid null` on every table that holds rows of a
personal profile or of the internal notes `remember` creates for it:

- `records`
- `facts`, `fact_sources`
- `field_assertions` (the internal notes' title and summary)
- `event_records`, `event_links` (the internal notes and their `about` link)

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
So a write either commits before removal and is deleted with the rest, or
starts after it and fails with `403`. A test runs the two concurrently.

### 4.4 Tools and routes (M4)

`workspace` and `me` are accepted in place of a record ID by:

- `remember(record, text, source?, quote?)` and its REST route;
- `get_context(record, tokenBudget)`;
- `get_timeline(record, filters)`, which lists facts only for a profile;
- fact retraction.

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
- A shared fact cannot cite a private internal note: it is invisible to the
  write (`invalid_source`, as for any record the caller cannot see).

### 4.6 Leaving, deleting and erasing (M8)

When a person stops being a member of a workspace (removed from it, removed
from the organization, or their account deleted), in one transaction:

1. take the `(workspace, user)` advisory lock exclusively;
2. switch to `retainer_app` with `SET LOCAL ROLE`, set `app.workspace_id` and
   `app.user_id` to that workspace and person;
3. hard-delete their personal profile, its facts and sources, and its private
   internal notes with their assertions and links;
4. revoke API keys in that workspace whose `acts_for_user` is that person;
5. write a `deletion_audit_log` row with counts only, no text.

This runs in the `control` function, which already handles removals. The
deleted facts are gone; there is no grace period in v1.

A person can also clear their own memory: `forget` on `me`, from their
session or their own agent, does the same deletion without leaving. No one
else can.

Deleting a workspace deletes everything in it, profiles included, as today.

`forget` on a shared record does not reach anyone's personal memory: it
cannot see those rows. A personal fact that names an erased contact in its
text stays, exactly as plain text in any other fact does today (ARCHITECTURE
2.1 erases by record, handle and source, not by text).

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
- **Check before writing.** Read the profile first, and supersede or skip a
  fact that is already there.
- **Cite a source** when the fact came from a logged conversation.

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
  `app.workspace_id` set returns no private rows from any of the six tables.
- **Concurrency.** Removal racing `remember("me")`; two first writes to `me`
  creating one profile.
- **Removal.** After each of the three ways to leave, the profile, its facts,
  sources, notes and keys are gone, and shared events the facts cited are
  untouched.
- **Key mode.** `me` is `422 no_person`; `workspace` works.

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

## 8. Open questions

1. **Agents cannot correct or move a fact.** Over MCP, `remember` only adds:
   there is no tool to retract a fact, supersede it or move it to another
   record (`DELETE /v1/facts/:id` exists on REST only). When a preference
   changes, the old and new facts both stay current, and a customer fact
   written into `me` by mistake stays there. This matters more for profiles,
   whose facts change over time, than for CRM records.
