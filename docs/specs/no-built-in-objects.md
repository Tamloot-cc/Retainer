# Workspaces without built-in objects

Status: accepted, 2026-11-22; revised after five review rounds. Amends
[ARCHITECTURE.md](../../ARCHITECTURE.md) 1.1 (protection), 3 (seeding and
upgrades), 3.1 (base objects and templates) and 6.2 (`get_context`);
[extensions.md](extensions.md) §6 and §7 (contributions and installation),
§9.4 (change triggers), §9.5 (last contact) and §10 (source ingestion);
[extensions-configure.md](extensions-configure.md) (mapping and suggestions);
[booking-extension.md](booking-extension.md) (its object and person link);
[hosted-onboarding.md](hosted-onboarding.md) and
[workspace-upgrade.md](workspace-upgrade.md). Source references describe
`main` at `67cf7ea`.

Retainer is a flexible CRM: an agent discovers the schema a business needs
and builds it through MCP. Nothing in Retainer's core or in an extension may
assume that a particular object exists. Person, Company, Task and
Conversation stop being built-ins and become a starter template. The one
core feature that needed Task, open tasks, becomes **open items**, driven by
a "closed" mark on select options. Extensions stop naming workspace objects:
each declares what it reads and writes in its own words, and each
installation stores where that goes, proposed by an agent and approved by an
admin.

## 1. Why

A workspace designed from scratch (`schema_from_scratch`, every new hosted
workspace) has no built-in objects. Its agent builds its own `person`,
`company`, `task` and `conversation`, with new universal IDs. Code that finds
the built-ins by their fixed IDs then finds nothing:

| What                                        | Depends on                                  | Where                                                |
| ------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Open tasks in `get_context`                 | Task, `task.status`, `done`, `task.dueDate` | `retrieval/context.ts:200`                           |
| Open-tasks count on the record page         | Task, `task.status`, `done`                 | `reads/records.ts:151`                               |
| Creating people from sources                | Person and its unique emails field          | `sources/service.ts:628`                             |
| Gmail people matching and contact additions | Person; Conversation with an `email` medium | `sources/gmail.ts:43`, `:68`; `records/write.ts:682` |
| Last contact                                | Conversation                                | `memory/last-contact.ts:22`                          |
| Medium in the events list                   | `conversation.medium`                       | `web/src/routes/events/event-list.tsx:123`           |
| Every extension we ship                     | Person, Company, Task or Conversation       | `packages/runner/src/*-contract.ts`                  |

So in such a workspace these features are quietly off, and every extension
fails to install with "the schema change is invalid", without saying why
(found installing Tamloot in a test workspace, 2026-11-22).

Considered:

- **Always seed the built-ins.** Fixes the symptom, but forces a structure on
  every workspace. Rejected: the schema is the agent's to design.
- **Roles.** A workspace tags its own objects as playing Person, Task or
  Conversation, and code looks objects up by tag. Rejected: once extensions
  stop depending on the built-ins (§5), only open tasks still needs a tag,
  and closed options (§4) cover it without one.
- **This design.** Nothing is built in. Core features use generic marks on
  fields. Extensions bind to whatever the workspace has.

## 2. Summary

- New workspaces start empty apart from the hidden types (the internal note
  and the memory types). Hosted and self-hosted behave the same.
  `schema_from_scratch` goes away.
- Person, Company, Task and Conversation become the `starter` template. A
  template is a one-time copy, applied only to an empty workspace. Afterwards,
  templates are designs an agent borrows from, and releases never change a
  workspace's visible schema.
- A select option can be marked `closed`. `get_context` and the record page
  show **open items**: linked records, in any object, whose status-like
  selects hold no closed value.
- An extension declares **bindings**: what it reads and writes, in its own
  words. An installation binds each one to an existing object, or creates
  one. The admin approves; an agent or the extension's `configure` run may
  propose. The approved plan holds while the installation is active and
  changes only through a reviewed re-plan, which never moves imported data.
- `BASE_OBJECT_IDS`, `BASE_FIELD_IDS`, `BASE_EVENT_TYPE_IDS.conversation`,
  `BASE_EVENT_FIELD_IDS`, `TASK_DONE_OPTION`, `baseObject` and `baseField`
  leave the shared contract.

## 3. No built-in objects

### 3.1 Creating a workspace

Every new workspace seeds only the hidden types. This is today's hosted
behavior (`accounts/people.ts:230`), now for every workspace, including the
operator's `workspace create`. The web app shows its setup screen until an
applied change creates a visible type (`web/src/main.tsx:87`), as it does for
hosted workspaces today. The `schema_from_scratch` column and
`schemaFromScratch` in `describe_schema` are removed.

### 3.2 Templates

`starter` holds today's base definitions (`templates/base.ts`): `person`,
`company`, `task` and the `conversation` event type with `medium` and
`transcript`, with the same universal IDs. Once applied, they are ordinary
objects: unprotected, and a workspace may rename, reshape or delete any of
them. `task.status` marks `done` as closed (§4.1).

There is one copy of the starter definitions. The other templates extend it
(`sales` is `starter` plus `deal` and the company fields it adds), declared
in code as `extends: 'starter'`, so their definitions can't drift apart.

**A template is a one-time copy, applied only to a workspace with no visible
types.** A template that targets a workspace with any visible type is refused
with `409 workspace_not_empty`. That removes name clashes, deleted base
objects and partial applies: a template always lands whole, on nothing. Once
applied, its objects are the workspace's own. Later releases of the template
don't reach the workspace (§3.4). Afterwards, the `discover_schema` guide
presents templates as designs the agent may borrow from through
`propose_schema_change`. `blank` is removed, because an empty workspace is
already blank.

How a template is applied:

- **Chosen by a person or operator at creation** (the account API's
  `template`, the operator's `--template`): in the same transaction, on the
  engine's trusted path, as the seed is today. This is what creates
  `person.emails` as unique without an approval.
- **Through `apply_template` by an agent**: the template becomes a schema
  change proposal that stores the template's name, and an admin approves it
  like any other. The approval re-checks, under the exclusive schema lock,
  that the workspace still has no visible types; if one appeared, the
  approval fails with `workspace_not_empty`. The template is recorded in
  `workspaces.templates` in the same transaction as its schema.

`workspaces.templates` is only a history of what was applied. Nothing reads it
to change a schema.

### 3.3 Protection

Server code depends on the hidden types and on every event type's core
`title` and `summary` fields, and nothing else. `PROTECTED_OBJECT_IDS` keeps
only `HIDDEN_TYPE_IDS`. `PROTECTED_FIELD_IDS` and `PROTECTED_OPTIONS` become
empty (`schema-engine/protection.ts`). The rule stays: any new server
dependency on a schema element protects it in the same change. This spec adds
none. Existing workspaces lose their protection through a one-time migration
(§7). The upgrade run still never clears protection.

### 3.4 Upgrades

A workspace's code-defined definitions are the hidden types only. The upgrade
run (`workspaces/upgrade.ts`) brings every workspace up to them and never adds
or changes a visible type. Templates no longer feed `definitionsFor`: once a
workspace's schema is its own, only an approved schema change alters it. A
template improvement reaches existing workspaces the way any schema idea
does: an agent proposes it.

### 3.5 What leaves the shared contract

- `BASE_OBJECT_IDS`, `BASE_FIELD_IDS`, `BASE_EVENT_TYPE_IDS.conversation`,
  `BASE_EVENT_FIELD_IDS` and `TASK_DONE_OPTION` move from
  `packages/shared/src/schema.ts` into the starter template's definitions in
  `packages/server/src/templates/`. Only templates use them.
- `ObjectView.baseObject` and `FieldView.baseField` are removed. Agents find
  objects by names and descriptions, as they already do in workspaces
  designed from scratch. The MCP instructions and guides drop the text about
  them (`mcp/instructions.ts:71`, `mcp/guides.ts:138`, `mcp/tools/setup.ts:34`).
- The events list shows an event's type label instead of the conversation
  medium. Medium stays an ordinary field, shown on the event.
- The extension mapping screen's lookup by `baseObject`
  (`web/src/routes/extensions/mapping.tsx:38`) is replaced by bindings (§5).

## 4. Closed options and open items

### 4.1 Closed options

A `select` field's option may carry `closed: true`:

```json
{ "label": "Done", "value": "done", "closed": true }
```

- Any select field on any entity object may mark options closed. Multi-select
  fields cannot.
- Marking or unmarking follows the approval rule for relabeling an option.
- `describe_schema` shows the mark. `propose_schema_change` accepts it on
  `create_field`, `update_field` and option edits.
- The `discover_schema` guide tells agents to mark closed options only on
  objects whose records are work someone acts on, such as tasks, deals and
  applications, and to mark their end states (done, won, lost, hired,
  cancelled). It also says not to mark lifecycle or category selects on
  people or companies (a person's `churned`), because open items would then
  list every linked person.
- Templates mark the end states of their work objects: `task.status` `done`,
  `deal.stage` `won` and `lost`, `application.stage` `hired` and `rejected`,
  and so on. Implementation checks every template.

### 4.2 Open items

An **open item** of record R is a record X where:

- X is linked to R through any active relation field, in either direction
  (the linking rule open tasks uses today, `retrieval/context.ts:213`);
- X's object is an entity, not an event type;
- X's object has at least one select field with a closed option; and
- none of those fields holds a closed value on X. An empty value counts as
  open.

X is not R, is not deleted and is not merged. Records of objects with no
closed options never appear: Retainer can't tell whether they are open.

One read serves every surface:
`GET /v1/records/:id/open-items?object=<api name>&limit=&cursor=` returns one
bounded page of open items across all objects, or of one object with
`object`, ordered by `updated_at` and then ID. Each item names its object.
The response also carries a total per object, from a count query that
fetches no rows. Grouping by object is presentation only.

### 4.3 `get_context`

`openTasks` becomes `openItems`. It is one bounded page from the same read,
sized by the budget fitter, and presented grouped by object:

```json
"openItems": [
  {
    "object": "task",
    "total": 2,
    "items": [
      { "id": "rec_c40…", "title": "Send SSO docs to Noa", "status": { "status": "todo" } }
    ]
  },
  {
    "object": "deal",
    "total": 1,
    "items": [
      { "id": "rec_9a1…", "title": "Acme renewal", "status": { "stage": "negotiation" } }
    ]
  }
]
```

`status` holds the values of the object's fields that have closed options, by
API name. `total` comes from the per-object counts, and `omitted.openItems`
counts what the page left out. Ordering by due date is out of
scope: a saved view or a `query_records` sort does it.

### 4.4 Web app

The record page's Tasks tab becomes **Open**: the open-items read, paged and
grouped by object. `RecordCounts.openTasks` becomes `openItems`
(`reads/records.ts:150`, `web/src/routes/records/record-memory.tsx:147`).

## 5. Extension bindings

### 5.1 The rule

An extension never names a workspace object or field. It declares
**bindings**: what it reads and writes, in its own words. Each installation
stores where every binding goes, and runs read and write through it.

A binding only chooses a destination. It grants no authority. The existing
admission and write rules stay as they are: which function may write, with
which actor and scopes, through which path (mapped writes, source ingestion,
last contact, ordinary record writes). Each of those checks the credential,
function, operation and installation, and only then resolves the binding.

Most of this exists. Tamloot's code already sends meetings and tasks in its
own terms (`runner/src/tamloot.ts:311`), and the server writes them through
fixed IDs in the manifest. Enrichment's mapping already lets the admin bind
each output to a field of their choosing. Bindings move the choice of
destination from the release to the installation, and widen the mapping from
fields of one fixed object to whole objects.

### 5.2 Manifest

`bindings` replaces `mapping`, `schema`, `source.eventTypeIds`, the field IDs
in `source.tasks`, `lastContact.fields`, the object and field IDs of `change`
triggers, and the object and field IDs of `views`. Each of those capabilities
now names the binding key it uses (`source.event: 'meeting'`,
`source.tasks: 'task'`, `source.people: 'person'`,
`trigger: { kind: 'change', binding: 'company', fields: ['domain'] }`).

```ts
bindings: [
  {
    key: 'meeting',                // the extension's name for it
    label: 'Meetings',
    description: 'Each completed Tamloot meeting, with notes and participants.',
    class: 'event',                // 'entity' | 'event'
    access: 'write',               // 'write' | 'read'
    required: true,                // false: the admin may skip it
    fields: [
      { key: 'url', label: 'Tamloot link', types: ['links'], required: false },
    ],
    create: {                      // the object a new binding creates, with permanent universal IDs
      universalId: '…', nameSingular: 'meeting', namePlural: 'meetings', /* labels, fields */
    },
  },
  {
    key: 'task',
    class: 'entity',
    access: 'write',
    required: false,
    fields: [
      { key: 'title', types: ['text'], required: true },
      { key: 'status', types: ['select'], required: true,
        values: [{ value: 'open' }, { value: 'done', closed: true }] },
      { key: 'person', types: ['relation'], target: 'person', required: false },
    ],
    create: { /* … */ },
  },
  {
    key: 'person',
    class: 'entity',
    access: 'write',
    required: false,
    match: 'emails',               // the field used to find and create people
    fields: [
      { key: 'name', types: ['full_name', 'text'], required: false },
      { key: 'emails', types: ['emails'], required: true },
    ],
    create: { /* … */ },
  },
]
```

- `values` lists the extension's own values for a select. The installation
  maps each to an option of the chosen field. A value marked `closed` must
  map to a closed option (§5.3).
- `target` makes a relation point at the object bound to another binding.
- `match` names the field used to find existing records and, where the
  installation may create people, to create them (§5.3).
- A field with `lookup: true` (Enrichment's company domain) is read, never
  written.
- `owned: true`, on a binding or on a field, means the extension always
  creates it: an installation contribution (extensions.md §6), never bound to
  something the workspace already has. It is for structure the extension
  alone defines: Booking's object and Last contact's derived fields. It says
  nothing about who may write values. Ordinary assertion precedence applies,
  so a person can still correct `lastContactAt`. Booking's write exclusivity
  is its own per-field "installation-owned" flag (booking-extension.md), which
  leaves `booking.person` writable by people.

How the extensions we ship declare it:

| Extension    | Bindings                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Tamloot      | `meeting` (event, write), `task` (entity, write, optional), `person` (entity, write, match `emails`)                              |
| Granola      | `meeting` (event, write; fields `url`, `medium`, `transcript`), `person` (entity, write, match `emails`)                           |
| Gmail        | `email` (event, write; field `medium` with value `email`), `person` (entity, write, match `emails`)                                |
| Enrichment   | `company` (entity, write; `domain` lookup; outputs as fields)                                                                     |
| Last contact | `contact` (event, read; any number of event types), `person` and `company` (entity, write, optional; owned field `lastContact`)    |
| Booking      | `booking` (owned object), `person` (entity, read, optional; only the target of `booking.person`, never matched by email)           |

### 5.3 What an installation stores

For each binding, one of:

- **existing**: an object in the workspace of the binding's class. Hidden
  types can't be bound.
- **create**: the binding's `create` object, created at approval as an
  ordinary workspace object (owner `workspace`, not a contribution), which
  the workspace may reshape like any other.
- **skip**: only when `required` is false. Anything that uses the binding is
  off.

An owned binding is always **create**, and its object is a contribution. A
`read` event binding may name several event types: Last contact counts every
event type the admin picks.

For each field of a bound object:

- an existing field of an allowed type. Inverse relations, read-only fields
  and event core fields can't be bound;
- a new ordinary field from the suggestion;
- skip, for optional fields only.

An owned field is always created, as a contribution.

For each declared value: an option of the chosen select field, or a new
option. A value's `closed` flag must equal its option's mark, in both
directions: `done` needs a closed option and `open` needs one that isn't. A
new option is created with the value's mark. An install never changes the
mark of an existing option, because other installations and records rely on
it. Repurposing an option is a separate schema change. A relation field must
target the object bound to its `target` binding.

Four checks keep writes valid. The first two can be fixed inside the review:
the approval includes the schema change, explained in plain words, and
approved with the rest.

- **Match field unique.** When the plan lets the installation create people
  (its `createPeople` choice isn't `never`), the `match` field must have unique
  claims. `createPeople` is part of the plan, not an ordinary setting, so
  changing it is a re-plan and re-runs these checks. The release's ceiling
  only bounds the choice. If the chosen emails field doesn't, the approval includes
  `update_field isUnique: true`. If existing duplicates prevent that, the
  review names the records. A match-only use, like Gmail, doesn't need
  uniqueness and keeps today's rule: only an unambiguous live match counts.
- **Required fields covered.** A binding the extension creates records
  through must bind every required field of its object to a field the
  extension always supplies. For any other required field, the approval
  includes `update_field isNullable: true` ("Tamloot creates contacts without
  a company. Make Company optional?").
- **No shared destinations.** Two writable fields of one operation can't bind
  to the same workspace field, and neither can a writable field and a lookup.
  The runtime check stays as a backstop.
- **Eligible targets only.** Hidden types, inverse relations, read-only fields
  and event core fields can't be bound, as above.

The stored bindings replace `extension_installations.mapping`
(`db/schema.ts:1494`).

### 5.4 Proposing and approving

The install review shows every binding with a proposed choice, which the admin
edits and approves. Approval commits the bindings, the schema operations they
need, the grants and the triggers together, as today. Proposals come from, in
order:

1. the release's `configure` run, which may use the model proxy and saves
   suggestions per binding, field and value, each with a reason
   (extensions-configure §2.2, widened from mapping outputs to bindings);
2. the admin's agent, through `preview_extension` with binding choices,
   listed as an agent proposal; then
3. a fixed default: an existing object of the right class whose name or label
   matches the suggestion and whose fields fit, otherwise `create`, or `skip`
   for optional bindings with no match.

The model never decides. A person approves every binding, as with schema
changes.

When a `create` object's name is already used, the proposal prefixes it with
the extension's name (`booking` becomes `tamlootBooking`, labeled "Bookings
(Tamloot)"), and the admin may rename it before approving.

### 5.5 The binding plan

An installation's bindings are one **plan**: every destination and every skip,
approved together by a person. There is one rule for its whole life.

**1. The plan holds while the installation is active.** Until the
installation is `uninstalled`, the schema engine refuses any change after
which one of the installation's §5.3 checks would fail. It runs the review's
own validator, under the exclusive schema lock, and names the installation and
the binding: "Tamloot writes meetings here. Change Tamloot's setup first."
That covers deleting or reshaping a bound element, removing a bound option,
un-marking a bound closed option, dropping uniqueness from a match field,
adding a required field to an object the extension creates records in, and
any operation added later. Renames and relabels stay free. So a plan never
drifts.

**2. The plan changes only by a re-plan.** A re-plan is a new plan reviewed
and approved like an install. Changing setup from the extension's page, a
reviewed upgrade that adds binding keys, and a reinstall are all re-plans.
Each one:

- fences every run and standalone writer of the old plan, and advances the
  generation and `bindings_revision`;
- applies the schema operations the new plan needs, then runs setup, which
  re-verifies every source connection and webhook before any import;
- keeps change work. Triggers the new plan doesn't change resume from the old
  dispatch position, with every unfinished job carried over, including
  interrupted attempts. New or changed triggers start at the approval
  boundary;
- shows its effects in the review, such as tasks that will be detached and
  history that stays where it is.

**3. History stays where it was written.** A re-plan never moves imported
data.

- A revision the source already accepted replays against the projection it
  was accepted under (§5.6), wherever its event now lives.
- A new item, or a newer revision with changed content, uses the current
  plan. A changed event in another destination is superseded through the
  normal revision path (`sources/service.ts:824`).
- A re-plan that changes any task destination (the object, or any field or
  value written to it) detaches every synced `source_tasks` row as part of
  the re-plan, before imports resume. It uses today's detachment semantics
  (`sources/task-detach.ts`), and keeps each task's current values, source
  identity and erasure lineage even though nobody edited it. A later meeting
  revision can't erase them. Detached tasks are never moved or recreated;
  task IDs the source hasn't sent yet use the new plan.
- When an owned derived field gets a new destination, the extension's claims
  on the old field are retracted through the assertion engine. People's
  claims stay. Setup recomputes the new field.
- When a re-plan or reinstall gives a manifest key a new element, the old
  element is released to the workspace in the same transaction. Its
  contribution row is deleted and its owner becomes `workspace`, so the
  workspace may delete it, and each manifest key has exactly one
  contribution.
- Relations and views keep their original targets. A plan that needs them
  elsewhere creates new ones.

**4. Uninstall releases the plan.** After uninstall, the workspace may change
anything. A reinstall is a re-plan: its review proposes every earlier
destination that still passes §5.3 and binds the rest afresh. When an owned
object or field was deleted, the reinstall creates a replacement with fresh
schema IDs; the manifest key, not the universal ID, identifies the
contribution. Source identities, receipts and suppression are kept, so the
same provider accounts resume under the new plan, under rule 3.

### 5.6 At run time

**Reads.** `GET /v1/extensions/:id/bindings` returns the installation's plan:
each binding key to its object's stable ID and current API name (or several,
for a multi-type read binding), each field key to its field's stable ID and
API name, and the `bindings_revision`. It is admitted only for the
installation's own credential: a run token, or a standalone app's grant.
Hosted invocations also receive it inline, as of their generation. Extension
code reads through the ordinary APIs by those names. Change jobs report
changed fields by binding field key.

**Standalone writes** carry the `bindings_revision` they were made under,
plus the stable IDs of the object and of every field they name, match fields
included. The admitted write transaction checks all of them. A write made
against an old plan, or naming a field renamed since, fails instead of
landing somewhere else.

**Writes.** Managed paths take binding keys and the extension's own values,
and the server translates:

```ts
await sdk.syncSourceEvent(id, {
  sourceItemId: itemId,
  event: { binding: 'meeting', occurredAt, title, summary, participants, fields: { url } },
});
```

- **Source events** go to the object bound to `source.event`. When a
  revision is accepted, its receipt stores the projection it was accepted
  under: every key enabled in the plan, present or absent, with the
  normalization rules (checksums for files, suppression before hashing). A
  replay of the same revision compares normalized values and presence within
  that projection only. Changed content still conflicts. A key first enabled
  after acceptance is ignored until the next revision. A newer revision with
  identical content is unchanged and stays where it is.
- **Source tasks** go to the object bound to `source.tasks`. Task identity
  stays per source account (`source_tasks_identity_uq`), with no field on the
  user's object. Reconciliation takes one lock per installation before the
  source item and record locks. Then, if another account of the installation
  already holds a provider task ID, the write fails with
  `source_task_conflict`. It never moves that row or its evidence.
- **People** are matched, and created where allowed, through the `match`
  field of the `source.people` binding, and only that field. New people go
  through the standard create validation before their assertions are written.
  Managed ingestion resolves each participant itself and passes it on either
  matched (a record ID) or explicitly unresolved, always with its handle.
  There is no fallback to workspace-wide matching, so an email held only by
  an unbound `vendor` never links. Suppression checks are unchanged, and so is
  the public `log_event` resolver.
- **Gmail** uses the same approved email field for its prefetch, its contact
  additions (`records/write.ts:682`) and the final import. Message dedup and
  suppression stay workspace-wide. When a duplicate message already lives in
  an event type other than the current destination, the delivery is
  acknowledged without changing the old event. Thread groups and their
  representative events stay within one destination.
- **Last contact** reads the event types bound to `contact` and writes its
  owned `lastContact` fields.
- **Change triggers** resolve their declared fields through the plan. A
  filtered trigger whose fields all resolve to nothing is off, never a
  wildcard.

### 5.7 Statuses

Rule 1 keeps every plan valid while it is active, so drift isn't a state an
installation can be in. The per-binding status Enrichment's mapping has today
(`ExtensionMappingBinding`, `packages/extension/src/index.ts:229`) stays as a
runtime backstop. A write that finds its destination unusable fails with
`409 binding_unavailable` and is reported as a bug, not handled as a workflow.
There is no Needs setup state.

### 5.8 Upgrades

Automatic upgrades keep comparing the full contract
(`extensions/auto-upgrade.ts:31`), and they keep the plan as it is. Binding
declarations, and the binding each capability uses, are part of the contract.
A release that changes them is a reviewed upgrade, and therefore a re-plan
(§5.5), as are changes to scopes, actor, secrets and model use. Existing keys
can't change meaning; a release that needs that uses a new key.

### 5.9 Errors in plain words

The install review never shows "the schema change is invalid" alone. It shows
each issue from the `schema_invalid` details and each binding that can't be
satisfied, in plain words, next to the binding it concerns.

## 6. Data and API

- `workspaces.schema_from_scratch`: dropped.
- `fields.settings.options[]`: gains optional `closed`.
- `extension_installations.mapping`: replaced by `bindings`;
  `mapping_revision` becomes `bindings_revision`, advanced by every re-plan.
- Source receipts store the projection each revision was accepted under
  (§5.6).
- `GET /v1/records/:id/open-items`: new (§4.2).
- `GET /v1/extensions/:id/bindings`: new (§5.6).
- Shared types: `ObjectView.baseObject` and `FieldView.baseField` removed;
  `SelectOption.closed` added; `ContextPack.openTasks` becomes `openItems`;
  `RecordCounts.openTasks` becomes `openItems`.
- The extension contract (`packages/extension`): `bindings` and `owned`
  replace the manifest fields listed in §5.2. Invocations carry the resolved
  bindings. The SDK's managed writes take binding keys.
- MCP: `describe_schema` drops `schemaFromScratch`, `baseObject` and
  `baseField`, and shows `closed`. `get_context` returns `openItems`.
  `preview_extension` accepts binding choices. `apply_template` proposes, and
  works only in an empty workspace.

## 7. Existing workspaces and installations

There are no users, so nothing stays backward compatible. Two one-time
migrations:

- **PR 1, closed marks.** Existing workspaces get the `closed` marks the
  templates declare (`task.status` `done`, `deal.stage` `won` and `lost`, and
  so on) on options they already have, matched by universal ID. Done tasks
  never show as open, not even between the PRs.
- **PR 2, workspaces.** Workspaces keep their objects and records. The
  migration clears protection on the former base elements.
- **PR 2, installations.** Installations are bound to the objects and fields their current release
  named by fixed ID, so connected sources keep running. Fields that become
  `owned` stay contributions. Existing `tamlootTaskId` fields stop being
  contributions and become ordinary fields the workspace may delete. An
  installation that can't be bound this way is uninstalled, and the admin
  reinstalls it.
- **Hosted:** the rebuilt bundles need the usual release steps in
  `retainer-cloud` (the tfvars apply, `RETAINER_EXTENSION_BUNDLES` and the
  cloud allowlist).

## 8. Rule changes in other docs

- ARCHITECTURE.md 1.1: the protection list becomes the hidden types and the
  event core fields.
- ARCHITECTURE.md 3: the seed and the upgrade definitions are the hidden
  types only.
- ARCHITECTURE.md 3.1: rewritten. No base objects; the starter template;
  templates as one-time copies on empty workspaces; no `blank`.
- ARCHITECTURE.md 6.2: `openItems` replaces `openTasks`, with the example
  pack updated.
- extensions.md §6, §7, §9.4, §9.5 and §10: bindings, `owned`, the plan
  and re-plans (§5.5), and the run-time rules in §5.6.
- extensions-configure.md §2.2 and §5: suggestions cover bindings; the Field
  mapping tab becomes a re-plan.
- booking-extension.md: Booking's object is an owned binding, `person` is a
  read binding, and Booking reads its names from the bindings endpoint.
- hosted-onboarding.md: the paragraph about workspaces designed from scratch
  describes every workspace.
- workspace-upgrade.md: definitions are the hidden types only; templates
  don't upgrade.
- FRONTEND.md: the record page's Open tab.

## 9. Tests

Integration tests run against real Postgres, one fresh database per file.

- **Empty workspace.** A new workspace has only hidden types. `get_context`
  works and returns no open items. Upgrades add nothing visible, even to a
  workspace that applied a template.
- **Templates.** A template on a workspace with a visible type is refused. A
  creation-time template applies on the trusted path, unique emails included.
  An agent's `apply_template` creates a proposal, and the template is recorded
  only when the proposal is approved. An unrelated object created between the
  proposal and its approval makes the approval fail with
  `workspace_not_empty`. `sales` contains the starter.
- **Closed options.** Marking is refused on multi-select fields and follows the
  relabel approval rule.
- **Open items.** Open items cover several objects, follow links in both
  directions, treat empty as open, and leave out events and objects without
  closed options. Pages stay bounded however many objects there are.
  `get_context`, the tab and the counts agree.
- **PR 1 migration.** In an existing workspace, an open task shows in Open and
  disappears once done.
- **Tamloot in a workspace designed from scratch.** Tamloot installs with
  `task` bound to an agent-made object with custom statuses (`open` → `idea`,
  `done` → a new closed `completed` option), and `person` bound to an
  agent-made `contact` whose emails field the approval makes unique and whose
  required `company` the approval makes optional. Meetings and tasks sync,
  and completed tasks leave open items. Mapping `open` to a closed option, or
  `done` to an open one, is refused.
- **Matching.** An email held only by an unbound `vendor` never links, as
  matched or through a global fallback. Gmail, which only matches, works with
  a non-unique emails field and skips ambiguous matches.
- **No shared destinations.** Two outputs on one field, or an output on the
  lookup field, are refused.
- **Gmail** binds to an agent-made `email` event type.
- **Last contact** counts two bound event types, gains a third through a
  re-plan, and a person can still correct `lastContactAt`.
- **Booking** creates its owned object, reads its names from the bindings
  endpoint with its standalone grant, and leaves `person` writable by people.
  A name clash gets the prefixed proposal.
- **Proposals.** A `configure` suggestion and an agent proposal both prefill
  the review, and nothing is written until the admin approves.
- **The plan holds.** While installed, each change the §5.3 checks would
  fail is refused and names the installation: deleting a bound field,
  removing or un-marking a bound option, dropping uniqueness from a match
  field, adding a required field to a bound task object. Renames are allowed.
  After uninstall, all of them are allowed.
- **Re-plan.** Binding a skipped Tamloot `task`, adding a `call` type to Last
  contact, and remapping an Enrichment output each fence old runs, re-run
  setup and keep sync and webhooks working. A change queued before the
  re-plan for an unchanged trigger still runs, and a change committed during
  it is replayed. A standalone write carrying an old `bindings_revision`
  fails.
- **History stays.** After re-planning Tamloot's `meeting` from `meeting` to
  `call`, old events stay in `meeting`, a changed revision of an old item
  supersedes it into `call`, and an accepted revision replays as unchanged.
  Tasks whose record is in the old task object are detached and not
  recreated. A moved `lastContact` destination retracts the extension's old
  claims and keeps people's.
- **Reinstall.** After uninstall and deleting Booking's object, a reinstall
  creates a replacement with fresh IDs. After deleting Tamloot's `meeting`,
  a reinstall binds afresh, and accounts A and B resume under the new plan.
- **Replay.** A same-revision replay with changed content conflicts. One that
  only gains a key enabled later doesn't. Re-uploaded identical transcript
  bytes don't.
- **Gmail across destinations.** A message already imported into the old
  event type is acknowledged and not changed when it reaches a new mailbox
  after a re-plan.
- **`createPeople` in the plan.** An installation with `never` doesn't block
  the workspace from adding a required field or dropping uniqueness on its
  contact object. Changing it to `everyone` is a re-plan that runs both
  checks.
- **Released elements.** After Last contact moves to Client, the old
  `lastContact` field on Contact can be deleted. After a reinstall replaces a
  deleted owned object, its manifest key has one contribution.
- **Task fields.** Re-planning Tamloot's task status to another field
  detaches synced tasks before the next import, and the first newer meeting
  revision leaves their values intact.
- **Change work.** A change committed but not yet dispatched before an
  Enrichment re-plan is still processed.
- **Standalone field rename.** A Booking write naming `status` fails after
  the bound field is renamed and another field takes its old name.
- **Triggers.** A filtered trigger with no resolved fields doesn't fire.
- **Task identity.** The same provider task ID from two accounts of one
  installation, including two first sightings run concurrently, gives one
  record and one `source_task_conflict`, and the first row is untouched.
- **Migration.** An installation made under the old manifest is bound by the
  migration and keeps syncing.
- **Concurrency.** Two concurrent approvals of the same installation, and an
  approval racing a schema change that deletes a bound object: one wins, and
  the other gets a clear conflict.
- **Web (Playwright).** Install review with bindings; the Open tab.
- **Docker** (`pnpm test:docker`), since the extension runtime changes.

## 10. Delivery

Two PRs.

1. **Closed options and open items** (§4), on today's schema: the `closed`
   mark, the end states marked in `templates/base.ts` and every template, the
   closed-marks migration for existing workspaces (§7), the open-items read,
   `get_context`, the Open tab and the guide text. It builds on its own, and
   done tasks are never shown as open.
2. **No built-in objects and bindings** (§3, §5 to §7): no seed, one-time
   templates, protection, the shared removals, the bindings contract and
   endpoint, SDK, install review, proposals, the plan and re-plans,
   drift, all six extensions moved over, the PR 2 migrations, and the rebuilt
   bundles with their hosted release steps. The removals land with their last
   consumers, so every commit builds.

## 11. Decisions

Decided (2026-11-22):

- No built-in objects and no roles. Extensions assume no structure.
- Open items come from closed options. Ordering them by due date is left out.
- A model may propose bindings; a person approves them.
- **No task identity field.** Task identity stays per source account in
  `source_tasks`. The same provider task ID from another account of the
  installation fails closed, serialized per installation (§5.6).
- **One object per write binding.** A workspace with Internal Tasks and
  External Tasks binds Tamloot's tasks to one of them. A `read` event binding
  may name several event types (§5.3).
- **Name clashes get the extension's name** as a prefix, which the admin may
  rename (§5.4).
- **One binding plan** (§5.5). It holds while the installation is active,
  guarded by the review's own validator, and changes only through a reviewed
  re-plan, which never moves imported data. There is no pinned or editable
  split, and no drift state.
- **Templates are one-time copies on empty workspaces**, and releases never
  change a workspace's visible schema (§3.2, §3.4).
- **`owned` means only "always created, a contribution".** Who may write
  values is a separate, per-field matter (§5.2).
- **Installs never change an existing option's closed mark** (§5.3).
