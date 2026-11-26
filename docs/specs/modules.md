# Modules: spec

Status: **proposed**, 2026-11-26. Turns level 3 of
[extension-levels.md](../research/extension-levels.md) ("core modules") into
a design, for three planned features: Dashboards, Recording and Booking.
Section 2 lists what is decided and what is only proposed.

If accepted this spec amends:

- `ARCHITECTURE.md` §8 (a new `modules` layer, §5.3).
- [extension-levels.md](../research/extension-levels.md) §3 ("Today": the
  first modules) and its sketch of `defineModule`, which this spec replaces.
- [dashboards.md](dashboards.md) §10 (Dashboards is built as the first
  module, §9.1).
- [booking-extension.md](booking-extension.md) §1, only if §12 question 1 is
  answered "module first" (§9.3).

## 1. The idea on one page

Several features are planned within a month, and they are experiments. Each
should live in one place, be switched on per workspace, and come out
cleanly if it fails. Built the way features are built today, a feature is
spread over a dozen shared files: the schema, the API's route list, the MCP
server, the guides, merge, `forget`, the web app's routes and sidebar.

A **module** is one folder per package that holds the whole feature:

```
packages/server/src/modules/dashboards/    tables, service, routes, tools, guide (AGPL)
packages/web/src/modules/dashboards/       screens, sidebar item, chat renderer (MIT)
packages/shared/src/modules/dashboards/    contracts both sides use (MIT), when needed
```

Each folder exports one definition: which **extension points** it plugs into
(routes, tools, a sidebar item, a merge hook). The core never imports a
module. It reads one registry per package, `modules/index.ts`, and calls
every module that is on for the workspace at each extension point.

- **Adding a module**: its folders plus one line in each registry.
- **Switching it off** for a workspace: one setting. Everything it shows
  disappears; its data stays, and its privacy hooks keep running (§6).
- **Removing it**: delete the folders and the registry lines, then
  `pnpm db:generate` writes the migration that drops its tables (§10).

The module system starts small. It has only the extension points the first
module needs, and each later module adds the ones it needs, in its own PR,
as a deliberate core change (§8).

## 2. Decided and proposed

Decided with the product owner on 2026-11-26:

- **Experimental features are modules**, at level 3 of
  [extension-levels.md](../research/extension-levels.md): in-process, in
  Retainer's database and transaction, but kept in their own folders.
- **A registry, not direct imports.** The core knows "modules", never a
  module by name. Chosen over "a feature folder with direct hookups" because
  several modules will be built in parallel: with a registry they don't all
  edit the same shared files, and "off" is applied in one place.
- **Built only as far as needed.** The first module brings the registry and
  the extension points it uses. Merge and `forget` hooks, public pages and
  the rest arrive with the module that needs them.
- **Dashboards is the first module.**

Proposed in this document: the shape (§4–§5), the extension points (§7), the
switch (§6), the rules (§5.3), the order (§11). §12 lists the open
questions, two of which change scope: whether Booking starts as a module
(§9.3), and what Recording covers (§9.2).

## 3. What the three modules need

Each module was read against the extension points it would use. This table
drives the design: a point only one module needs arrives with that module.

| Extension point                       | Dashboards | Recording | Booking | Arrives with |
| ------------------------------------- | ---------- | --------- | ------- | ------------ |
| Own tables                            | Yes        | Yes       | Yes     | Dashboards   |
| API routes (signed in)                | Yes        | Yes       | Yes     | Dashboards   |
| MCP tools, and agent tools            | Yes        | Yes       | Yes     | Dashboards   |
| Guide text                            | Yes        | Maybe     | Yes     | Dashboards   |
| Chat context line                     | Yes        | No        | No      | Dashboards   |
| Web: screens and sidebar item         | Yes        | Yes       | Yes     | Dashboards   |
| Web: chat block renderer              | Yes        | No        | No      | Dashboards   |
| Record lifecycle: merge, `forget`     | No         | Yes       | Yes     | Recording    |
| Record read additions (`get_context`) | No         | Yes       | Yes     | Recording    |
| Background jobs                       | No         | Yes       | Yes     | Recording    |
| Web: record panel                     | No         | Yes       | Yes     | Recording    |
| Public routes and pages (no sign-in)  | No         | No        | Yes     | Booking      |
| Tools for Routines                    | No         | Maybe     | Yes     | Booking      |
| Web: settings section                 | No         | Maybe     | Yes     | Booking      |

Workspace deletion needs no hook: module tables reference `workspaces` with
`on delete cascade`, as core tables do.

## 4. A module

### 4.1 Server

```ts
// packages/server/src/modules/dashboards/module.ts
import { defineModule } from '../api.js';

export default defineModule({
  id: 'dashboards',
  name: 'Dashboards',
  description: 'Live dashboards the agent writes and people pin.',
  routes: (v1, deps) => dashboardRoutes(v1, deps),
  tools: [checkDashboardTool],            // MCP; `agent: 'read'` also pins it on chats
  guide: { name: 'dashboards', description: '…', text: dashboardGuide },
  chatContext: ({ client }) =>
    client === 'web' ? 'This chat is in Retainer\'s web app, which can show dashboards; …' : null,
});
```

`defineModule` is a typed identity function: it checks the shape and returns
it. Every field but `id`, `name` and `description` is optional, and each
field is one extension point (§7). A module's tables live in its own
`schema.ts`, which `drizzle.config.ts` reads beside `db/schema.ts` (§7.1).

### 4.2 Web

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
nothing. The web app learns which modules are on from the workspace it
loads (§6).

### 4.3 Shared contracts

When the server and the web app share types or a component list, they live
in `packages/shared/src/modules/<id>/` (MIT), exported from
`@retainer/shared` under the module's name. A module with nothing to share
has no shared folder.

## 5. Where modules sit

### 5.1 Server folders

```
packages/server/src/modules/
  api.ts              defineModule and the extension point types
  index.ts            the registry: the only file that imports modules
  registry.ts         which modules are on for a workspace; calls them at each point
  dashboards/
    module.ts         its definition
    schema.ts         its Drizzle tables
    service.ts, routes.ts, tools.ts, guide.ts, *.test.ts
```

### 5.2 How the core calls a module

At each extension point, the interface layer that owns it asks the registry
for the modules that are on and calls them. For example, `api/app.ts` mounts
`registry.routes()` once, and each module's routes answer `404` in a
workspace where it is off. `mcp/server.ts` registers `registry.tools(caller)`
after the core tools. `privacy/forget.ts` calls `registry.onForget(tx, …)`
inside its transaction. No core file names a module.

### 5.3 Layers and rules

Modules are a new layer between `admin` and `interfaces` in
`scripts/check-layers.mjs`. A module may use the core, the features and the
admin layer (the schema engine, workspaces), which is what lets it write
records and events the normal way. The interfaces (API, MCP, worker) reach
modules only through the registry.

The checker enforces:

1. Only `modules/index.ts` imports a module folder.
2. A module imports the layers below, `modules/api.ts`, and its own folder:
   never another module, never an interface module.
3. Module tables may reference core tables; core tables never reference
   module tables.
4. A module's tests live in its folder.
5. The same rules hold in `packages/web/src/modules/` and
   `packages/shared/src/modules/`.

Rule 2 keeps modules independent: two modules that need each other are one
module, or one of them needs an extension point.

### 5.4 Repo rules still apply

A module is core code, so every rule in `CLAUDE.md` holds for it:

- Writes carry the caller's `Actor`. A background job acts as the `system`
  actor with `via: '<module id>'`, like the core's own jobs.
- Records and events are written through the core write path (assertions,
  never `records.data`), and schema changes go through the schema engine.
- **No model calls.** A module that needs a model (Recording's transcripts,
  §9.2) hands that step to an extension or a Routine, which may call the
  model proxy.
- Server module folders are AGPL; web and shared module folders are MIT.

## 6. Switching on and off

Two switches:

| Switch                         | Where                                         | Who                 | Default |
| ------------------------------ | --------------------------------------------- | ------------------- | ------- |
| The instance offers the module | `RETAINER_MODULES=dashboards,recording`       | Whoever runs it     | None    |
| The workspace uses it          | `workspaces.settings.modules: ['dashboards']` | A workspace `admin` | Off     |

A module is **on** for a workspace when both are set. The hosted service
turns a module on for chosen workspaces first, then for everyone.
**Settings → Experiments** lists the modules the instance offers, each with
its description and a switch.

When a module is off for a workspace:

- its routes answer `404`, its tools are not listed over MCP or pinned on
  new chats, its guide is not listed, its chat context line is absent;
- its sidebar item, screens, panels and chat renderers don't show;
- its background jobs don't run for that workspace;
- **its merge and `forget` hooks still run**, while its tables exist. A
  module switched off still holds the data it collected, and `forget` must
  erase it ([extension-levels.md](../research/extension-levels.md) §3).

Switching a module on for a chat that already exists doesn't change its
pinned tools or context (agent spec §8.3); new chats get them.

## 7. Extension points

Each extension point is a field of `defineModule` or `defineWebModule`. The
list grows by one deliberate core change at a time (§8). These are the ones
the three modules need.

### 7.1 Tables — Dashboards

`schema.ts` in the module folder, listed in `drizzle.config.ts`'s `schema`
(Drizzle accepts several files). Migrations are generated as today, one
sequence for the whole server, never hand-edited. Every table has
`workspace_id` referencing `workspaces` with `on delete cascade` and the
same row-level security as core tenant tables. Table names start with the
module's id (`dashboards`, `recording_files`, `booking_reservations`), so a
reader knows who owns them.

### 7.2 Routes — Dashboards

`routes(v1, deps)` mounts under `/v1/<module id>/…` with the usual
authentication, scopes and rate limits. The registry wraps them: a
workspace where the module is off gets `404 not_found`.

### 7.3 Tools — Dashboards

`tools` are MCP tools in the same form as the core's, each with
`agent: 'read' | 'write' | false`. The MCP server lists them after the
core's when the module is on. The agent pins the `read` ones on new chats:
the agent runs Retainer tools by name through the MCP host
(`agent-sessions/tools.ts`), so the agent package needs no module code.
Write tools follow the agent's rules for writes (`agent.md` D9).

### 7.4 Guide and chat context — Dashboards

`guide` adds a `get_guide` entry. `chatContext` returns one line for the
first message of a new chat, given the client (`web`, `cli`, `task`), or
nothing.

### 7.5 Web: routes, sidebar, chat blocks — Dashboards

`routes` are lazy pages under `/app/…`. `sidebar` is one item in the top
group, after the core items, in registry order. `chatBlocks` maps a fenced
block's language (`openui-lang`) to a lazy renderer; the chat shows the
block's source as code when no module claims it.

### 7.6 Record lifecycle — Recording

```ts
record: {
  onMerge: (tx, { workspaceId, from, into }) => …,     // inside merge's transaction
  onForget: (tx, { workspaceId, recordIds }) => …,     // inside forget's transaction; returns ids erased
}
```

Both run inside the core's transaction, in registry order, after the core's
own steps, and their failure fails the merge or the erasure. `onForget`
reports what it erased, so the erasure receipt counts it like comments.

### 7.7 Record reads — Recording

`record.summary(sql, { workspaceId, recordId })` adds a small section to
`get_context` and `get_record` (`"recordings": { "count": 3, "latest": … }`),
under the module's id, only when the module is on.

### 7.8 Background jobs — Recording

`jobs` declares named jobs: on a schedule (`every: '5m'`) or queued by the
module's own code (`enqueue('transcribe', payload)`). The worker runs them
like its other loops, with retries and the `system` actor. On the hosted
service they run where the worker runs today; no new infrastructure.

### 7.9 Web: record panel — Recording

`recordPanel` adds a lazy panel to a record's page for chosen objects or
for events, such as a player on a call's event.

### 7.10 Public routes and pages — Booking

The only extension point that serves people who are not signed in. Routes
mount under `/p/<workspace slug>/<module id>/…` with their own, stricter
rate limits, no session, and no access to workspace data except through the
module's own service. Pages are lazy web routes outside the app shell.
This point gets its own security review before it is added.

### 7.11 Tools for Routines — Booking

Module tools marked `routine: true` can be named in a Routine's
`uses.tools`, beside extension tools. Today `uses.tools` resolves only to
installed extension tools (`routines/manifest.ts`).

### 7.12 Settings section — Booking

`settings` adds a lazy section to the workspace settings page.

## 8. Adding an extension point

An extension point is a promise to every module, so adding one is a core
change with its own review:

1. The module that needs it adds it in its PR, to `api.ts`, the registry
   and the one core spot that calls it.
2. A test proves it with a fixture module (`modules/test-fixture/`, used
   only by tests), so the core's tests never depend on a real module.
3. This spec's §7 gains an entry.

Two modules that need the same thing share the extension point; neither
imports the other.

## 9. The three modules

### 9.1 Dashboards

As [dashboards.md](dashboards.md), with its pieces in the module's folders:
the `dashboards` table, its routes, `check_dashboard`, the guide, the chat
context line, the Dashboards screens and the `openui-lang` chat renderer.
`aggregate_records` and grouping by date and relation (its §7) stay in the
core: they serve views and every agent, and stay if Dashboards is removed.

Dashboards brings the module system with it: the registry, `defineModule`
and `defineWebModule`, the switch, the layer rules and the fixture module,
with extension points §7.1–§7.5.

### 9.2 Recording

**Assumed scope**, to be confirmed (§12 question 2): a person records a
meeting or call in the web app (later in the macOS companion,
[macos-companion.md](../macos-companion.md)). The audio is stored with the
core's file storage and linked to an event; its transcript becomes the
event's full text, which `get_event_content` already serves.

- Tables: `recording_files` (event, file, duration, status).
- Uses §7.6 (a merge moves recordings with their event; `forget` erases the
  audio and the transcript), §7.7, §7.8 (finish uploads, hand off for
  transcription), §7.9 (a player on the event).
- **The transcript is not written by the module.** Speech-to-text is a model
  call, which the core and its modules never make (§5.4). A hosted extension
  transcribes through the model proxy and writes the text back through the
  API, as the Granola and Tamloot extensions write meeting content today.

Recording adds extension points §7.6–§7.9, so it tests the part Dashboards
can't: hooks inside the core's transactions.

### 9.3 Booking

[booking-extension.md](booking-extension.md) plans Booking as a standalone
app (level 4): its own service, database and worker. Building it as a module
first reverses that, so it needs a decision (§12 question 1).

- **For a module first**: one deploy, one database, no installation grant
  or sign-in hand-off, so the experiment is far cheaper. If demand is
  proven, it moves out.
- **Against**: Booking already meets level 4's test in
  [extension-levels.md](../research/extension-levels.md): rules Retainer
  can't enforce (exclusive capacity), people who are not members (guests), and
  its own long-running state. It would bring the public extension point
  (§7.10) into the core, and moving out later means moving live data.

If it starts as a module, its plan's seams still hold
([booking-implementation.md](booking-implementation.md) §1): a pure domain
core, one command layer, an event log with an outbox, and Retainer reached
only through a port shaped like `@retainer/sdk`. Then moving it out swaps
an adapter, as the research note asks. Booking would add §7.10–§7.12.

## 10. Removing a module

1. Delete its folders in `server`, `web` and `shared`, and its line in each
   registry.
2. `pnpm db:generate --name drop_<module>` writes the migration that drops
   its tables. This is the release that removes its hooks: until then, they
   keep running for `forget` (§6).
3. Remove its id from `RETAINER_MODULES` and from workspace settings (the
   server ignores unknown ids, so stale settings do no harm).

Nothing else changes, which is the point of the design. A test runs the
whole suite with the registry empty, so the core can't depend on a module
without anyone noticing.

## 11. Order and delivery

1. **Dashboards** (one PR, in line with landing a feature whole): the core
   aggregate additions, the module system with §7.1–§7.5, and the
   Dashboards module. If the PR grows too large, the aggregate additions go
   first on their own.
2. **Recording**: adds §7.6–§7.9 with the fixture module's tests, then the
   module. Its transcription extension ships in the same release.
3. **Booking**: adds §7.10–§7.12, after a security review of public routes,
   if it starts as a module at all.

Modules built in parallel touch only their own folders, each registry's
one line, and the extension points they add.

### 11.1 Acceptance tests

- **Unit**: `defineModule` rejects a module without an id or with a
  duplicate id; the registry lists a module only when both switches are on.
- **Integration (Postgres)**, with the fixture module: its routes answer
  when on and `404` when off; its tools are listed and pinned only when on;
  its guide and chat line appear only when on; workspace deletion removes
  its rows; once added, `onMerge` and `onForget` run inside the core's
  transaction and roll back with it, also when the module is off.
- **Layers**: `scripts/test-check-layers.mjs` gets fixtures for each rule in
  §5.3.
- **Empty registry**: the server and web test suites pass with no modules.
- **End to end (Playwright)**: switching Dashboards on in Settings →
  Experiments shows its sidebar item; switching it off hides it.

## 12. Open questions

1. **Booking: module first, or standalone as planned?** Recommended: start
   as a module built behind its planned ports, since the goal is a cheap
   experiment, and keep the standalone plan as the destination if it
   succeeds. The cost is a public extension point in the core.
2. **What Recording covers.** §9.2 assumes recording meetings and calls in
   the web app, stored as files and transcribed by an extension. If it
   means something else (screen recording, or importing recordings from
   other tools), its extension points change.
3. **Who switches a module on.** Recommended: a workspace `admin`, in
   Settings → Experiments, with the instance list as the outer gate.
4. **Modules over MCP for every client.** When a module is on, its tools are
   listed to every MCP client, not only the agent. Recommended: yes, as for
   core tools; a module that wants otherwise sets `mcp: false` on a tool.
5. **Graduating.** A module that succeeds may stay a module, as
   [extension-levels.md](../research/extension-levels.md) says. Should a
   graduated module lose its switch (always on)? Recommended: yes, by
   setting `alwaysOn: true`, which keeps its folder but drops it from
   Settings → Experiments.

## 13. Prior art

- **Shopify's modular monolith**, with boundaries enforced by
  [Packwerk](https://github.com/Shopify/packwerk), as
  [extension-levels.md](../research/extension-levels.md) describes; here
  `check-layers.mjs` plays Packwerk's part.
- **Twenty's applications** (concepts only, per `FRONTEND.md` §2): features
  that bring their own objects, logic and front components into the
  workspace, switched on per workspace.
- **Feature flags with a kill switch**, as in most SaaS products; a module's
  switch is a flag that also owns the code behind it.
