# Modules: spec

Status: **proposed**, 2026-11-26. Turns level 3 of
[extension-levels.md](../research/extension-levels.md) ("core modules") into
a design. One module is planned: Dashboards. Revised the same day after a
review against the code and against modules that may come later (§4), so
the design fits more than its first module without building for the others
yet. Section 2 lists what is decided and what is only proposed.

Already changed with this spec:

- [dashboards.md](dashboards.md): Dashboards is built as the first module
  (§11).
- `ARCHITECTURE.md` §8 and `CLAUDE.md` used to call each folder in
  `packages/server/src` a "module". They now say "folder", so that "module"
  has one meaning (§2).

Changes that land with the code, in the Dashboards PR:

- `ARCHITECTURE.md` §8: a new `modules` layer (§6.3). The layer table must
  match `scripts/check-layers.mjs`, so the two change together. The
  checker's own messages and names move from "module" to "folder" there
  too.
- `CLAUDE.md`: `pnpm db:generate` also follows an edit to a module's
  `schema.ts`.
- [extension-levels.md](../research/extension-levels.md) §3 ("Today": the
  first module) and its sketch of `defineModule`, which this spec replaces.

## 1. The idea on one page

Retainer tries new features as experiments. An experiment should live in one
place, be switched on per workspace, and come out cleanly if it fails. Built
the way features are built today, a feature is spread over a dozen shared
files: comments, for example, appear in the schema, the API's route list,
the MCP tools, the guides, merge, `forget`, the record read and the web app.

A **module** is a small set of folders, all named by its id, that hold the
whole feature:

```
packages/server/src/modules/dashboards/    tables, service, routes, tools, guide (AGPL)
packages/web/src/modules/dashboards/       screens, sidebar item, chat renderer (MIT)
packages/shared/src/modules/dashboards/    contracts both sides use (MIT), when needed
```

Each folder exports one definition: which **extension points** it plugs into
(routes, tools, a sidebar item). The core never imports a module. It is
handed a registry, the list in `modules/index.ts`, and calls every module
that is on for the workspace at each extension point.

- **Adding a module**: its folders plus one line in each registry.
- **Switching it off** for a workspace: one setting. Everything it shows
  disappears and its data stays (§7).
- **Removing it**: delete every path that contains `modules/<id>` and the
  registry lines, then `pnpm db:generate` writes the migration that drops
  its tables. §12 lists the few things that live outside those paths.

The module system starts small. It has only the extension points the first
module needs. Each later module adds the ones it needs, in its own PR, as a
deliberate core change (§10). §9 names the likely next ones and their shape
without building them.

## 2. Decided and proposed

Decided with the product owner on 2026-11-26:

- **Experimental features are modules**, at level 3 of
  [extension-levels.md](../research/extension-levels.md): in-process, in
  Retainer's database and transaction, but kept in their own folders.
- **A registry, not direct imports.** The core knows "modules", never a
  module by name. Chosen over "a feature folder with direct hookups" so
  that modules built in parallel don't all edit the same shared files, and
  "off" is applied in one place.
- **Built only as far as needed.** The first module brings the registry and
  the extension points it uses. The rest arrive with the module that needs
  them.
- **Dashboards is the first module**, and the only one planned today.
  Recording and Booking, which the first draft planned as modules, are now
  examples in §4.

Decided later the same day, after the review in §4:

- **Recording and Booking are not planned as modules.** Booking stays the
  standalone app that [booking-extension.md](booking-extension.md) plans,
  and modules get no public pages (§14).
- **An instance offers no module unless `RETAINER_MODULES` names it** (§7).
  A removed experiment takes its data with it, so whoever runs the instance
  chooses it.
- **A workspace `admin` switches a module on**, in Settings → Experiments.
- **A module's tools are listed to every MCP client** when it is on, not
  only to Retainer's agent, as core tools are (§8.3).
- **A module's routes sit at `/v1/<id>` and are experimental**: outside the
  API's compatibility promise until the module graduates (§6.4). A marked
  prefix such as `/v1/x/<id>` was not taken: it would move every route on
  graduating.
- **A module that succeeds may stay a module.** It graduates by setting
  `alwaysOn: true` (§7).
- **"Module" means this spec's module.** A folder in `packages/server/src`
  is called a folder.

Proposed in this document, open to change: the test for what is a module
(§3), the shape (§5–§6), the extension points (§8–§9) and the rules
(§6.3). No question is open.

## 3. Is it a module?

A feature is a module when all four hold:

1. **It adds; it doesn't change.** A module adds tables, routes, tools and
   screens. An experiment that changes what the core already does (search
   ranking, conflict rules, permissions, an existing screen) can't be cut
   out by deleting a folder. It is a core change behind a setting, and this
   spec doesn't cover it.
2. **It needs to be in the server.** If schema, views, templates and
   Routines can do it, it is configuration (level 1). If it talks to an
   outside service or calls a model, that part is a hosted extension
   (level 2).
3. **Everyone it serves is signed in.** Pages for guests are the mark of a
   standalone app (level 4).
4. **The core would not miss it.** Nothing in the core reads its tables,
   and no core table points at them.

One rule keeps modules removable and small:

> **Knowledge goes in records. A module's tables hold the feature's own
> state.**

What a module learns about a person, a company or a meeting is written as
records, events and facts through the core write path. Search,
`get_context`, merge, `forget`, the change feed and Routines then work with
no module code, and the knowledge stays if the module is removed. A
module's own tables hold display settings, job state and pointers. A
recording module, for example, stores audio with the core's files and the
transcript as the event's full text; its own table only says which upload
belongs to which event.

## 4. Modules that may come

Only Dashboards is planned. To keep the design from fitting only
Dashboards, it was read against features Retainer might try later. None of
these is planned.

| Module that may come | What it would be                                          | Needs beyond the first extension points                   |
| -------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| Goals and targets    | A target per person and month, shown against won deals    | Nothing                                                   |
| CSV import           | Upload a file, map its columns, import in the background  | A background job                                          |
| Reminders on records | "Remind me about this deal on Friday"                     | A record page slot, a job, merge and member-left hooks    |
| Notifications inbox  | What changed on the records a person follows              | A job that reads the change feed, a count on the sidebar  |
| Recording            | Record a call; audio on the event, transcript as its text | A record page slot, a job, and an extension to transcribe |

Features that fail the test in §3, and where they go instead:

| Feature                                                   | Why it isn't a module             | Where it goes              |
| --------------------------------------------------------- | --------------------------------- | -------------------------- |
| Booking, intake forms, a client portal                    | Serve people who aren't signed in | Standalone app (level 4)   |
| Record-level permissions, search ranking, duplicate rules | Change what the core does         | The core, behind a setting |
| Tags, lead scoring, SLA follow-up                         | Schema, views and Routines do it  | Configuration (level 1)    |
| WhatsApp sending, calendar sync, transcription            | Outside services and model calls  | Hosted extension (level 2) |

What the comparison changed in this spec:

1. **The first extension points are not shaped by Dashboards.** Goals and
   targets would need nothing more. Two points have one user so far, the
   chat context line and the chat block renderer. They stay because each is
   a few lines, and any module the agent draws for in the chat needs both.
2. **The next needs are a slot on the record page and a background job.**
   §9 gives their shape; neither is built yet.
3. **Merge and `forget` hooks matter less than the first draft assumed.**
   With the rule in §3, Recording needs neither: `forget` already erases
   events and their files. Reminders would need merge.
4. **Per-person data needs a hook when a member leaves.** The first draft
   had none (§9).
5. **Every module needs three small things the first draft missed**:
   saying what it requires from the instance, a check for clashing names,
   and database grants for its tables. Dashboards needs them too, so they
   are built first (§5.1, §6.2, §8.1).
6. **Public pages are out.** The first draft had an extension point for
   them, for Booking. They are what level 4 is for (§14).

## 5. A module

### 5.1 Server

```ts
// packages/server/src/modules/dashboards/module.ts
import { defineModule } from '../api.js';

export default defineModule({
  id: 'dashboards',
  name: 'Dashboards',
  description: 'Live dashboards the agent writes and people pin.',
  requires: ['agent'],
  routes: (v1, deps) => dashboardRoutes(v1, deps),
  tools: [checkDashboardTool],            // MCP; `agent: 'read'` also pins it on chats
  guide: { name: 'dashboards', description: '…', text: dashboardGuide },
  chatContext: ({ client }) =>
    client === 'web' ? 'This chat is in Retainer\'s web app, which can show dashboards; …' : null,
});
```

`defineModule` is a typed identity function: it checks the shape and returns
it. `id`, `name` and `description` are required. Every other field is
optional, and each is one extension point (§8), except `requires`.

`requires` lists what the module needs from the instance: `agent`,
`fileStorage` or `routines`, which the server already works out for itself
(`agentAvailable`, `routinesAvailable`, whether file storage is set up).
On an instance that lacks one, the module is off, and Settings →
Experiments says why.

A module's tables live in its own `schema.ts` (§8.1). Every module has a
server definition, even one that only adds screens: the server is what
knows which modules exist and which are on.

### 5.2 Web

```ts
// packages/web/src/modules/dashboards/module.tsx
export default defineWebModule({
  id: 'dashboards',
  routes: [{ path: '/dashboards', load: () => import('./list.js') },
           { path: '/dashboards/$id', load: () => import('./page.js') }],
  sidebar: { label: 'Dashboards', icon: LayoutDashboard, to: '/dashboards' },
  chatBlocks: { 'openui-lang': () => import('./chat-block.js') },
});
```

Every screen loads lazily, so a module that is off costs the bundle almost
nothing. The web app learns which modules are on from the session, which
gains `modules: ['dashboards']` beside `agentAvailable`. A module with no
screens has no web folder.

### 5.3 Shared contracts

When the server and the web app share types or a component list, they live
in `packages/shared/src/modules/<id>/` (MIT), exported from
`@retainer/shared` under the module's name. A module with nothing to share
has no shared folder.

## 6. Where modules sit

### 6.1 Server folders

```
packages/server/src/modules/
  api.ts              defineModule and the extension point types
  index.ts            the list of modules: the only file that imports one
  registry.ts         createRegistry: which modules are on, and calling them
  dashboards/
    module.ts         its definition
    schema.ts         its Drizzle tables
    service.ts, routes.ts, tools.ts, guide.ts, *.test.ts
```

Tests follow the repo's existing split, under paths that still name the
module: unit tests beside the code, integration tests in
`packages/server/test/modules/<id>/`, Playwright tests in
`packages/server/e2e/modules/<id>/`, scripts in
`packages/server/scripts/modules/<id>/`.

### 6.2 How the core calls a module

The registry is a value, `createRegistry(modules)`. The API, the MCP server
and the worker take it as an option that defaults to the list in
`modules/index.ts`. Tests pass a fixture module, or no modules at all.

At each extension point, the interface that owns it asks the registry for
the modules that are on and calls them. `api/app.ts` mounts
`registry.routes()` once, and each module's routes answer `404` in a
workspace where it is off. `mcp/server.ts`, which already builds one server
per caller, registers `registry.tools(caller)` after the core tools.

Code in the layers below `modules` can't import the registry (§6.3), and
some of it has to call modules: the agent's session code pins tools and
writes the chat context, and later `forget` and merge would run hooks.
That code receives plain functions through the options it already takes,
as it receives `RetainerToolHost` and `WriteContext.changes` today. No core
file imports the registry or names a module.

`createRegistry` refuses to start when two modules clash, or a module
clashes with the core, on an id, a tool name, a guide name, a route path,
a web path, a chat block language or a table prefix.

### 6.3 Layers and rules

`modules` is a new layer between `admin` and `interfaces` in
`scripts/check-layers.mjs`. A module may use the core, the features and the
admin layer (the schema engine, workspaces), which is what lets it write
records and events the normal way. The interfaces (API, MCP, worker) reach
modules only through the registry.

The checker enforces:

1. Only `modules/index.ts` imports a module folder.
2. A module imports the layers below, `modules/api.ts`, and its own folder:
   never another module, never an interface.
3. Module tables may reference core tables; core tables never reference
   module tables. `db/schema.ts` never imports a module's `schema.ts`.
4. The same rules hold in `packages/web/src/modules/` and
   `packages/shared/src/modules/`.

Rule 2 keeps modules independent: two modules that need each other are one
module, or one of them needs an extension point.

### 6.4 Repo rules still apply

A module is core code, so every rule in `CLAUDE.md` holds for it:

- Writes carry the caller's `Actor`. A background job acts as the `system`
  actor with `via: '<module id>'`, like the core's own jobs.
- Records and events are written through the core write path (assertions,
  never `records.data`), and schema changes go through the schema engine.
- **No model calls.** A module that needs a model hands that step to an
  extension or a Routine, which may call the model proxy.
- Server module folders are AGPL; web and shared module folders are MIT.

Three rules are for modules only. They are what makes removal clean:

- A module adds no column to a core table and writes no workspace setting
  but its own switch. Its settings live in its own tables.
- A module doesn't change the core's tool descriptions, the MCP
  instructions or the agent's base prompt. It speaks to agents through its
  own tools, its guide and its chat context line.
- A module's routes and tools are **experimental**: outside the API's
  compatibility promise, and not in the SDK, the CLI or `docs/rest-api.md`
  until the module graduates (§7). Until then a module is described in its
  own spec. `ARCHITECTURE.md` and `FRONTEND.md` describe the module system,
  not each module.

## 7. Switching on and off

Two switches:

| Switch                         | Where                                         | Who                 | Default |
| ------------------------------ | --------------------------------------------- | ------------------- | ------- |
| The instance offers the module | `RETAINER_MODULES=dashboards`                 | Whoever runs it     | None    |
| The workspace uses it          | `workspaces.settings.modules: ['dashboards']` | A workspace `admin` | Off     |

A module is **on** for a workspace when both are set and the instance has
what the module requires (§5.1). **Settings → Experiments** lists the
modules the instance offers, each with its description and a switch. The
server ignores ids it doesn't know.

When a module is off for a workspace:

- its routes answer `404`, its tools are not listed over MCP or pinned on
  new chats, its guide is not listed, its chat context line is absent;
- its sidebar item, screens and chat renderers don't show;
- its data stays, and switching it back on shows it again.

Three details:

- **Chats.** Switching a module on doesn't change the pinned tools or the
  context of a chat that already exists (agent spec §8.3); new chats get
  them.
- **MCP clients.** A connection's tool list is fixed (`listChanged` stays
  `false`, as `mcp/server.ts` explains), so a connected client sees a
  module's tools after it reconnects.
- **Restricted mode.** Module routes and tools are not on the allowlist in
  `api/restricted.ts`, so they are not served while the API is restricted.

**Graduating.** A module that succeeds may stay a module, as
[extension-levels.md](../research/extension-levels.md) says. It sets
`alwaysOn: true`: it is on for every workspace, on every instance that has
what it requires, with no switch, and it leaves Settings → Experiments. Its folders stay. Its routes
and tools come into the API's promise, the SDK and `docs/rest-api.md`, and
`ARCHITECTURE.md` and `FRONTEND.md` describe it like any core feature.

## 8. Extension points built first

Each extension point is a field of `defineModule` or `defineWebModule`.
These are the ones Dashboards needs.

### 8.1 Tables

`schema.ts` in the module folder. `drizzle.config.ts` reads
`./src/modules/*/schema.ts` beside `db/schema.ts`, so adding a module
doesn't edit it. Migrations stay one sequence for the whole server,
generated and never hand-edited.

Every table:

- has a name that starts with the module's id (`dashboards`,
  `reminders_due`), so a reader knows who owns it;
- has `workspace_id` referencing `workspaces` with `on delete cascade`, so
  deleting a workspace needs no hook;
- has the same row-level security and grants as core tenant tables. Today
  that takes a second, hand-written security migration beside the generated
  one, as `0150_agent_tasks.sql` and `0151_agent_tasks_security.sql` do;
- references the core rows it depends on with a foreign key, so the
  database cleans up after them (`on delete cascade` or `set null`).

One test checks all four for every table of every module in the list, by
reading the migrated database's catalog.

### 8.2 Routes

`routes(v1, deps)` mounts under `/v1/<module id>/…` with the usual
authentication, scopes and rate limits. The registry wraps them: a
workspace where the module is off gets `404 not_found`. `deps` is a short
list that grows on purpose. It starts as `{ sql }`.

### 8.3 Tools

`tools` are MCP tools in the same form as the core's, each with
`agent: 'read' | 'write' | false`. The MCP server lists them after the
core's when the module is on, to every MCP client and not only to
Retainer's agent.

The agent pins Retainer's tools from a fixed list of names in
`@retainer/agent` (`RETAINER_TOOL_NAMES`), then adds extension tools.
`pinnedTools` (`agent-sessions/tools.ts`) gains a third source: the tools
of the modules that are on, placed after the core's and sorted by name. It
gets them through `RetainerToolHost` (§6.2), so the agent package needs no
module code. Write tools follow the agent's rules for writes (`agent.md`
D9).

### 8.4 Guide and chat context

`guide` adds a `get_guide` entry. The tool's list of names and its
description are built per caller, so a guide shows only where its module
is on.

`chatContext` returns one line for the first message of a new chat, or
nothing. It is given the chat's client: `web`, `cli` or `task`. Creating a
chat gains a `client` field for this, which the web app and the terminal
client send. It is a core field that names no module.

### 8.5 Web: routes, sidebar, chat blocks

`routes` are lazy pages under `/app/…`. `sidebar` is one item in the top
group, after the core items, in registry order; the command palette lists
it too. `chatBlocks` maps a fenced block's language (`openui-lang`) to a
lazy renderer. The chat shows a block's source as code when no module that
is on claims it.

## 9. Extension points for later

None of these is built. Each arrives with the first module that needs it
(§10). They are listed so that the first version doesn't close the door on
them, and so that two modules don't invent the same one twice.

| Extension point      | Shape                                                                        | Likely first user         |
| -------------------- | ---------------------------------------------------------------------------- | ------------------------- |
| Record page slot     | `recordPanel`: a lazy panel on a record's page, for chosen objects or events | Reminders, Recording      |
| Background jobs      | `jobs`: named jobs, on a schedule or queued by the module's own code         | CSV import, Reminders     |
| Merge                | `record.onMerge(tx, { workspaceId, from, into })`                            | Reminders                 |
| Forget               | `record.onForget(tx, { workspaceId, recordIds })`, returns the ids erased    | Data cascades can't reach |
| Member left          | `member.onLeft(tx, { workspaceId, userId })`, beside `deletePersonalMemory`  | Reminders, Notifications  |
| Record read addition | `record.summary`: a small section in `get_context` and `get_record`          | None yet                  |
| Settings section     | `settings`: a lazy section on the workspace settings page                    | None yet                  |
| Tools for Routines   | `routine: true` on a tool, so a Routine's `uses.tools` can name it           | None yet                  |
| Sidebar count        | `sidebar.count`: a number beside the item                                    | Notifications inbox       |

Three things are already known about them.

**Hooks in the core's transaction.** Merge, `forget` and member-left hooks
run inside the core's own transaction, after the core's steps, and their
failure fails the operation. They reach the core through `WriteContext`
(§6.2). **They keep running while a module is switched off**, as long as
its tables exist: a module that is off still holds the data it collected,
and `forget` must erase it. This is the one way in which "off" is not
"absent".

**Most modules won't need them.** A foreign key with `on delete cascade`
already removes a module's rows when `forget` hard-deletes a record, and
knowledge kept in records (§3) is merged and erased by the core. A hook is
for what the database can't do: pointing rows at the surviving record of a
merge, counting in the erasure receipt, or deleting something stored
outside Postgres.

**Jobs need one piece of setup on the hosted service.** There, each
scheduled job is a Lambda function whose schedule lives in the private
`retainer-cloud` repo, and finding due work across workspaces goes through
a `security definer` function for the executor role (as
`retainer_agent_tasks_due` does). The first module with a job adds one
shared module-jobs loop in the worker, one Lambda entry with its schedule,
and one discovery function. Later modules' jobs use the same three.

## 10. Adding an extension point

An extension point is a promise to every module, so adding one is a core
change with its own review:

1. The module that needs it adds it in its PR, to `api.ts`, the registry
   and the one core spot that calls it.
2. A test proves it with a fixture module defined in the tests
   (`packages/server/test/helpers/fixture-module.ts`), so the core's tests
   never depend on a real module.
3. This spec's §8 gains an entry, and §9 loses a row.

Two modules that need the same thing share the extension point; neither
imports the other.

## 11. Dashboards, the first module

As [dashboards.md](dashboards.md), with its pieces in the module's folders:
the `dashboards` table, its routes, `check_dashboard`, the guide, the chat
context line, the Dashboards screens and the `openui-lang` chat renderer.

Dashboards brings the module system with it: `defineModule`,
`defineWebModule`, the registry, the switch, the layer rules, the fixture
module, and the extension points in §8.

[dashboards.md](dashboards.md) was changed with this spec:

- **§5.1.** The web app doesn't send `{ "dashboards": true }` when it
  creates a chat. It sends `client: 'web'`, and the module's `chatContext`
  adds the line (§8.4).
- **§5.3.** `aggregate_records` and grouping by date and relation (its §7)
  stay in the core: they serve views and every agent, and stay if
  Dashboards is removed. `aggregate_records` joins the agent's fixed list
  of read tools. `check_dashboard` is the module's tool and is pinned
  through the registry (§8.3).
- **§6.1.** `chat_id` is a foreign key to the agent's sessions with
  `on delete set null`: a module table pointing at a core table, which
  rule 3 allows.
- **§8.2.** "Shown when the agent is available" becomes
  `requires: ['agent']`.
- **§6.2.** Its routes answer `404` where the module is off, and are
  experimental (§6.4).
- **§10.** Delivery follows §13 here, by module folder. The eval script
  lives in `packages/server/scripts/modules/dashboards/`.

Dashboards also adds dependencies, which live outside its folders (§12):
`@openuidev/lang-core` in the server, for the guide text and the save
check, and `@openuidev/react-lang` and Recharts in the web app.

## 12. Removing a module

1. Delete every path that contains `modules/<id>`, in `server` (code,
   tests, scripts), `web` and `shared`, and its line in each registry.
2. `pnpm db:generate --name drop_<module>` writes the migration that drops
   its tables, with their policies and grants. A SQL function the module
   added, such as a job's discovery function, needs a hand-written drop
   beside it.
3. Remove what lives outside those paths:
   - dependencies only it used, in `package.json` and
     `packages/web/THIRD_PARTY.md`;
   - its spec in `docs/specs/`, or a note there that it was removed;
   - its id in `RETAINER_MODULES`, on the hosted service too (stale ids in
     workspace settings do no harm, §7);
   - a hosted extension that existed only for it.

What the module added to the core stays: an extension point, or a core
read such as `aggregate_records`.

Two cautions:

- **The drop deletes the module's data in every workspace.** Switch the
  module off first by taking it out of `RETAINER_MODULES`, and drop the
  tables in a later release. What it wrote as records and events stays
  (§3).
- **The drop is a breaking migration** for the release before it, whose
  code still names the tables. Deploy it as other breaking migrations are
  deployed (`docs/migration-compatibility.md`).

A test runs the whole suite with an empty registry, so the core can't
depend on a module without anyone noticing.

## 13. Delivery and tests

**Dashboards** lands in one PR, in line with landing a feature whole: the
core aggregate additions, the module system with §8, and the Dashboards
module. If the PR grows too large, the aggregate additions go first on
their own.

Modules built in parallel touch only their own folders, each registry's
one line, and the extension points they add.

### 13.1 Acceptance tests

- **Unit**: `defineModule` rejects a module without an id; `createRegistry`
  refuses each clash in §6.2; a module is on only when the instance offers
  it, the workspace uses it and its requirements are met.
- **Integration (Postgres)**, with the fixture module: its routes answer
  when on and `404` when off; its tools are listed over MCP and pinned on
  new chats only when on; its guide and chat line appear only when on, and
  the chat line is given the chat's client.
- **Module tables**: the catalog check in §8.1, over the real list.
- **Layers**: `scripts/test-check-layers.mjs` gets fixtures for each rule
  in §6.3.
- **Empty registry**: the server and web test suites pass with no modules.
- **End to end (Playwright)**: switching Dashboards on in Settings →
  Experiments shows its sidebar item; switching it off hides it.

## 14. Left out on purpose

Each of these was considered and is not built. If one is needed, this is
the shape it would take.

- **Public routes and pages.** A feature that serves people who aren't
  signed in is a standalone app (§3). Booking stays as
  [booking-extension.md](booking-extension.md) plans it. A cheap public
  experiment inside the core would need its own extension point and a
  security review first.
- **Rolling out to chosen workspaces first.** With two switches, every
  workspace's admin can turn on what the instance offers. If the hosted
  service needs a quieter first step, a module gets a stage: `preview`
  (only an operator turns it on), then `experiment` (listed in Settings →
  Experiments).
- **A hook for schema changes.** A module that stores field names stores
  their keys, and reports a removed field when it is read, as Dashboards
  does (dashboards.md §6.4). The schema engine doesn't call modules.
- **Schema a module brings.** A module works with the objects a workspace
  has. One that needs its own object or event type would ask for it
  through the schema engine, as extensions do with bindings. Not designed.
- **Modules that depend on each other**, and a module API one module
  offers another (§6.3 rule 2).
- **Modules loaded at run time, or written by others.** Modules are
  first-party and compiled in. Code from outside is a hosted extension.
- **Exporting a module's data before it is removed.**

## 15. Prior art

- **Shopify's modular monolith**, with boundaries enforced by
  [Packwerk](https://github.com/Shopify/packwerk), as
  [extension-levels.md](../research/extension-levels.md) describes; here
  `check-layers.mjs` plays Packwerk's part.
- **Twenty's Lab** (concepts only, per `FRONTEND.md` §2): a list of public
  feature flags, each with a label and a description, that a workspace
  switches on in its settings (`core-modules/lab` and
  `feature-flag/constants/public-feature-flag.const.ts`). Settings →
  Experiments is the same idea. Twenty's flags gate code that stays spread
  through the codebase; a module's switch also owns the code behind it.
- **Twenty's applications** (concepts only): features that bring their own
  objects, logic and front components into the workspace, switched on per
  workspace.
