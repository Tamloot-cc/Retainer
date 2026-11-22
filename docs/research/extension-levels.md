# Where a feature lives: four levels

Retainer can host a new feature in four places, from cheap workspace
configuration to a separate app. This page names each level, gives examples
that exist today and ones that might come, and says which known architecture
it follows and how closely. It is a research note from November 2026, written
while pressure-testing the standalone-app design behind
[Booking](../specs/booking-extension.md). It is not a spec.

"Level" is used instead of "layer", because layers already mean the server
layers in `ARCHITECTURE.md` §8.

## In one table

| Level               | Runs where                               | Known architecture                               | How closely Retainer follows it               | Cost to remove                          |
| ------------------- | ---------------------------------------- | ------------------------------------------------ | --------------------------------------------- | --------------------------------------- |
| 1. Configuration    | Workspace data, no release               | Metadata-driven platform; event–condition–action | Close, but rules, not a workflow engine       | Delete it                               |
| 2. Hosted extension | Sandboxed functions in `packages/runner` | Plug-ins run as serverless connectors            | Plug-in packaging, run as background jobs     | Uninstall                               |
| 3. Core module      | Inside the server and its transaction    | Modular monolith                                 | Not yet: today it is a layered monolith       | Many files today; one folder when built |
| 4. Standalone app   | Its own service, database and UI         | Self-contained systems                           | Close; its tools ship with Retainer's release | Data migration                          |

## Choosing a level

A feature starts on the cheapest level that can test it. It moves from 1 to
2, or from 2 to 4, when usage justifies it. Levels 3 and 4 are not steps on
one ladder: they answer different questions.

- **Level 3** asks whether the feature must join the core's own transaction:
  move with a merge, be erased by `forget`, or be part of a record read.
- **Level 4** asks whether the feature needs its own truth, its own users or
  its own operations. It qualifies with at least two of these: rules Retainer
  cannot enforce (exclusive capacity, money, legal state), people who are not
  workspace members, a screen that is not records and views, and its own
  long-running state and worker.

How important a feature is decides whether to skip the experiment, not which
level it lives on. A successful level 3 module usually stays there.

A core module moves out to level 4 when its shape changes, not when it
succeeds. Signals:

1. It needs less from the core: its lifecycle hooks stop mattering and the
   public API is enough.
2. It grows its own rules: a state machine, constraints, and tables that
   mostly reference each other rather than core records.
3. It gets outside users, whose public traffic should not reach the core's
   API.
4. Its operations diverge: load, uptime, release pace, data residency, or a
   separate owner.
5. It has value without Retainer.
6. It should be MIT and distributed apart from the AGPL core.

Moving from 3 to 4 is costly: live data moves to a new database and the CRM
copy has to be added. A module that might move out should reach Retainer only
through ports shaped like the public SDK (hexagonal architecture), so the move
swaps an adapter. The Booking plan already does this for staff identity
([booking-implementation.md](../specs/booking-implementation.md)).

## 1. Configuration

Schema, saved views, templates and Routines. Workspace data, changed without
a release.

**Today.** Industry templates for clinics, real estate, recruiting, sales and
services (`packages/server/src/templates/`). Schema changes through the schema
engine. Routines, such as "when a deal moves to Proposal, create a task" or
"the day before an appointment, send a WhatsApp reminder"
([routines.md](../specs/routines.md) §9.1).

**Possible next.** Starter packs per industry that bundle a template, views
and Routines. SLA follow-up rules. A "Send quote" button, which is a Routine
with a manual trigger. Lead scoring on a schedule.

**Known architecture.** A metadata-driven platform, as in Salesforce, and
event–condition–action rules, as in Shopify Flow and Zapier.

**How closely.** Metadata-driven: close, since data is keyed by field
metadata and every schema change goes through the engine.
Event–condition–action: close. Workflow orchestration: partial. Each run is
one short step, with no state kept across steps, no waiting on another
event, no compensation on failure, and at-least-once delivery
([routines.md](../specs/routines.md) §9.3). It is a rules engine, not a
durable workflow engine such as Temporal.

## 2. Hosted extensions

First-party functions with a reviewed manifest, run sandboxed and started by
webhooks, schedules or record changes. They may contribute schema and publish
tools ([extensions.md](../specs/extensions.md),
[extensions-tools.md](../specs/extensions-tools.md)).

**Today.** Gmail through Nango, Granola, the Tamloot import, company
enrichment and last contact (`packages/runner/src/`).

**Possible next.** A WhatsApp send tool. Slack and PostHog. Phone and missed
calls, which closes the `no_source` gap in
[routines.md](../specs/routines.md) §9.2. A Cal.com connector, as a cheap test
of demand for bookings before building Booking. Google Calendar free and busy
times. An accounting connector.

**Known architecture.** The plug-in half of a microkernel, run as serverless
functions, in the role of integration connectors such as Zapier or Nango.

**How closely.** The packaging is close to plug-ins: the manifest declares
the extension points, a review approves them and the core loads the function.
The runtime is not: extensions run out of process as background jobs, and
the core never waits on one during its own write. Shopify Functions, by
contrast, run inside checkout. Only first-party builds run, so this is not
yet an open plug-in ecosystem.

## 3. Core modules

In-process code that must join the core's own transaction.

**Today.** Comments, views, files, search and retrieval, workspace and
personal memory, and the model proxy are candidates. None is a module yet in
the sense below.

**Possible next.** A notifications inbox, record images, tags, record-level
permissions, and reminders or snoozes on records.

**Known architecture.** A modular monolith, as in Shopify's components
enforced by [Packwerk](https://github.com/Shopify/packwerk), built from
vertical slices that plug into internal extension points.

**How closely.** Not yet. Today the server is a layered monolith: code is
split by technical layer (`api`, `mcp`, `reads`, `records`), and
`scripts/check-layers.mjs` enforces the layers, much as Packwerk enforces
boundaries. A feature still crosses many shared files. Comments, for example,
appear in `db/schema.ts`, `api/app.ts`, `mcp/tools/read.ts`,
`records/merge.ts`, `privacy/forget.ts`, `reads/records.ts`, two schema-engine
files, the MCP guides and the web app.

The target shape is one folder per module, which only `modules/index.ts`
imports:

```
packages/server/src/modules/
  index.ts          the only file that names modules
  comments/
    module.ts       plugs into the extension points
    schema.ts       its own Drizzle tables
    service.ts, routes.ts, mcp.ts, *.test.ts
packages/web/src/modules/comments/
```

```ts
export default defineModule({
  id: 'comments',
  enabled: 'workspaceFlag',
  routes: (v1, deps) => commentRoutes(v1, deps.sql),
  mcpTools: (server, ctx) => registerCommentTools(server, ctx),
  builtIn: { name: 'comment' /* describe_schema entry, reserved name */ },
  guide: commentGuideText,
  record: {
    // Run inside the core's transaction.
    onMerge: (tx, { from, into }) =>
      tx`update comments set record_id = ${into} where record_id = ${from}`,
    onForget: (tx, { workspaceId, recordIds }) => eraseComments(tx, workspaceId, recordIds),
    summary: (sql, recordId) => countComments(sql, recordId),
  },
});
```

The extension points are routes, MCP tools, record lifecycle hooks (merge,
`forget`, move, workspace deletion), record read additions, built-in schema
entries and reserved names, guide text, and web slots (a record panel, a
settings tab, a sidebar item). Each new extension point is a deliberate core
change.

Rules for `check-layers.mjs`:

1. Only `modules/index.ts` imports a module.
2. A module imports the core, the foundation and the module API, never
   another module.
3. Module tables may reference core tables; core tables never reference
   module tables.
4. A module's tests live in its folder.

Removing a module deletes its folders and its line in `index.ts`, and
`pnpm db:generate` writes the migration that drops its tables. Turning a
module off is not removing it: while its data exists, its `onForget` and
`onMerge` hooks keep running, or `forget` would leave personal data behind.
The hooks go only in the release that drops the tables.

## 4. Standalone apps

A service with its own database, worker and UI. It connects through an
installation grant, keeps a read-only copy in the CRM, signs staff in through
Retainer from the sidebar, and publishes tools for Routines
([standalone-apps.md](../standalone-apps.md)).

**Today.** Booking, as a spec and a plan, not built. Tamloot runs as a level 2
extension that pulls meetings from Tamloot's API; the standalone path, where
Tamloot pushes into Retainer, is described but is not what runs.

**Possible next.** Invoicing and payments, a forms and intake builder, a
client portal, e-signature, memberships and packages, and campaign sending.

**Known architecture.** [Self-contained systems](https://scs-architecture.org):
each has its own UI, data and logic, integrates with others asynchronously,
and joins other UIs by links. Inside, Booking uses bounded contexts from
domain-driven design, a
[transactional outbox](https://microservices.io/patterns/data/transactional-outbox.html),
a read model in the CRM, and OpenID Connect for sign-in.

**How closely.** Close; even the link-only UI is what self-contained systems
recommend. Two deviations: tool functions are compiled into Retainer's runner,
so an app cannot ship new tools without a Retainer release, and apps cannot
call each other directly.

## Across the levels

- Retainer as the hub is hub-and-spoke integration around shared data, the
  blackboard pattern. In the terms of
  [Enterprise Integration Patterns](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IntegrationStylesIntro.html),
  apps integrate by shared database and messaging, not by calling each other.
- Routines connecting apps are orchestration.
- An app reacting to the change feed is choreography, with
  [event notification](https://martinfowler.com/articles/201701/event-driven.html)
  and event-carried state transfer.

Shopify has the same overall shape: a modular monolith core, external apps
over its API and webhooks, Flow for connecting apps, and Shopify Functions as
the in-process plug-ins at fixed points. Shopify offers no platform channel
for one app to call another; apps that need it build direct integrations
outside Shopify. Retainer's open question is whether it wants the same, or a
reviewed way for one installation to call another's tools.
