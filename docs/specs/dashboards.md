# Dashboards: spec

Status: **shipped** in #212, live on 2026-11-27. Proposed 2026-11-26. A
local spike (branch `spike/dashboards`) proved the approach end to end
(§11). Revised the same day after a look at
Twenty's dashboards: dashboards are stored by key and survive renames
(§6.4), the agent reads a guide only when asked for a dashboard (§5.1), and
it checks its program before answering (§5.3). For one day it was rewritten
as the first module of [modules.md](modules.md). On 2026-11-27 the product
owner decided it is a core feature, like views and Routines, and the
module system is parked (§2). Reviewed against the code the same day,
which changed how saved dashboards relate to chats (§8.3), how the data
tools differ from the API (§4.3), grouping by built-in dates (§7.1) and the
shape of the chat pieces (§8.1). Section 2 lists what is decided and what
is only proposed.

Builds on the workspace agent in [agent.md](agent.md). If accepted this spec
amends:

- `ARCHITECTURE.md` §1.4 (a new table, `dashboards`, beside `views`), §5
  (the aggregate read groups by dates and relations, §7), §6.1 (new
  routes, §6.2) and §8 (a `dashboards` folder beside `views`).
- `agent.md` §6.6 (creating a chat takes its `client`, and web chats tell
  the agent it can answer with a dashboard, §5.1) and §8.1 (new read tools,
  `aggregate_records` and `check_dashboard`, §5.3).
- The MCP guides (a new `dashboards` guide, §5.1).
- `FRONTEND.md` §5 (a Dashboards screen, and dashboards in the chat, §8).
- `docs/rest-api.md` (the new routes).

The write rules, the actor types and the rule that Retainer's core never calls
a model do not change. The agent writes a dashboard; the person saves it;
showing it again needs no model.

## 1. The idea on one page

A person asks the agent for a dashboard in plain words: "deals by stage this
quarter, with total pipeline and the biggest open deals". The agent answers
with a short sentence and a live dashboard, drawn in the chat: headline
numbers, charts and tables over the workspace's records. "Show the amount
instead of the count" changes it in place. **Pin** saves it, and it appears
under **Dashboards** in the sidebar, next to Chat.

A saved dashboard is a short program in OpenUI Lang, an open declarative
language (MIT) made for models to write. The program says which components to
show and which queries feed them. It holds no numbers: each time the
dashboard opens, its queries run in the viewer's browser through Retainer's
API, with the viewer's own access. So a dashboard is always current, two
people can see different numbers on the same dashboard if their access
differs, and opening one never calls a model.

```
 person ──"deals by stage…"──▶ agent ──program──▶ chat shows it live ──Pin──▶ dashboards row
                                │                                               │
                 get_guide("dashboards"), describe_schema,          opened later: queries run
                 aggregate_records, check_dashboard                in the browser, no model call
```

Everything runs inside Retainer. OpenUI's hosted product (Thesys's
Dashboards and gateway) is not used, and nothing is sent to Thesys.

## 2. Decided and proposed

Decided with the product owner on 2026-11-26:

- **Built in-house** on OpenUI's open-source language and renderer only:
  `@openuidev/lang-core` and `@openuidev/react-lang`, MIT. Not OpenUI's
  hosted Dashboards product, which needs a Thesys key and keeps dashboards in
  Thesys's cloud. Not OpenUI's component kit (`@openuidev/react-ui`), which
  brings about 30 dependencies and its own styles: Retainer draws its own
  components.
- **The agent writes, the person saves.** The agent never saves a dashboard
  itself.
- **Dashboards are read-only.** A program can only read. It has no write
  tools, forms or buttons.
- **The spike's design carries over**: one component list shared by the
  agent's prompt and the web app's renderers (§4.2), data tools that run in
  the browser (§4.3), edits as patches (§5.2).
- **Dashboards survive renames**, as views do: a renamed field or object
  leaves every dashboard working (§6.4).
- **From Twenty**: the agent reads how to build a dashboard only when one is
  asked for (a guide, §5.1), and checks its program and gets the problems
  back before answering (§5.3).

Decided with the product owner on 2026-11-27:

- **Dashboards is a core feature**, beside views and Routines. This
  replaces "Dashboards is a module", decided the day before
  ([modules.md](modules.md), now parked, gives the reasons). It has no
  switch of its own: it shows wherever the workspace agent is available,
  as the chat does. Its code still sits in its own `dashboards` folders
  (§10), so removing it stays one ordinary PR.
- **One experience for dashboards, views and Routines.** Each is made the
  same way: a person describes it in the chat, the agent drafts and checks
  it, the person sees it live and keeps it. Only the last step differs
  with the risk: a view is saved, a dashboard is pinned, a routine is
  proposed and then approved. That shared design is not written yet. This
  spec builds its dashboard parts in the core so that views and Routines
  can use them: the guide read on demand (§5.1), the check before
  answering (§5.3) and the draft shown in the chat (§8.1).

Proposed in this document, open to change: the storage and routes (§6), the
aggregate additions (§7), the chart library (§8.4), the limits (§9) and the
delivery (§10). §12 lists the open questions.

Considered and not taken:

- **Vercel's UI SDK** (`ui-sdk.dev`) builds an app's controls and lets an
  agent operate them. It has no charts and does not render model output.
- **json-render** (Vercel Labs) does the same job as OpenUI Lang with JSON
  output. OpenUI's own benchmark puts its language at about half the tokens
  of json-render's JSON (not measured here), and its edit mode merges small
  patches by statement name. json-render stays the fallback if OpenUI Lang
  stops serving us.
- **Twenty's approach**: structured widget settings (object, measure, group
  field) chosen in a form. Robust, but every new kind of tile needs new
  settings and new UI. A program lets the agent combine queries and
  components freely within a fixed list. §13 records what was taken from
  Twenty.

## 3. How it works

### 3.1 Vocabulary

| Term            | Meaning                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| Dashboard       | A saved program with a name and a visibility, like a view                                     |
| Program         | OpenUI Lang text: one statement per line, `name = Expression`, with `root = Dashboard(…)`     |
| Tile            | One component on a dashboard: a metric, a chart or a table                                    |
| Data tool       | A read a program's `Query` calls: `query_records` or `aggregate_records`                      |
| Alias           | A name a query gives one of its results, such as `pipeline`; the rest of the program reads it |
| Dashboard guide | `get_guide("dashboards")`: the language, the components and the rules, read on demand (§5.1)  |

### 3.2 Where each part runs

| Part                           | Runs in                          | Notes                                                         |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------- |
| Writing the program            | Agent runtime, the agent's model | Same model and limits as any chat turn                        |
| Checking the agent's queries   | Agent runtime → API              | `aggregate_records` and `query_records`, the person's access  |
| Rendering, and running `Query` | The viewer's browser             | `@openuidev/react-lang` with Retainer's components            |
| Data tools                     | Browser → REST API               | The viewer's session or key; read-only                        |
| Saving, validating             | API                              | `@openuidev/lang-core` parses; the schema check is Retainer's |

## 4. The program

### 4.1 The language

OpenUI Lang 1.0, a subset. A program is a list of statements. References may
come before their definitions, so the agent writes the root first and the
dashboard fills in top-down as it streams. The parts used:

- **Components**: only those in §4.2. An unknown component is dropped and
  reported, never rendered.
- **`Query(tool, args, defaults, refresh?)`**: calls a data tool (§4.3).
  OpenUI uses `defaults` before a read resolves. Dependent tiles show a loading
  state until the first result arrives and show an error if the read fails.
- **Dot access and built-ins** such as `data.groups.label`, `@Count`,
  `@Sort`, `@Filter`: computed in the browser on query results.

Two rules keep a program safe to store (§6.4):

1. **Field names appear only inside a `Query`'s arguments.** Everything
   outside reads aliases the query defines: `as` on each aggregate, and
   `fields` on `query_records`, which maps aliases to fields. A table column
   names an alias, never a field.
2. **A `Query`'s arguments are plain values**: strings, numbers, booleans,
   lists and objects, with no references to other statements.

Not used: `Mutation`, `$variables`, forms, inputs, buttons and actions. The
agent's prompt leaves them out (`bindings: false`) and the save check refuses
`Mutation` (§6.3). A program cannot run code: the language has no functions
of its own, and the renderer evaluates it without `eval`.

An example in the form this spec proposes. The spike's programs read
derived names such as `sum_amount` and passed a currency code to each money
tile; both are gone:

```
root = Dashboard("Deals", [kpis, stages, open])
byStage = Query("aggregate_records", {object: "deal", groupBy: "stage", aggregates: [{field: "amount", op: "sum", as: "pipeline"}]}, {total: 0, values: {}, groups: []})
recent = Query("query_records", {object: "deal", filter: {stage: {in: ["lead", "qualified", "proposal"]}}, sort: [{field: "amount", direction: "desc"}], limit: 10, fields: {stage: "stage", amount: "amount"}}, {records: []})
kpis = Row([count, pipeline])
count = Metric("Deals", byStage.total)
pipeline = Metric("Pipeline", byStage.values.pipeline)
stages = BarChart("Amount by stage", byStage.groups.label, byStage.groups.pipeline)
open = Table("Biggest open deals", recent.records, [TableColumn("Deal", "label"), TableColumn("Stage", "stage"), TableColumn("Amount", "amount")])
```

The keys before the colons in `fields:` are aliases that happen to match the
field names. If `amount` is renamed to `value`, the table still reads the
alias `amount`; only the query's argument changes (§6.4).

### 4.2 Components

One list, in `@retainer/shared` (MIT, `packages/shared/src/dashboards/`),
with each component's props as a zod schema and a one-line description.
`shared` takes
no OpenUI dependency: the server builds the library with `lang-core`'s
`defineComponent` to generate the guide (§5.1), and the web app builds it
with `react-lang`'s and its own renderers. The guide and the renderers
therefore cannot drift apart.

| Component     | Props, in order                        | Shows                                                                                       |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| `Dashboard`   | `title`, `children`                    | The root: a title and tiles, top to bottom                                                  |
| `Row`         | `children`                             | Tiles side by side; stacked on a phone                                                      |
| `Metric`      | `label`, `value`, `format?`            | One headline number                                                                         |
| `BarChart`    | `title`, `labels`, `values`, `format?` | Values across categories                                                                    |
| `StackedBar`  | `title`, `labels`, `series`, `format?` | Categories split by a second grouping                                                       |
| `LineChart`   | `title`, `labels`, `series`, `format?` | Values over time (dates from §7.1)                                                          |
| `PieChart`    | `title`, `labels`, `values`, `format?` | Shares of a whole; seven slices at most, the rest as "Other"                                |
| `Table`       | `title`, `rows`, `columns`             | Records with chosen columns, at most 100 rows                                               |
| `TableColumn` | `label`, `key`, `format?`              | One column of a `Table`; `key` is an alias from the query, or `label` for the record's name |
| `Series`      | `name`, `values`                       | One line or one stack in a chart                                                            |
| `Text`        | `text`                                 | A short note, plain text                                                                    |

`format` is `number` (the default), `percent` or `date`. It is not needed
for money: money values keep their currency (§4.3), and every component
formats them as money in that currency. The spike's `money` format with a
typed currency code is dropped: the agent could only guess the currency.

Option and relation groups show their labels ("Negotiation", "Acme"), never
their stored values. Empty groups show "No value".

### 4.3 Data tools

Two reads a program's `Query` can call. They run in the browser, on top of
the API's query and aggregate routes. The agent has tools of the same names
with the same filters, sorts and groupings (§5.3), so it can try a query
before it writes it.

| Tool                | Input                                                                                                                                | Output                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `query_records`     | `object`, `filter`, `search`, `sort`, `limit` (at most 200), as `POST /v1/objects/:object/query`, and `fields: { <alias>: <field> }` | `{ records: [{ id, label, <alias>: value }] }`                                                       |
| `aggregate_records` | `object`, `filter`, `search`, `aggregates: [{ field, op, as }]`, `groupBy`, `granularity`, `limit` (§7)                              | `{ total, values: { <as>: value }, groups: [{ value, label, total, <as>: value }], tooManyGroups? }` |

The browser's tools differ from the API, and from the agent's tools, in
two ways, both for display:

- **Results are keyed by alias.** The API returns an aggregate's values as
  a list, `[{ field, op, as, value }]`, on the result and on each group.
  The browser's tool turns each list into `{ <as>: value }`, so a program
  reads `byStage.values.pipeline` and `byStage.groups.pipeline`. In
  `query_records`, `fields` picks the fields to return and names them; it
  exists only in the browser's tool.
- **Values are made plain**, as the table below shows.

Every aggregate in a program has an `as`, and every alias is a plain
identifier, unique within its query. `id`, `label`, `value` and `total`
are taken (§6.3).

Values are made plain for display:

| Field type                  | Becomes                                 |
| --------------------------- | --------------------------------------- |
| `money`                     | `{ amount, currency }`, amount in units |
| `full_name`                 | "First Last"                            |
| `emails`, `phones`, `links` | The primary one                         |
| `select`                    | The option's label                      |
| `multi_select`              | Labels joined by ", "                   |
| relation                    | The related record's label              |
| everything else             | As the API returns it                   |

Charts read a money value's `amount`. A sum over several currencies comes
back as `null` with `mixedCurrencies`, and the tile says "Mixed currencies"
instead of adding them up.

## 5. The agent

### 5.1 The dashboard guide

The agent learns the language only when it needs it, as Twenty's agent loads
its dashboard skill (§13). The instructions are a guide,
`get_guide("dashboards")`, beside the existing ones such as `memory` and
`log_from_chat`. Its text is generated from the component list with
`lang-core`'s `library.prompt()`: the language, the components, the data
tools, edit mode and inline mode (text with a fenced `openui-lang` block when
a dashboard is asked for, plain text otherwise), followed by Retainer's own
rules:

- Answer with a dashboard only when one is asked for or clearly fits
  ("a breakdown", "a report I'll come back to"). Answer everything else in
  plain text.
- Learn the object and field names with `describe_schema`, try the queries
  with `aggregate_records` and `query_records`, and call `check_dashboard`
  on the finished program before answering (§5.3).
- Never copy numbers into a program; every number comes from a `Query`.
- Name fields only inside a `Query`, and give every result an alias (§4.1).
- To chart a total per option, aggregate it in the grouped query and chart
  `data.groups.<alias>`. Never one `Query` per option, and never type the
  options in: an option added later must still appear. (The spike's first
  eval run did exactly that; this rule fixed it.)

A chat that never asks for a dashboard never carries the guide's 4,000 or so
tokens. One that does pays one extra step the first time.

**Web chats only.** Only the web app can show a dashboard, so only the agent
in a web chat is told about the guide. `POST /v1/agent/chats` takes the
chat's `client`: the web app sends `web`, the terminal client `cli`, and a
task is `task`. The field says where the chat is shown, not which features
it has, so later features can use it too. It is stored on the session,
since the first message is built when the first turn starts. In a web chat,
the server adds
one line to the chat context it puts in the first message (`agent.md`
§6.6): "This chat is in Retainer's web app, which can show dashboards;
read get_guide("dashboards") before writing one." The
base prompt stays the same for every chat, so its cache is shared. An agent
connected over MCP can read the guide too, but its client won't draw the
result; the guide's description says so.

### 5.2 Edits

The prompt uses OpenUI's edit mode: to change a dashboard, the agent writes
only the statements that changed. The chat merges them into the dashboard
before them with `mergeStatements`: a statement with the same name replaces
the old one, a new name is added, and anything no longer reachable from the
root is dropped. In the spike's eval, "show the amount per stage and add won
revenue" came back as a 4-line patch.

"The dashboard before" is the last program earlier in the chat, written by
the agent or pasted by the person (§8.3).

### 5.3 New read tools

Two tools join the agent's `retainer.read` group and the MCP server, keeping
the rule that the agent's Retainer tools match the MCP tools (`agent.md`
§8.1). `aggregate_records` serves every agent, not only dashboards. A chat
pins its tools when it is created (`agent.md` §8.3), so chats that exist
before this ships don't have the two tools. That is fine: the line that
tells the agent about dashboards also goes only into a new chat's first
message.

**`aggregate_records`** matches `POST /v1/objects/:object/aggregate`, with
the additions in §7 and an optional `as` on each aggregate, echoed on its
value, a `label` on each group and `tooManyGroups` (§7). The response keeps
the API's shape, lists of values, which views and Routines already read.
The agent can read records today but cannot run an aggregate, so in
the spike it guessed at its grouped queries and said so ("the filter format
is a guess"). Any agent gets it, which is useful beyond dashboards ("how
many open deals are over $50k?"). Its output is the API's; the plain form
of §4.3 is a display concern of the browser tools.

**`check_dashboard`** takes a program and returns its problems, as Twenty's
`create_complete_dashboard` returns `widgetErrors` for the agent to repair
(§13). It runs the save check (§6.3), then runs each query as the browser
would, `fields` and aliases included, with the person's access, and reports
failed queries and empty record pages. A successful aggregate may return zero.
The checker evaluates data-backed metric values with the browser's result
formatting and reports counts over partial record pages and filters that
compare a stored select value with a display label:
`{ ok, problems: [{ statement, message }], queries: [{ statement, rows }] }`.
It saves nothing. The guide asks the agent to call it before answering and
to fix what it reports, so a person rarely sees a broken tile.

No tool saves, lists or opens a dashboard: the person saves (§2), and the
person opens a saved one in a chat (§8.3).

## 6. Storage and API

### 6.1 The table

| Table        | Holds                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboards` | Name, `program` (text, at most 20 KB), `visibility` (`workspace`, `private`), `position`, `chat_id` (the chat it was last saved from, nullable), actors, timestamps |

`chat_id` is a foreign key to the agent's sessions with
`on delete set null`. A chat belongs to one person (`agent_sessions.owner`),
and a dashboard may be shared with the workspace, so `chat_id` is only ever
shown to, and used by, the chat's owner (§6.2, §8.3).

A dashboard is display settings, like a view (`ARCHITECTURE.md` §1.4): no
provenance, no assertions, not through the schema engine, and saving one
never changes a record. It is not a view because a view belongs to one
object, and a dashboard reads from several.

### 6.2 Routes

| Route                       | Scope   | Does                                                                    |
| --------------------------- | ------- | ----------------------------------------------------------------------- |
| `GET /v1/dashboards`        | `read`  | The dashboards the caller can see, in order, without programs           |
| `POST /v1/dashboards`       | `write` | Save one: `{ name, program, visibility, chatId? }`                      |
| `GET /v1/dashboards/:id`    | `read`  | One dashboard with its program and its `issues` (§6.4)                  |
| `PATCH /v1/dashboards/:id`  | `write` | Change name, program, visibility or position; takes `expectedUpdatedAt` |
| `DELETE /v1/dashboards/:id` | `write` | Delete it                                                               |

Visibility follows views: a `workspace` dashboard is visible to everyone in
the workspace and editable by anyone with `write`; a `private` one exists
only for the actor that created it (404 to anyone else). Only the creator
changes visibility. A new dashboard is `private`; **Share with workspace**
makes it `workspace`.

`PATCH` with a stale `expectedUpdatedAt` returns `409`, so two people saving
over each other's edit find out.

`chatId`, on save, must be an open chat the caller owns, or the save is
refused with `422`. A read returns `chatId` only to the chat's owner, and
`null` to everyone else. `GET /v1/dashboards?chatId=` lists the dashboards
saved from one of the caller's chats, which is how a chat knows what
**Update** would change (§8.1).

Callers are admitted as for views.

### 6.3 Checked on save

The API parses the program with `lang-core` and refuses it with `422
invalid_dashboard`, listing every problem, when:

- it does not parse, has no `Dashboard` root, or uses a component or prop
  outside §4.2;
- it uses a name it never defines;
- it calls `Mutation`, or a `Query` tool other than the two data tools;
- a `Query`'s arguments are not plain values, or a table column's key is
  neither `id`, `label` nor an alias the query behind its rows defines;
- an aggregate has no `as`, or an alias is not a plain identifier, repeats
  within its query, or is `id`, `label`, `value` or `total`;
- a `refresh` interval is under 60 seconds;
- it has more than 20 queries, or is over 20 KB.

It also refuses an unknown object or field and applies the records API's
schema-aware rules for filters, sorting, aggregate operations, grouping and
date granularity. These checks compile the query without fetching records.
A field removed after saving does not stop a dashboard from loading (§6.4).

### 6.4 Fields by key, as views

A view stores field keys, so renaming a field never breaks it
(`ARCHITECTURE.md` §1.4 rule 1). A dashboard does the same:

- **Stored by key.** On save, the API rewrites each `Query`'s arguments:
  the object's name becomes its ID, and every field name (in `filter` keys,
  `sort`, `groupBy`, `aggregates` and `fields`) becomes its `fields.key`.
  Built-in names have no key and are stored as written: the object
  `event`, and the columns `id`, `createdAt`, `updatedAt` and an event's
  `occurredAt`, `channel` and `externalId`. The rest of the program is
  stored as written.
- **Read by name.** On read, the API rewrites them back to the current
  names, so the web app, the agent and anyone reading the API see names
  only. Option values stay as stored, as views keep them.
- **Possible because of §4.1.** Field names appear only in a `Query`'s
  arguments, and those are plain values. The API parses each `Query`
  statement with `lang-core`, translates its arguments as JSON, and prints
  the statement back. The aliases outside (`pipeline`, `amount`) never name
  a field, so a rename leaves them alone. The spike's programs broke this
  rule (they read `sum_amount` and used field names as table keys), which
  is why §4 changed.

A renamed field or object therefore changes nothing a person sees. A
**removed** field or option is different, as for views: the stored key
names nothing. `GET /v1/dashboards/:id` lists it in `issues` ("deal has no
field amount any more"), the tile whose query uses it shows a plain note
("This part uses a field that was removed"), and the dashboard offers **Fix
with the agent**, which opens it in a chat with the issues in the message
(§8.3). Recreating a field with the same name does not restore the original
reference. A schema change that makes a saved query invalid, such as turning
off filtering for its sort field, also produces a tile issue without
rewriting the saved program. A runtime failure, such as a viewer lacking
read access, shows the API's error in the tile.

### 6.5 Deletion and privacy

Deleting a dashboard removes its row. Deleting a chat clears `chat_id` on
dashboards saved from it, through the foreign key. A program holds no record values (§5.1), so
erasing a person (`forget`) has nothing to remove from dashboards. A title
the agent wrote may name a company or a person, as a view's name may, and is
left as it is.

## 7. Aggregates by date and relation

Bar and pie charts group by a `select` field, which the aggregate read
already does. Two more groupings make the common dashboards possible. Both
are part of the read path, deterministic, and useful to views and any agent,
not only to dashboards.

### 7.1 By date

`groupBy` may name a filterable `date` or `date_time` field, or a built-in
date: `createdAt`, `updatedAt`, or an event's `occurredAt`. "Deals created
per month" and "meetings per week" are the commonest charts over time, and
both use a built-in date. It takes `granularity`: `day`, `week`, `month`,
`quarter` or `year` (`month` by default). Groups are periods in the
workspace's time zone (`settings.timeZone`, UTC when unset), oldest first,
labelled "Nov 2026", "Q4 2026" and so on. Periods with no records between
the first and the last are filled in with zero, so a line chart has no gaps.
Weeks start on Monday.

### 7.2 By relation

`groupBy` may name a filterable single relation (`many_to_one`). Groups are
the related records, labelled with their labels, largest total first.
Collection relations (`many_to_many`) and inverse relations cannot group:
one record would count in several groups.

### 7.3 Many groups

Date and relation groupings return at most 50 groups by default (`limit`,
at most 200, so that a chart can show a quarter by day); a select grouping
returns all its options unless `limit` is set. Past the limit, the response sets
`tooManyGroups: true` and the tile says how many it shows. Which groups
stay depends on the grouping: for options and relations, the largest; for
dates, the latest periods, still shown oldest first, since a chart over
time that drops its newest months would mislead. Records with no value
group under `value: null`, labelled "No value". A pie chart keeps its six
largest slices and folds the rest into "Other" in the browser.

## 8. The web app

### 8.1 In the chat

An answer with an `openui-lang` fence shows its prose as Markdown and the
dashboard in place, drawn as it streams. Under a finished dashboard:

- **Pin to Dashboards** saves it, named by its `Dashboard` title, with this
  chat as `chat_id`. It becomes **Saved** with a link to it.
- In a chat a dashboard was saved from, a later version offers **Update
  "Deals"** and **Save as new**. Update changes the dashboard most recently
  saved from this chat, and names it on the button. When the new version's
  title differs from that dashboard's name, the person has probably asked
  for a different dashboard, so **Pin to Dashboards** is the main button
  and Update the second one.

Views and Routines are meant to be made in the chat the same way (§2), so
three parts are built for more than dashboards:

1. **Chat blocks.** The chat keeps a small map from a fence's language to
   a component that draws it, loaded only when an answer has such a fence.
   `openui-lang` is its first entry. A fence in a language the map lacks
   shows as code, as today.
2. **The draft card.** The frame around a draft is its own component: the
   live content, the note for a part that could not be shown, and the row
   of buttons under it. The dashboard renderer is what goes inside the
   frame, and knows nothing about saving.
3. **The keep buttons.** The card takes its buttons from the feature that
   owns the block. Dashboards gives it Pin, Update and Save as new. A view
   would give it Save, and a routine Propose.

Nothing else is made general ahead of need: no shared "draft" type on the
server, and no entry that opens the chat from another page.

A part that cannot be shown (a parse error, a failed query) shows a short
note in its place, with the details folded away. The renderer and the
language load only when an answer has a dashboard: about 37 KB gzipped in
the spike, outside the main bundle.

### 8.2 Dashboards — `/app/dashboards`

An item in the sidebar's top group, after Chat, shown when the agent is
available. The page lists the dashboards the person can see, each opening at
`/app/dashboards/:id`, which shows the dashboard full width with its name,
who made it, **Edit with the agent**, **Share with workspace** or **Make
private**, **Rename** and **Delete**. Empty state: "No dashboards yet. Ask
the agent for one, such as 'deals by stage this quarter', then pin it."

Opening a dashboard runs its queries; there is no model call and no wait for
the agent. A dashboard keeps showing its last numbers while it refreshes.

### 8.3 Editing a saved dashboard

**Edit with the agent** opens the chat in `chat_id` when the viewer owns
that chat and it is still open, scrolled to the end. Otherwise it starts a
new chat whose first message, written by the web app, carries the program
in a fence ("Change my dashboard 'Deals'") and any `issues`. That is the
usual path for a shared dashboard: a chat belongs to one person, so
everyone but the person who last saved it gets a new chat, and nobody
reads another person's chat. The agent's next answer patches that program
(§5.2), and **Update "Deals"** saves it. The dashboard's `chat_id` is set
to the saver's chat on every save.

### 8.4 Charts

Charts use shadcn/ui's chart components on Recharts 3 (MIT; React 19
supported), copied in with their notice as `FRONTEND.md` §2 allows for
shadcn/ui, and styled with the app's theme tokens in light and dark. Bars
are horizontal when labels are long. Every chart has a text alternative: the
same numbers as a table, one click away, and read by screen readers.

The spike drew bars as plain HTML; that stays the fallback while the chart
chunk loads.

## 9. Security and limits

- **Read-only by construction.** The browser's tool provider holds two read
  functions and nothing else. The language's `Mutation` and actions have
  nothing to call, and the save check refuses them anyway.
- **The viewer's access.** Queries run with the viewer's session or key.
  A shared dashboard shows each viewer only what that viewer can read, and a
  query the viewer cannot run fails in its tile.
- **No code.** Programs are data. The renderer evaluates expressions
  without `eval`; text from records and from the agent renders as text.
- **Nothing leaves Retainer.** No Thesys key or gateway. OpenUI's devtools
  widget, which mounts in development builds and links to Thesys's console,
  is switched off with its global flag; production builds drop it.
- **Load.** At most 20 queries a dashboard, refresh at most once a minute,
  and each query is an ordinary API read under the usual rate limits.
- **Restricted mode.** Opening a dashboard only reads, so the two `GET`
  routes and the `aggregate_records` tool join the paths restricted mode
  admits (`api/restricted.ts`), beside the view and aggregate reads it
  admits today. Saving is refused there, as every write is.

| Limit                    | Value               |
| ------------------------ | ------------------- |
| Program size             | 20 KB               |
| Queries per dashboard    | 20                  |
| Refresh interval         | ≥ 60 s              |
| Rows per `query_records` | 200                 |
| Rows shown in a `Table`  | 100                 |
| Groups per aggregate     | 50, at most 200     |
| Pie slices               | 7                   |

## 10. Delivery

One PR, in line with landing a feature whole. Dashboards is a core
feature, kept in its own folders so that it reads as one thing and can be
taken out in one PR:

1. **Useful beyond dashboards**: `aggregate_records` as an MCP tool and in
   the agent's read tools (`packages/agent`), date and relation grouping
   (§7), `client` on chat creation (§5.1), and in the web app the chat
   blocks and the draft card (§8.1).
2. **shared** (`packages/shared/src/dashboards/`): the component list and
   the data tool descriptions.
3. **server**: the `dashboards` table in `db/schema.ts`; a `dashboards`
   folder beside `views`, in the same layer, with the save and read checks
   and the name-and-key translation; the routes in `api/routes/`; the
   `dashboards` guide and `check_dashboard` with the MCP tools; the chat
   context line in the agent's session code.
4. **web** (`packages/web/src/routes/dashboards/`): the `openui-lang`
   chat block and its keep buttons, the Dashboards screens, the chart
   components.

It is large mostly in the web app. Splitting the first part into its own PR
is the one split that would make sense, since it stands on its own; the
rest only works together.

The hosted service needs no infrastructure change: a migration, new routes,
a new agent tool and web assets all ship with the normal deploy.
Dashboards adds `@openuidev/lang-core` to the server, and
`@openuidev/react-lang` and Recharts to the web app. The chart components
copied from shadcn/ui get their notice in `packages/web/THIRD_PARTY.md`,
which lists copied source; plain dependencies need none.

### 10.1 Acceptance tests

- **Unit**: the component list builds the same library on both sides; the
  data tools make values plain (money keeps its currency, options and
  relations become labels); patches merge; the save check refuses each case
  in §6.3; a program stored by key and read by name comes back unchanged;
  a renamed field or object reads under its new name and the dashboard
  still renders; a removed field is listed in `issues`; built-in names
  pass through the translation unchanged; the browser's tools key results
  by alias; a block in an unknown language shows as code.
- **Integration (Postgres)**: dashboard routes with visibility, `409` on a
  stale save, `chat_id` cleared when the chat is deleted; a save with
  another person's chat is refused, and a shared dashboard's `chatId` reads
  as `null` to everyone but the chat's owner; date grouping with gap
  filling and time zones, by a field and by `createdAt` and `occurredAt`;
  relation grouping with labels; the group limit, keeping the largest
  groups and, for dates, the latest periods; the dashboard reads in
  restricted mode; invalid query options are rejected by both dashboard
  saves and direct queries; schema drift is reported per query without
  rebinding removed fields or writing back to the saved program;
  `aggregate_records` and `check_dashboard` over MCP and
  as agent tools with the person's access; a web chat's first message
  names the guide and a terminal chat's does not.
- **End to end (Playwright)**: with a stubbed agent stream, a chat answer
  renders a dashboard; Pin saves it; the Dashboards page shows it with live
  numbers; a record change shows after reload; a viewer without access to
  an object sees that tile's error and the rest of the dashboard; a second
  person opening **Edit with the agent** on a shared dashboard gets a new
  chat that starts from its program.
- **Model eval (manual)**: `packages/server/scripts/dashboard-eval.ts`, from
  the spike, runs the agent's model over a fake workspace and checks every
  program it writes. Update it to read the guide and answer
  `check_dashboard`, and run it when the guide changes. It costs a few
  cents.

## 11. The spike

Branch `spike/dashboards`, 2026-11-26:

- **Eval.** Sonnet 5.5 with the production thinking settings, six turns:
  deals by stage, an edit, open tasks, companies by industry, a Q4 date
  range, and a plain question. 6 of 6 passed (programs parse, use real
  object and field names, call only the data tools; the plain question got
  plain text). Each turn took 3 to 9 seconds and 1 to 4 requests. The edit
  came back as a 4-line patch.
- **In the app.** A demo workspace from the sales template, 20 deals. The
  chat built a dashboard whose numbers matched the data (12 open deals,
  $891,000 open pipeline, $340,000 won); pinned, it rendered again from the
  saved program with no agent call.
- **What it found**: one query per option instead of a grouped query (fixed
  by a prompt rule, §5.1); table money shown without a currency (§4.3 now
  keeps currency with the value); raw option values as labels (§4.3); the
  agent hedging because it could not run aggregates (§5.3).

What the spike skipped, and this spec adds: storage in Postgres (it used
local storage), line, stacked and pie charts, date and relation grouping,
web-only chats, the guide read on demand (the spike pinned the instructions
as a second system block), `check_dashboard`, storing by key, the save check
on the server, issues on read, editing a saved dashboard.

## 12. Open questions

1. **Who can save.** Saving needs `write`, as views do, so a `viewer` cannot
   pin a dashboard, even a private one. Recommended: keep it; revisit if
   viewers ask.
2. **Filters.** OpenUI Lang supports `$variables` bound to inputs, so a
   dashboard could have a date-range or owner picker. Recommended: later,
   once dashboards are used; it needs input components and a rule for
   which queries a filter applies to.
3. **Layout.** Tiles flow top to bottom in rows. A drag-and-resize grid
   (Twenty uses a 12-column grid) is left for later; the agent can reorder
   tiles on request today.
4. **Chart library.** Decided by the build: shadcn/ui charts on Recharts 3
   (§8.4).
5. **Relative dates.** A pinned "deals this quarter" stores fixed dates and
   goes stale; so does a saved view. The query filter needs relative ranges
   ("this quarter", "last 30 days") resolved when the query runs, in the
   workspace's time zone. It belongs in the shared query layer, so views and
   dashboards get it together; the views spec takes it up.

## 13. Prior art

- **OpenUI** (Thesys, MIT): the language, the parser and the React renderer
  are used as they are. Its hosted Dashboards product shaped §6 and §8
  (create, edit as patch, versions, share) without being used.
- **Twenty** (AGPL; concepts only, no code, per `FRONTEND.md` §2): grouping
  by date with granularities and gap filling, grouping by relation with
  labels, a cap on groups with a "too many groups" flag, "No value" for
  empty groups, and AI tools that create a dashboard from object and field
  names: `create_complete_dashboard`, which returns `widgetErrors` for the
  agent to repair (the model for `check_dashboard`), and a
  "dashboard-building" skill its agent loads only for build requests (the
  model for the guide, §5.1). Twenty stores dashboards as structured widget settings in a page
  layout with a 12-column grid, and does not handle mixed currencies (it
  sums `amountMicros` across currencies); Retainer refuses to.
  `twenty-server/src/modules/dashboard/` and
  `twenty-front/src/modules/page-layout/` are the places to read.
- **json-render** (Vercel Labs, Apache-2.0): the same idea with JSON; the
  fallback (§2).
