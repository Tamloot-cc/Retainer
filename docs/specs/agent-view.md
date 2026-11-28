# Agent view: spec

Status: **implemented**, 2026-11-28. Experimental: it ships
behind the same account-menu control as Developer view and changes nothing
for people who leave it off.

This spec amends:

- `FRONTEND.md` §5.3a (the account menu and the sidebar), §5.4 (a new record
  tab), §5.8 (Developer view becomes one of three levels) and §9.1 (one new
  route).
- `conversations-and-activity.md` §5.7 (decision D8: the switch has three
  levels).
- `docs/rest-api.md` (the new route).
- `ARCHITECTURE.md` §6.2 (guides and the connection instructions are also
  served over REST, read only).

The write rules, the actor types and what agents receive do not change.
Agent view changes what the web app displays, never what is sent.

## 1. The idea on one page

Retainer is used by agents; the web app is for the people they work for.
Today a person cannot see what an agent reads when it works in their
workspace: the instructions it gets on connecting, the description of each
field, or the pack of values, facts and events it gets for one record. When
an agent writes something odd, the reason is usually in one of those.

Agent view shows them. It is the third level of the Developer view control:

| Level     | Shows                                                              |
| --------- | ------------------------------------------------------------------ |
| Off       | The app as people read it.                                         |
| Developer | API names, IDs, write paths and the JSON tab, as today.            |
| Agent     | Everything in Developer, plus what Retainer tells agents (§4–§6).  |

The levels nest, because an agent works with the same API names and IDs
that Developer view shows.

## 2. Decided

| #  | Decision                                                                                                                                  |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A1 | One control with three levels (Off, Developer, Agent), not a second switch. Each level only adds to the one before.                       |
| A2 | Agent view shows what **Retainer sends to agents**. It never claims to show what an agent sees: the agent's own prompt and other tools are unknown to Retainer. |
| A3 | A record gets an **Agent context** tab: the `get_context` result for that record, with what was left out.                                 |
| A4 | Field and object descriptions appear beside the labels they describe.                                                                     |
| A5 | A page, **What agents are told**, holds everything that is not about one record: instructions, memory, schema, tools and guides.          |
| A6 | Everything shown comes from the same source the agent gets it from, so the page cannot drift from the truth.                              |
| A7 | Read only. Agent view adds no way to edit instructions, guides or tool descriptions.                                                      |

## 3. The control

The account menu's **Developer view** switch becomes a three-way control
labelled **View**, with **Standard**, **Developer** and **Agent**.

- Remembered per browser in `localStorage` under `retainer:view-level:v1`,
  holding `off`, `developer` or `agent`. The old key
  `retainer:developer-view:v1` is no longer read. Refused storage leaves the
  level at Standard, and the control still works for the visit.
- Available to every actor, as today.
- `useDeveloper()` stays and is true at Developer and Agent. A new
  `useAgentView()` is true at Agent only. Nothing else in the app reads the
  level directly.

## 4. Descriptions beside labels

At Agent level, a field's description shows wherever its API name shows in
Developer view:

- On a record and an event: under the field's label, in muted text.
- In the create form: under the field's label.
- In list column headers and the filter and sort menus: in the tooltip of
  the API name, since there is no room for a line.
- On an object's list: the object's description under the list title.

A field with no description shows nothing here. §6.4 lists those in one
place.

## 5. The Agent context tab

A record page, and the side sheet, get an **Agent context** tab after JSON
(`?tab=context`; below Agent level the address falls back to the first tab).
Entity records only; see §9 for events.

It calls `GET /v1/records/:id/context`, the route behind `get_context`, and
shows the result in the order the agent receives it.

**Header.** One line: "What an agent gets when it reads this record",
the size ("about 1,922 of 2,000 tokens") and what was left out ("Left out:
1 event"). A budget picker offers 2,000 (the default an agent gets), 8,000
and 16,000 and refetches.

**Values.** One row per field the pack holds: API name, value as stored
(`ai_native`, not "AI-native"), who wrote it and when it was observed.
Fields with no value are absent from the pack, so the section ends with a
count: "15 fields have no value and are not sent".

**Linked records.** Grouped by object with the total for each group, each
item with its select values and the relation field that connects it.

**Facts.** Each fact with its date and its source event's title.

**Recent events.** Newest first: date, type, title, how it is attached
(`via`), and the summary clamped with "Show more".

**Left out.** When `omitted` is above zero for a section, that section ends
with a line saying how many did not fit, and a link that raises the budget.

**Raw.** A "Show raw" toggle swaps the sections for the JSON as returned,
with a copy button.

The tab is fetched with the person's own session. With whole-workspace
access, an agent's call for the same record returns the same pack.

An example, the Attio company in a research workspace at the default
budget: 6 values (15 enrichment fields empty and not sent), 2 people and 1
market linked, 4 facts, 4 events shown and 1 left out because one long
summary took most of the room.

## 6. The "What agents are told" page

`/app/briefing`. At Agent level the sidebar's setup group shows
**Agent briefing** after Schema. The address works at any level.

The page is one readable column with a section list at the side. It opens
with one paragraph:

> This is what Retainer gives an agent that connects to this workspace. The
> agent also has its own instructions and tools from the app it runs in;
> Retainer cannot see those.

### 6.1 Connection instructions

The text every agent gets when it connects, in full, as plain text.

### 6.2 Memory read at the start

What `get_context("workspace")` returns at the default budget, and, when
the schema's `memory` built-in lists `me`, what `get_context("me")` returns:
each fact, who wrote it and when, and how many were left out. A link goes to
Settings → Memory, where facts are removed. Nothing is removed here.

### 6.3 Schema as the agent reads it

From `GET /v1/schema`, the route behind `describe_schema`. Per object: API
name, class, description, then its fields as a table: API name, type,
options, and description. Then the built-ins (facts, comments, memory) with
their descriptions, and the value formats ("money: `{ amountMicros,
currency }`, 12.50 is `12500000`").

This is the Schema page's content with descriptions in front and the
diagram and editing left out. Each object and field links to its place on
the Schema page.

### 6.4 Missing descriptions

A list of objects and fields that have no description, grouped by object,
with a count in the section title. Inverse relation fields are left out,
since they are read only and described by their other side. Each item links
to the field on the Schema page.

One line explains why it matters: "Without a description, an agent has only
the field's name to decide what belongs in it."

It is a list, not a warning: a field called Name needs no description, and
the page does not guess which ones do.

### 6.5 Tools

Every tool the server offers: name, description in full, and its inputs
(name, type, whether required, and the input's own description). Collapsed
to name and first sentence; a row opens in place.

### 6.6 Guides

The guides `get_guide` serves: name, the one-line description the agent
sees when choosing, and the guide in full as rendered Markdown, collapsed
by default.

## 7. Server

One new route. Everything else on the page and the tab uses routes that
exist (`GET /v1/schema`, `GET /v1/records/:id/context`).

`GET /v1/agent-briefing`, scope `read`:

```json
{
  "instructions": "Retainer is the memory of a CRM workspace…",
  "tools": [
    {
      "name": "get_context",
      "description": "Returns what Retainer knows about one record…",
      "inputSchema": { "type": "object", "properties": { "…": {} } }
    }
  ],
  "guides": [
    {
      "name": "memory",
      "description": "What to remember in workspace…",
      "markdown": "# …"
    }
  ]
}
```

- `instructions` is the `INSTRUCTIONS` constant the MCP server is built
  with.
- `tools` is the answer to `tools/list` on an MCP server built for the
  caller, the way the workspace agent's tool host builds one
  (`mcp/agent-tools.ts`). A tool that the deployment turns off, such as the
  Routines tools, is absent here exactly when it is absent for agents.
- `guides` comes from `GUIDES`.

The route lives in the API layer and reads from `mcp/`, the same direction
`agent-tools.ts` is already used in. The SDK gets `agentBriefing()`. The web
app reads it through the SDK; no server code enters the MIT packages.

The answer changes only with a deploy, so the web app caches it for the
session.

## 8. Delivery

One PR.

| Layer       | Tests                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit        | The three levels and their storage, including refused storage; which tabs a record has at each level; the context tab's sections, counts and left-out lines from a fixed pack; the missing-descriptions list from a fixed schema. |
| Integration | `GET /v1/agent-briefing` returns the same tool names and descriptions as `tools/list` for the same caller, the instructions the MCP server announces, and every guide `get_guide` serves; it refuses a caller without `read`. |
| Playwright  | Choose Agent in the account menu; a field description appears on a record; the Agent context tab shows a seeded fact and a left-out line at a small budget; the briefing page lists a seeded field under missing descriptions. |

## 9. Not in v1

- **Events.** The Agent context tab is for entity records. Agents read one
  event with `get_record` and `get_event_content`; an event page can get its
  own tab once there is a need.
- **The workspace agent's own prompt.** The built-in chat agent has a base
  prompt on top of what this page shows (`agent.md` §3.5). The page covers
  what every agent gets; the built-in agent's extra prompt can be a later
  section.
- **What an agent read in one run.** The chat already shows each tool call
  in its trace. Tying a write back to the context the agent had at that
  moment is a larger feature.
- **Search as the agent sees it.** `search` results and their ranking are
  not shown.
- **Editing.** Descriptions are still changed through the schema engine,
  from the Schema page or by an agent. Instructions, guides and tool
  descriptions are product text, changed in code.
