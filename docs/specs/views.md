# Views built by the agent: spec

Status: **decided**, 2026-11-28 (proposed 2026-11-27). Written after
Dashboards shipped (#212), so it builds on the chat pieces that work made to share: chat blocks, the
draft card, guides read on demand and a check before answering
([dashboards.md](dashboards.md) §5, §8.1). The pattern it shares with
dashboards and Routines is [chat-builds.md](chat-builds.md).

This spec amends:

- `ARCHITECTURE.md` §1.4 (its intro and new view settings; rules 2 to 4,
  and rule 6 for a board grouped by a relation), §5 (relative dates in
  filters) and §6.2 (new MCP tools and a guide).
- `agent.md` §6.6 (the web chat's first message names the views guide) and
  §8.1 (new read tools).
- `FRONTEND.md` §5.3b (grouped tables, the settings summary, drafts).
- `docs/rest-api.md` (new view keys, the view check route,
  `expectedUpdatedAt` on a view update, `view` on query and aggregate).
- `routines.md` (relative dates in trigger filters; the guide note of §8).
- `dashboards.md` §12 question 5, which §4.3 settles.

The write rules, the actor types and the rule that Retainer's core never
calls a model do not change. The agent drafts a view; the person saves it.

## 1. The idea on one page

A person asks the agent in the chat: "show me open deals grouped by
company, biggest first, closing this quarter". The agent answers with a sentence and
a draft view: its name, one line on what it is for, its settings in plain
words, how many deals match, and the first few groups. **Open** shows the
real table with the draft applied. **Save view** keeps it. "Only the ones
over $20k" changes the draft in place.

Views get richer settings than the toolbar can set today: group by on a
table, grouping by a relation or a date, relative dates, OR filters and a
saved search. The agent is how people set them. The toolbar keeps the
controls it has; this spec adds no builder for the rest (§2).

Views also become something agents read. A view is the team's definition
of a set of records ("Hot leads", "Renewals this quarter"). An agent asked
to "go through my hot leads" finds that view and runs it, rather than
guessing what hot means. Each view carries a description of its purpose
for that (§4).

## 2. Decided

Decided with the product owner on 2026-11-27:

- **The agent builds views; no builder UI for the new settings.** The
  toolbar's filter, sort, columns and layout controls stay as they are.
  New settings are set through the agent.
- **Every setting is visible in plain words**, even one only the agent can
  set, and a person can remove it without the agent (§6.2). People must be
  able to see why a record is missing.
- **Views serve people and agents.** Agents list, read and run views
  (§5.3).
- **The agent writes, the person saves**, as for dashboards
  (dashboards.md §2).
- **Write this after Dashboards merged**, on its real chat pieces.

Decided in this document: everything below. §11 lists the questions
settled after review.

Considered and not taken:

- **Views as OpenUI Lang programs**, like dashboards. A view's settings are
  already a small structured object that `views/service.ts` validates and
  repairs when the schema changes. A program would give the agent nothing
  a view can use and lose the repair.
- **A builder UI for each new setting**, as Twenty has (group-by menus,
  group order, hide empty groups). Each setting would need its own control
  and the toolbar would grow. The agent sets them, and the summary shows
  and removes them.
- **A separate `query_view` tool.** `query_records` and
  `aggregate_records` take `view` instead (§5.3): MCP tools are generic,
  not one per thing (`ARCHITECTURE.md` §6.2).

## 3. Prior art: Twenty

Twenty (AGPL; concepts only, no code, per `FRONTEND.md` §2) was read at
`../twenty` on 2026-11-27. What its views can do, and what this spec takes:

| Twenty                                           | Here                                         |
| ------------------------------------------------ | -------------------------------------------- |
| Group a table into sections, or tabs             | Sections (§4.2); tabs not taken              |
| Group by a select or a many-to-one relation      | Both, plus dates (§4.2)                      |
| Group order: manual, A to Z, Z to A              | Default, A to Z, Z to A; manual not taken    |
| Hide empty groups, hide chosen groups            | Both (§4.2)                                  |
| A load limit per group, then "load more"         | 25 per section, Show more (§6.1)             |
| Nested AND / OR / NOT filter groups              | The filter already nests; the summary (§6.2) |
| Relative dates ("is in past", "is relative")     | `within` (§4.3)                              |
| A search term saved in the view                  | `search` (§4.4)                              |
| Calendar by day, week or month, with an end date | Not taken (§11)                              |
| A List view type, record page field groups       | Not taken                                    |

Twenty's AI does not build views; its views are made in menus.

## 4. View settings

### 4.1 Description

A view gains `description`: plain text, at most 500 characters, saying what
the view is for ("Open deals over $20k closing this quarter, for the
weekly pipeline review"). The agent writes one with every draft. A person
can edit it in the view's Edit dialog. It is optional on the API, so a
view made in the toolbar still saves without one.

The description is for people and agents alike. An agent matches a
person's words to a view by its name and description, tells a real view
from a near copy, and can repair a view whose field was removed because it
still knows what the view meant.

### 4.2 Grouping

`groupBy` today means one thing: the select field whose options are a
board's columns. It now works on tables too, and takes more kinds of
field:

| Field                                                              | Table | Board |
| ------------------------------------------------------------------ | ----- | ----- |
| A filterable `select`                                              | Yes   | Yes   |
| A filterable single relation (`many_to_one`)                       | Yes   | Yes   |
| A filterable `date` or `date_time`                                 | Yes   | No    |
| A built-in date: `createdAt`, `updatedAt`, an event's `occurredAt` | Yes   | No    |

These are exactly the groupings the aggregate read takes since Dashboards
(dashboards.md §7), so each group's count and total come from the same
`POST /v1/objects/:object/aggregate` call a board makes today. A board
does not group by date: the calendar is the layout for dates.

New keys beside it, all optional:

| Key               | Holds                                                              |
| ----------------- | ------------------------------------------------------------------ |
| `granularity`     | With a date: `day`, `week`, `month` (default), `quarter` or `year` |
| `groupOrder`      | `default`, `asc` or `desc`                                         |
| `hideEmptyGroups` | With a select: `true` hides options with no records                |

`default` order is the grouping's own: option order for a select, most
records first for a relation, oldest first for dates (dashboards.md §7.3).
`asc` and `desc` order a select or a relation by group label, A to Z or
Z to A, and dates oldest or newest first. A relation is never ordered by
its `groupAggregate`: "biggest first" in the summary would promise that,
so the summary says "most records first".

A date grouping in a view shows only periods that have records. The
aggregate read fills empty periods with zero for charts; a table grouped
by day would otherwise be mostly empty sections.
`hiddenGroups` and `groupAggregate` keep their meaning and now apply to
tables as well. `hiddenGroups` holds option values, related record IDs or
period starts (`2026-10-01`), with `null` for "no value".

Groups follow the aggregate read's limits: date and relation groupings
show at most 50 groups, and which stay is the aggregate read's rule
(dashboards.md §7.3). A chart may drop the rest, but a view is a list
people work through, so no record may go missing. Past 50, a last group
holds every record the others do not: **Other** for a relation, **Earlier**
for dates (the 50 latest periods stay). Its condition is the view's filter
minus the shown groups, so it pages like any section. A card cannot be
dropped on a board's Other column.

A board grouped by a relation has a column per related record that has
records in the view, plus "No {field}". Dragging a card to another column
writes the relation, as dragging writes a select today (`ARCHITECTURE.md`
§1.4 rule 6). There is no empty column to drop on: to link a record to a
company no card has yet, edit the record.

### 4.3 Relative dates

A filter on a `date` or `date_time` field (or a built-in date) takes a new
operator, `within`, whose value is a period worked out when the query
runs:

```
{ closeDate: { within: "this_quarter" } }
{ createdAt: { within: { last: 30, unit: "day" } } }
{ dueDate:   { within: { next: 2, unit: "week" } } }
```

- **Named periods**: `today`, `yesterday`, `tomorrow`, and `this_`,
  `last_` or `next_` followed by `week`, `month`, `quarter` or `year`.
- **Rolling periods**: `{ last: n, unit }` or `{ next: n, unit }`, `n`
  from 1 to 1000, `unit` one of `day`, `week`, `month`. `last` ends now
  and `next` starts now. On a `date` field now is today, and today is
  inside both.
- **Time zone and weeks** as the aggregate read: the workspace's
  `settings.timeZone` (UTC when unset), weeks starting on Monday
  (dashboards.md §7.1).
- `not` around it gives "outside the period", as for any condition.

A period has two ends, so `within` cannot say "overdue" or "no update in
30 days". For those, `lt`, `lte`, `gt` and `gte` on the same fields take a
relative day in place of a date:

```
{ dueDate:   { lt: "today" } }
{ updatedAt: { lt: { ago: 30, unit: "day" } } }
{ closeDate: { gte: { ahead: 2, unit: "week" } } }
```

`today`, `yesterday` and `tomorrow`, or `{ ago: n, unit }` and
`{ ahead: n, unit }` with the same `n` and `unit` as a rolling period. It
resolves to a date in the workspace's time zone when the query runs, and
then compares as that date written out would.

Both are part of the query filter (`ARCHITECTURE.md` §5), not of views.
Everything that takes a filter takes them: queries, aggregates, saved views,
dashboard queries and routine triggers. A dashboard pinned as "deals this
quarter" stays this quarter (dashboards.md §12 question 5).

### 4.4 Saved search

A view gains `search`: keywords, at most 200 characters, passed as the
query's `search` (Postgres full-text over the object, as today). The
object page's search box shows it as the view's own, like the filter.

### 4.5 Filters

Nothing changes in the stored filter. It already nests `and`, `or` and
`not` (`records/query.ts`), and a view stores whatever a query takes. What
changes is how a filter the chips cannot show is shown (§6.2).

### 4.6 Checked on save, repaired on schema change

The checks of `ARCHITECTURE.md` §1.4 rule 3 extend to the new keys:
`groupBy` must be a field the table above allows for the view's kind,
`granularity` needs a date `groupBy`, and `hiddenGroups` values must fit
the grouping. A view that is not a board or a table may not set them.

Repair (rule 2) extends the same way: a removed or no longer filterable
relation or date field clears `groupBy`, `granularity`, `hiddenGroups` and
`groupAggregate`; a related record that is deleted leaves `hiddenGroups`.
A table left without its grouping shows its records ungrouped; it does not
ask for a field as a board does.

**A repair that widens a view leaves an issue.** Today the repair rewrites
the stored filter, and the next read shows an ordinary view with no sign
that a condition went. That mattered little while views were only looked
at. Now an agent runs "Hot leads" and a routine copies its filter, so a
view that silently grew is a real risk. When a schema change drops a
filter condition, the view's `issues` list it ("the filter on Score was
removed with the field") on every read until someone saves the view
again. The view still runs: `query_records` and `aggregate_records` with
`view` return those issues beside the result, and the guide tells the
agent to say so before acting on the records.

## 5. The agent

### 5.1 The views guide

`get_guide("views")`, beside `dashboards`. Its text says:

- **View, dashboard or plain answer.** A view is one object's records as a
  list, board or calendar that a person keeps and works through. A
  dashboard is numbers and charts across objects. A question ("how many
  open deals?") gets a plain answer.
- **Find before making.** Call `list_views` for the object first. If a view
  already does the job, open or edit it rather than making a near copy.
- **Learn the schema and try the query.** `describe_schema`, then
  `query_records` or `aggregate_records` with the draft's filter, then
  `check_view` on the finished draft before answering (§5.3).
- **Write a description** saying what the view is for.
- **Use relative dates** for anything about now: `within` for a period
  ("this quarter"), a relative day for an open end ("overdue" is
  `{ lt: "today" }`). A view with fixed dates goes stale.
- **Say so when a view has issues** (§4.6) before acting on its records.
- **Use stored option values** in filters, as the dashboards guide says.
- **The draft format** (§5.2).

**Web chats.** The line the server adds to a web chat's first message
(dashboards.md §5.1) names both guides: "This chat is in Retainer's web
app, which can show dashboards and views; read get_guide("dashboards") or
get_guide("views") before drafting one. For checked views, use a retainer-view fence." One line, so the base prompt and
its cache stay shared.

### 5.2 The draft

The agent answers with a `retainer-view` fence holding JSON:

```retainer-view
{
  "object": "deal",
  "name": "Open deals by company",
  "description": "Open deals closing this quarter, grouped by company, biggest first.",
  "kind": "table",
  "filter": { "and": [ { "stage": { "in": ["lead", "qualified", "proposal"] } },
                       { "closeDate": { "within": "this_quarter" } } ] },
  "sort": [ { "field": "amount", "direction": "desc" } ],
  "groupBy": "company",
  "groupAggregate": { "field": "amount", "op": "sum" }
}
```

It is a `POST /v1/objects/:object/views` body plus `object`, by field
names, without `visibility` and `position`: who sees a view and where it
sits are the person's to set, and the check refuses a draft that carries
either. To change a saved view, the draft names it and carries only the
changed keys, `null` to clear one, as a `PATCH` body does:

```retainer-view
{ "view": "0b5e…", "groupBy": "owner", "hiddenGroups": null }
```

- **A change to an earlier draft in the same chat is a whole new draft.**
  Drafts are short, so there is no merge step as dashboards have. An edit
  draft always carries every key that differs from the saved view, not
  from the draft before it, so it reads the same whether or not the
  person pressed Update in between.
- **A draft that names a view and changes nothing** shows that view, with
  Open and no save buttons. That is how the agent answers "open my hot
  leads" rather than making a near copy.

### 5.3 Tools

The agent's Retainer tools match the MCP tools (`agent.md` §8.1). All of
these join `retainer.read`:

- **`list_views(object?)`**: the views the caller can see, each with its ID,
  object, name, description, kind, settings by field name, who made it and
  when it last changed, and its `issues`. Private views come back only to
  their creator (§7).
- **`view` on `query_records` and `aggregate_records`**: runs a saved
  view. The object is the view's, so `object` is not needed.
  - The view's filter and search decide which records match. A `filter`
    given is combined with `and`; a `search` given must match as well.
  - Its sort applies unless `sort` is given.
  - With `aggregate_records`, the view's grouping and `groupAggregate`
    apply unless `groupBy` or `aggregates` is given.
  - `columns`, `hiddenGroups` and the other display settings do not
    change what comes back: a hidden group's records are still in the
    view.
  - The result carries the view's `issues` when it has any (§4.6).
- **`check_view(draft)`**: takes a draft (§5.2) and returns
  `{ ok, problems: [{ path, message }], count, groups? }`: the save check
  of §4.6 run without saving, then the view's query with the caller's
  access, giving the matching count and, when grouped, each group's label
  and count. It saves nothing. The web app calls the same check as
  `POST /v1/objects/:object/views/check` (§6.3).

No tool saves, edits or deletes a view: the person does (§6.3). An agent
on a REST key can still save views through the API, as today.

## 6. The web app

### 6.1 Grouped tables

A table with `groupBy` shows a section per group, in the view's group
order, each with a header: the group's label, its count, and the
`groupAggregate` if set. A section shows 25 rows, then **Show more**, and
can be collapsed (remembered for the session, not saved). Rows follow the
view's sort within each section. Column footers stay totals over the whole
view. Clicking a row opens the side sheet, as in an ungrouped table.

The groups and their counts come from one aggregate call; each section's
rows from a query with the group's condition added to the view's filter
(the same split a board uses, `FRONTEND.md` §5.3b). A section loads its
rows when it scrolls into view, so a table of 50 groups does not start 50
queries at once.

### 6.2 The settings summary

Under the toolbar, every view shows one line of its settings in plain
words, built from the view, not written by the agent:

> Grouped by Company · Sorted by Amount, largest first · Close date is this
> quarter · Stage is Lead, Qualified or Proposal · Matching "renewal"

- **Each part has a ×** that removes it from the screen as an unsaved
  change, like a filter chip today, so a person can always undo what the
  agent set without the agent. **Save view** keeps the change. In a
  filter, a part is one top-level condition: an `or` or `not` group is one
  part and goes whole.
- **Filters** that fit the chips stay chips. Anything else (an `or`, a
  `not`, `within`) shows as a sentence in the summary: "Stage is Lead or
  Owner is empty". The filter menu says "This view has a filter the menu
  can't edit" and offers **Edit with the agent**.
- **The description** shows under the view's name in the switcher and as
  the summary's tooltip.
- **Edit with the agent** on the view menu opens a new chat whose first
  message, written by the web app, carries the view as a `retainer-view`
  fence and any `issues` ("Change my view 'Hot leads'"), as for a
  dashboard (dashboards.md §8.3).

### 6.3 The draft in the chat

`retainer-view` joins the chat block map (`chat-blocks.tsx`). Inside the
draft card (`draft-card.tsx`):

- The name, the description, the settings summary (§6.2) and the count.
- A preview: the first five records, or the first five groups with their
  counts.
- **Open**: the object page with the draft applied as unsaved changes. The
  URL already carries a view's unsaved `filter` and `sort`; it gains
  `draft`, the rest of the draft's settings. The page shows **Save view**
  as for any change. Nothing is saved by opening.
- **Save view** for a new draft, or **Update "Hot leads"** and **Save as
  new** for a draft that names a view.
  - A new view, from the card or from Open, is always saved `private`,
    whatever the create route's default; the person shares it afterwards,
    as with a new dashboard. Update leaves the view's visibility alone.
  - For a draft that names a view, the card loads that view, shows the
    draft applied to it, and sends Update with the view's `updatedAt` as
    `expectedUpdatedAt`, as a dashboard does. If the view changed since,
    the update is refused (`409`) and the card shows the draft on the
    newer view before the person tries again. **Save as new** creates a
    view from the full settings the card shows.
- **The card checks the draft itself.** When it opens, it sends the draft
  to `POST /v1/objects/:object/views/check`, with the viewer's access:
  `check_view` as a route. A draft that passes gets its count and groups
  from the answer and its first five records from an ordinary query. A
  draft that fails shows its problems in place of the preview, and no
  Save or Open.

### 6.4 New view from the chat

2026-11-28, not built yet. The view bar gains **New view**, which opens a
new chat for the page's object (`/chat?new=view&object=<key>`). The chat
says how building a view works and offers one prompt: "Suggest a few views
of Companies I could keep." The views guide gains a **Suggesting** section:
three to five ideas grounded in the object's data, none a near copy of a
view `list_views` returns, and no draft until the person picks one.
Shared with dashboards and routines: `chat-builds.md` §5.2.

### 6.5 The Edit dialog

The existing dialog gains a **Description** box. It is the only new
control in this spec.

## 7. Private views and the agent

A private view exists only for the actor that created it
(`ARCHITECTURE.md` §1.4 rule 4). The chat agent acts as its own actor,
`agent:retainer-agent:<owner key>` (`agent-runtime/access.ts`), so today it
cannot see the private views of the person it works for, even while that
person asks it to use one.

Rule 4 gains one case: **a private view can also be read and run by an
agent acting for its creator.**

- **Who that is.** A caller whose `person` is the view's creator: the
  workspace agent in that person's chat, and an app the person connected
  over OAuth, such as Claude Code. In a chat started with an API key that
  works for no person, the caller has no `person`; the agent's owner is
  then the key, and it reads the private views that key's actor created.
- **Reading only.** The case applies to listing, reading and running a
  view. Updating, deleting and changing visibility keep today's rule: the
  creator alone. Today one loader serves all of these
  (`loadView` in `views/service.ts`), so the build gives reads their own
  visibility check rather than widening the shared one.
- A view the agent's draft saves is created by the person who pressed
  Save, so the person stays its owner.

## 8. Views and Routines

A routine runs on the records matching a filter (`routines.md`). A routine
built from a view **copies the view's filter when it is proposed** and does
not follow the view afterwards. Routines are approved after a dry run on
specific records; if a routine followed "Hot leads" live, widening that
view's filter would make the routine act on records nobody approved. The
routines guide says so, and the proposal shows the copied filter. `within`
in a copied filter still moves with time, which is the intent: "deals
closing this week" means this week on every run.

A schedule trigger takes a filter and no search. A view with a saved
`search` therefore cannot be copied whole: the filter alone would make the
routine act on records the view does not show. The routines guide tells
the agent not to copy such a view as it is. It tells the person, and
builds the routine only on a filter the person agrees says the same.

A view with `issues` (§4.6) is not copied either until the person has
looked at it.

A dashboard `Query` does not take `view` in v1 (§11).

## 9. Delivery

One PR, as features land whole:

1. **Query layer**: `within` and relative days in filters
   (`records/query.ts`, the shared filter types), for every reader at
   once.
2. **Views**: `description` as a column beside `name` (`db/schema.ts`,
   a schema migration); an upgrade migration for dormant grouping settings
   from older views; the new `config` keys in `views/service.ts` (`search`,
   `granularity`, `groupOrder`, `hideEmptyGroups`); the wider `groupBy`
   with its Other group, their checks and repair, the
   issue a widening repair leaves (§4.6), the check route,
   `expectedUpdatedAt` on update, and the private-view rule (§7).
3. **Agent and MCP**: `list_views`, `view` on the two reads, `check_view`,
   the `views` guide, the web chat line, the routines guide note.
4. **Web**: grouped tables, relation columns on boards, the settings
   summary, the `retainer-view` block with Open, Save and Update, `draft`
   on the object page, the description box.

The description is a column, not a `config` key. `config` holds how a
view looks and is what a schema change repairs; the name and description
say what the view is, and no repair should touch them. The migration
means a longer hosted deploy: Dashboards' took about 28 minutes, ten of
them with the API in maintenance.

### 9.1 Acceptance tests

- **Unit**: each named and rolling period, and each relative day, resolves
  to the right range in a given time zone, across a year end and a
  daylight-saving change; the settings summary words every filter shape,
  including nested `or` and `not`; a draft parses and turns into a create
  or patch body, and one carrying `visibility` is refused; group order
  (dates by time, not by label) and hidden groups apply.
- **Integration (Postgres)**:
  - `within` and relative days in queries, aggregates, saved views and
    routine triggers.
  - Each new key is checked on save, refused on the wrong kind, and
    repaired when its field, option or related record goes.
  - After a schema change drops a filter condition, the next read of the
    view, and a `query_records` with `view`, both carry the issue; saving
    the view clears it.
  - A table grouped by relation and by date pages each section; with more
    than 50 groups, every record is in a shown group or in Other.
  - `view` on both reads combines filter and search as stated, and
    returns a hidden group's records.
  - `check_view` and the check route save nothing and report the caller's
    count.
  - A view update with a stale `expectedUpdatedAt` is refused.
  - A private view: its creator's agent and connected app list, read and
    run it; they cannot update or delete it; a key-mode agent reads its
    own key's private views; no other agent or person sees it.
  - `list_views` over MCP and as an agent tool.
- **End to end (Playwright)**: with a stubbed agent stream, a draft renders
  with its summary and preview; a complete draft the check refuses shows
  its problems and no Save; an ungrouped draft previews five records; Open
  shows the draft on the object page unsaved; Save view keeps it as
  private, from the card and from Open; Update changes the named view; a × in the summary removes a
  setting and Save view stores that; a board card dragged to another
  company column writes the relation.
- **Model eval (manual)**: a `view-eval.ts` beside `dashboard-eval.ts`:
  drafts for a grouped table, a relative date, "overdue", an OR filter, an
  edit of an existing view, a request a dashboard fits better, and a plain
  question.

## 10. Limits

| Limit                       | Value               |
| --------------------------- | ------------------- |
| Description                 | 500 characters      |
| Saved search                | 200 characters      |
| Rolling period              | 1 to 1000 units     |
| Groups in a table or board  | 50, then Other      |
| Rows per section, then more | 25                  |
| Draft preview               | 5 records or groups |

## 11. Decided questions

Settled on 2026-11-28, each as recommended.

1. **"Me".** "My open deals" needs a filter on the viewing person, which
   needs a record to point at a person who signs in. That is a schema
   question for accounts. Decided: later.
2. **Dashboards over views.** A dashboard `Query` could take `view`, so a
   tile follows a team's definition. It ties a dashboard to a view a
   person can change or delete. Decided: later, once both are used.
3. **Calendar by week or day, and an end date.** Twenty has both.
   Decided: wait until someone asks.
4. **The agent saving views itself.** A view is display settings and easy
   to undo, so the agent could save a private view without asking.
   Decided: no, for one rule across views and dashboards.
5. **Manual group order.** Needs a stored position per group. Decided:
   no; `asc` and `desc` cover most needs.
