# Workspaces without built-in objects

Status: proposed, 2026-11-22. Amends [ARCHITECTURE.md](../../ARCHITECTURE.md)
1.1 (protection), 3 (seeding and upgrades), 3.1 (base objects and templates)
and 6.2 (`get_context`); [extensions.md](extensions.md) §7 (installation),
§9.4 (change triggers), §9.5 (last contact) and §10 (source ingestion);
[extensions-configure.md](extensions-configure.md) (mapping and suggestions);
[hosted-onboarding.md](hosted-onboarding.md) and
[workspace-upgrade.md](workspace-upgrade.md). Source references describe
`main` at `e831514`.

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
- Person, Company, Task and Conversation become the `starter` template:
  ordinary, unprotected objects a workspace can rename, reshape or delete.
- A select option can be marked `closed`. `get_context` and the record page
  show **open items**: linked records whose status-like selects hold no
  closed value, in any object.
- An extension declares **bindings**: what it reads and writes, in its own
  words. An installation binds each to an existing object, or creates the
  extension's suggested one. The admin approves; an agent or the extension's
  `configure` run may propose.
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

Creating a workspace with a template (the operator's `--template`, the
account API's `template`) still applies it in the same transaction.

### 3.2 The starter template

`starter` holds today's base definitions (`templates/base.ts`): `person`,
`company`, `task` and the `conversation` event type with `medium` and
`transcript`, with the same universal IDs. Applied, they are ordinary
objects: unprotected, and a workspace may delete any of them. `task.status`
marks `done` as closed (§4.1).

Templates become self-contained. A template includes every starter object it
extends or links to: `sales` is the starter's objects plus `deal` and the
company fields it adds. Applying a template skips elements already present
by universal ID, as upgrades do (ARCHITECTURE.md 3), so `starter` then
`sales`, or `sales` alone, end the same. A template element whose name a
workspace object already uses fails the whole apply with
`409 template_conflict`, naming the object, and nothing is applied.

Templates can be applied to any workspace; the `custom_schema` refusal
(`templates/apply.ts:70`) goes. `blank` is removed: an empty workspace is
already blank. The `discover_schema` guide presents templates, the starter
included, as designs to adopt or borrow from, and says that nothing in
Retainer requires any of them.

### 3.3 Protection

Server code depends on the hidden types and on every event type's core
`title` and `summary` fields, and nothing else. `PROTECTED_OBJECT_IDS` keeps
only `HIDDEN_TYPE_IDS`; `PROTECTED_FIELD_IDS` and `PROTECTED_OPTIONS` become
empty (`schema-engine/protection.ts`). The rule stays: any new server
dependency on a schema element protects it in the same change. This spec adds
none.

The upgrade run clears protection on elements no longer listed, the same way
it sets protection on listed ones today.

### 3.4 Upgrades

A workspace's definitions are the hidden types plus the templates it applied
(`workspaces/upgrade.ts:61`, `definitionsFor`). A workspace that applied no
template is never given visible types.

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
- The `discover_schema` guide tells agents to mark the end states of every
  status-like select they design (done, won, lost, hired, cancelled), and
  explains that open items depend on it.
- Templates mark their end states, for example `task.status` `done`,
  `deal.stage` `won` and `lost`, and `application.stage` `hired` and
  `rejected`. Implementation checks every template's selects.

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

### 4.3 `get_context`

`openTasks` becomes `openItems`, grouped by object, most recently updated
first within each group:

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
API name. The budget fitter treats each group like today's single list, and
`omitted.openItems` counts what was left out. Ordering by due date is out of
scope: a saved view or a `query_records` sort does it.

### 4.4 Web app

The record page's Tasks tab becomes **Open**: one list per object, the same
records `get_context` returns. `RecordCounts.openTasks` becomes `openItems`
(`reads/records.ts:150`, `web/src/routes/records/record-memory.tsx:147`).

## 5. Extension bindings

### 5.1 The rule

An extension never names a workspace object or field. It declares
**bindings**: what it reads and writes, in its own words. Each installation
stores where every binding goes. Extension code reads and writes through
binding keys; the server translates them to the workspace's objects and
fields.

Most of this exists. Tamloot's code already sends meetings and tasks in its
own terms (`runner/src/tamloot.ts:311`), and the server writes them through
fixed IDs in the manifest. Enrichment's mapping already lets the admin bind
each output to a field of their choosing. Bindings move the decision of where
data goes from the release to the installation, and widen the mapping from
fields of one fixed object to whole objects.

### 5.2 Manifest

`bindings` replaces `mapping`, `schema`, `source.eventTypeIds`, the field IDs
in `source.tasks`, `lastContact.fields`, the object and field IDs of `change`
triggers, and the object and field IDs of `views`:

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
    create: {                      // suggested object, with permanent universal IDs
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
      { key: 'status', types: ['select'], required: true, values: ['open', 'done'] },
      { key: 'person', types: ['relation'], target: 'person', required: false },
    ],
    create: { /* … */ },
  },
  {
    key: 'person',
    class: 'entity',
    access: 'write',
    required: false,
    match: 'email',                // participants and contacts match by email
    fields: [
      { key: 'name', types: ['full_name', 'text'], required: false },
      { key: 'emails', types: ['emails'], required: true },
    ],
    create: { /* … */ },
  },
]
```

- `values` lists the extension's own values for a select. The installation
  maps each to an option of the chosen field.
- `target` makes a relation point at the object bound to another binding.
- `match: 'email'` names the field used to find existing records. It must be
  an `emails` field with unique claims.
- A `lookup` field (Enrichment's company domain) is a field with
  `lookup: true`. It is read, never written.
- `create` is the object the install creates when the admin doesn't pick an
  existing one. Its universal IDs are permanent, so reinstalls and upgrades
  recognize it. Booking's object is just a binding whose default is `create`.

How the extensions we ship declare it:

| Extension    | Bindings                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| Tamloot      | `meeting` (event, write), `task` (entity, write, optional), `person` (entity, write, match email)        |
| Granola      | `meeting` (event, write; fields `url`, `medium`, `transcript`), `person` (entity, write, match email)    |
| Gmail        | `email` (event, write; field `medium` with value `email`), `person` (entity, write, match email)         |
| Enrichment   | `company` (entity, write; `domain` lookup; outputs as fields)                                            |
| Last contact | `contact` (event, read; any number of event types), `person` and `company` (entity, write; `lastContact`) |
| Booking      | `booking` (entity, write; default `create`), `person` (entity, write, match email)                       |

### 5.3 What an installation stores

For each binding, one of:

- **existing**: an object in the workspace, of the binding's class;
- **create**: the binding's `create` object, created at approval; or
- **skip**: only when `required` is false. Anything that uses the binding is
  off.

A `read` event binding may name several event types. Last contact counts
every event type the admin picks.

For each field of a bound object: an existing field of an allowed type, a new
field from the suggestion, or skip (optional fields only). For each declared
value: an option of the chosen select field, or a new option. A relation
field must target the object bound to its `target` binding.

The stored bindings replace `extension_installations.mapping`
(`db/schema.ts:1494`). Created objects and fields are installation
contributions, owned as today (extensions.md §6).

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

When a `create` object's name is already used, the proposal suffixes it with
the extension's name (`booking` becomes `tamlootBooking`, labeled "Bookings
(Tamloot)"), and the admin may rename it before approving.

### 5.5 At run time

Extension code writes through binding keys and its own values:

```ts
await sdk.syncSourceEvent(id, {
  sourceItemId: itemId,
  event: { binding: 'meeting', occurredAt, title, summary, participants, fields: { url } },
});
```

The server translates keys to fields and values to options, and refuses keys
the release doesn't declare. Each feature reads the installation's bindings
instead of fixed IDs:

- **Source events** are written to the object bound to the event binding.
- **Source tasks** are written to the object bound to `task`, with its
  `title`, `status` and `person` fields.
- **Creating people** inserts into the object bound to the `match: 'email'`
  binding (`sources/service.ts:628`, `records/write.ts:682`).
- **Matching people** for Gmail and source tasks looks only in that object.
  `log_event`'s participant resolution is already generic and doesn't change.
- **Last contact** reads the event types bound to `contact` and writes the
  fields bound on `person` and `company`.
- **Change triggers and views** resolve to their bound object and fields.

### 5.6 When the workspace schema changes later

Each binding, field and value has a status of `ok`, `missing` or
`incompatible`, worked out against the current schema whenever it is read.
This is the status Enrichment's mapping already has (`ExtensionMappingBinding`,
`packages/extension/src/index.ts:229`).

- A missing or incompatible **optional** part is skipped.
- A missing or incompatible **required** part fails the runs that need it with
  `409 binding_unavailable`. The installation shows **Needs setup**, and the
  admin rebinds through a reviewed change. The Field mapping tab becomes
  Setup.

### 5.7 Upgrades

A release that adds bindings, fields or values needs a reviewed upgrade, where
`configure` may suggest choices for the new parts (extensions-configure §5).
A release that adds nothing to bind upgrades automatically, as today.

### 5.8 Errors in plain words

The install review never shows "the schema change is invalid" alone. It shows
each issue from the `schema_invalid` details and each binding that can't be
satisfied, in plain words and next to the binding it concerns.

## 6. Data and API

- `workspaces.schema_from_scratch`: dropped.
- `fields.settings.options[]`: gains optional `closed`.
- `extension_installations.mapping`: replaced by `bindings`; `mapping_revision`
  becomes `bindings_revision`.
- Shared types: `ObjectView.baseObject` and `FieldView.baseField` removed;
  `SelectOption.closed` added; `ContextPack.openTasks` becomes `openItems`;
  `RecordCounts.openTasks` becomes `openItems`.
- The extension contract (`packages/extension`): `bindings` replaces the
  manifest fields listed in §5.2. The SDK's source, task and record writes
  take binding keys.
- MCP: `describe_schema` drops `schemaFromScratch`, `baseObject` and
  `baseField`, and shows `closed`. `get_context` returns `openItems`.
  `preview_extension` accepts binding choices. `apply_template` works in
  every workspace.

## 7. Existing workspaces and installations

There are no users, so nothing stays backward compatible.

- **Workspaces** keep their objects and records. The former base objects
  become ordinary, and the upgrade run clears their protection and marks
  `task.status` `done` as closed. A workspace whose `templates` is empty but
  has the base objects records `starter` as applied, so later templates skip
  them.
- **Installations** get one migration: each is bound to the objects and
  fields its current release named by fixed ID, so connected sources keep
  running. Anything that can't be bound that way shows Needs setup.
- **Hosted:** the rebuilt bundles need the usual release steps in
  `retainer-cloud` (the tfvars apply, `RETAINER_EXTENSION_BUNDLES` and the
  cloud allowlist).

## 8. Rule changes in other docs

- ARCHITECTURE.md 1.1: the protection list becomes the hidden types and the
  event core fields.
- ARCHITECTURE.md 3: the seed is the hidden types only, and upgrades follow
  the applied templates.
- ARCHITECTURE.md 3.1: rewritten. No base objects; the starter template;
  self-contained templates; no `blank`.
- ARCHITECTURE.md 6.2: `openItems` replaces `openTasks`, with the example
  pack updated.
- extensions.md §7, §9.4, §9.5 and §10: bindings replace fixed object and
  field IDs.
- extensions-configure.md §2.2 and §5: suggestions cover bindings.
- hosted-onboarding.md: the paragraph about workspaces designed from scratch
  describes every workspace.
- workspace-upgrade.md: definitions without a seed of visible types.
- FRONTEND.md: the record page's Open tab.

## 9. Tests

Integration tests run against real Postgres, one fresh database per file.

- **Empty workspace.** A new workspace has only hidden types. `get_context`
  works and returns no open items. Upgrades add nothing visible.
- **Templates.** `starter` then `sales` equals `sales` alone. A name clash
  fails the whole apply with `template_conflict`. A starter object can be
  deleted.
- **Closed options.** Marking is refused on multi-select fields and follows the
  relabel approval rule.
- **Open items.** Open items cover several objects, follow links in both
  directions, treat empty as open, leave out events and objects without
  closed options, and use the same set for `get_context` and the record page
  count.
- **Tamloot in a workspace designed from scratch.** Tamloot installs with
  `task` bound to an agent-made object with custom statuses (`open` → `idea`,
  `done` → `dropped`) and `person` bound to an agent-made `contact`; meetings
  and tasks sync into them.
- **Gmail** binds to an agent-made `email` event type.
- **Last contact** counts two bound event types.
- **Booking** creates its object, and a name clash gets the suffixed
  proposal.
- **Proposals.** A `configure` suggestion and an agent proposal both prefill
  the review, and nothing is written until the admin approves.
- **Drift.** Deleting a bound required field shows Needs setup and fails the
  runs with `binding_unavailable`. A missing optional part is skipped.
- **Migration.** An installation made under the old manifest is bound by the
  migration and keeps syncing.
- **Concurrency.** Two concurrent approvals of the same installation, and an
  approval racing a schema change that deletes a bound object: one wins, and
  the other gets a clear conflict.
- **Web (Playwright).** Install review with bindings; the Open tab.
- **Docker** (`pnpm test:docker`), since the extension runtime changes.

## 10. Delivery

Two PRs.

1. **Core.** §3 and §4: no seed, the starter template, self-contained
   templates, protection, closed options and open items, the MCP and web
   changes, and the doc rule changes for ARCHITECTURE.md, hosted-onboarding
   and workspace-upgrade. Extensions keep working through the starter's
   universal IDs until PR 2 lands.
2. **Extensions.** §5 to §7: the bindings contract, SDK, install review,
   proposals, drift, all six extensions moved over, the migration, and the
   rebuilt bundles with their hosted release steps.

## 11. Decisions and open questions

Decided (2026-11-22):

- No built-in objects and no roles. Extensions assume no structure.
- Open items come from closed options. Ordering them by due date is left out.
- A model may propose bindings; a person approves them.

Open:

- **Task identity field.** Tamloot adds `tamlootTaskId` to the task object
  so that a unique claim catches the same task arriving from two accounts
  (`sources/tasks.ts:222`). `source_tasks` already keeps the external ID and
  record per account (`source_tasks_identity_uq`). Lean: drop the field and
  enforce uniqueness per installation in `source_tasks`, so extensions add no
  hidden ID fields to the user's objects. To confirm while implementing PR 2.
- **Several objects for a write binding.** A workspace with Internal Tasks and
  External Tasks binds Tamloot's tasks to one of them. Writing to several
  would need a rule for picking one per task. Not in v1.
- **The clash suffix.** Prefix or suffix, and whether the admin's agent
  should name it instead.
