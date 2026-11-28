# Building in the chat: dashboards, views and Routines

Status: **decided**, 2026-11-27. A short shared design, not a build spec.
Each feature's own spec says how it does each step:
[dashboards.md](dashboards.md) (shipped), [views.md](views.md) (shipped)
and [routines.md](routines.md), built in the chat as
[routines-in-chat.md](routines-in-chat.md) says (shipped; §5.1 here).
Updated 2026-11-28: each feature page's **New** button opens a chat that
explains the steps and offers one suggestion prompt (§5.2). Shipped.

## 1. The pattern

People make three kinds of thing by describing them to the workspace agent.
Each goes through the same five steps:

1. **Describe.** The person says what they want, in the chat, in plain
   words.
2. **Draft.** The agent writes the thing, after reading the feature's guide
   and the schema.
3. **Check.** The agent runs the feature's check tool and fixes what it
   reports before answering.
4. **Preview.** The answer shows the draft live in a draft card: real data,
   with the viewer's access.
5. **Keep.** The person keeps it with a button on the card. What keeping
   means grows with the risk: a dashboard is pinned, a view is saved, a
   routine is proposed and then approved by an admin.

The agent never keeps anything itself. A change after keeping goes back
through the same steps: **Edit with the agent** opens a chat with the kept
thing in it.

## 2. Decided

With the product owner, 2026-11-27:

- **The chat is the only place to build.** No describe box on the object
  page, the Dashboards page or the Routines page. One place keeps the app
  simple.
- **Each feature page has a New button into the chat** (2026-11-28, §5.2).
  It opens a new chat that says how building works and offers one prompt
  that asks the agent for ideas. This replaces "a feature page may link to
  the chat, but it opens a plain chat": a plain chat left people at an
  empty box, not knowing what to ask for or what the agent could make
  from their data.
- **MCP comes later.** Agents connected over MCP (Claude Code, Claude's
  apps) will build the same things with the same guides and check tools,
  which are MCP tools already. What they lack is the preview and the keep
  button, since their clients cannot draw a draft card. That design is
  left for later (§6).
- **Routines are part of this design now**, though they move into the chat
  after Views (§5.1). The shared pieces must fit a routine's draft, its dry
  run and its stricter keep step, so that Views does not set habits
  Routines would have to break.
- **The consistency rules in §4.**

## 3. What each feature puts in each step

| Step       | Dashboards                                 | Views                                                      | Routines (in the chat, §5.1)                                                |
| ---------- | ------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Guide      | `get_guide("dashboards")`                  | `get_guide("views")`                                       | A new `get_guide("routines")`, with `get_routine_capabilities`              |
| Draft      | An `openui-lang` fence: the program        | A `retainer-view` fence: the view's settings as JSON       | A `retainer-routine` fence naming the checked source and its preview        |
| Check      | `check_dashboard`                          | `check_view`                                               | `validate_routine`, then `preview_routine`                                  |
| Preview    | The dashboard, drawn in the card           | Summary, count, first rows or groups; **Open** on the page | Retainer's facts, recent matches, the dry run and the builder's report      |
| Keep       | **Pin**, or **Update** and **Save as new** | **Save view**, or **Update** and **Save as new**           | **Propose**; an admin approves on the Routines page                         |
| Kept as    | A private dashboard                        | A private view                                             | A proposal; nothing runs until it is approved                               |
| Edit later | **Edit with the agent** on the dashboard   | **Edit with the agent** on the view                        | **Edit with the agent** on the routine: a new proposal, the old one runs on |

The check is the part that differs most. A dashboard or view check is a
quick read. A routine's preview is a dry run in the sandbox: it can take
longer than one request, calls the model, and counts against the daily
routine model cap (`routines.md` §6.3). So the agent runs it once, while
drafting, and the card shows that stored result. Opening the card never
starts a dry run.

## 4. Rules for all three

1. **The person keeps; the agent drafts.** In the chat, keeping is a
   button. No chat tool saves, pins or proposes.
2. **A kept thing starts private** (dashboards, views) or inactive
   (routines). Sharing with the workspace, or approving, is a separate act.
3. **The guide is read on demand.** A web chat's first message carries one
   line naming every feature's guide. The base prompt stays the same for
   every chat, so its cache is shared.
4. **The check runs before the answer, and again on keeping.** The guide
   tells the agent to check its draft and fix what is reported. The keep
   route runs the same check, so a draft the check refuses is never kept,
   and the card shows its problems. A view's card runs the check when it
   opens and offers no keep button on a failed draft (views.md §6.3). A
   dashboard's card learns of a failure when Pin is refused, and stays
   that way: its tiles already show their own errors.
5. **The preview uses the viewer's access** and real data. It never copies
   numbers or records into the draft.
6. **Edit with the agent** opens a new chat whose first message carries
   the thing and any issues. A dashboard reopens the chat it was pinned
   from when the viewer owns that chat (dashboards.md §8.3).
7. **Renames never break a kept thing.** Dashboards and views store fields
   by key; a routine is type-checked again when the schema changes
   (`routines.md` §5.3). A removed field shows as an issue and offers
   **Edit with the agent**. The issue stays until a person saves the thing
   again, so a view that lost a filter condition never reads as an
   ordinary, wider view (views.md §4.6).

## 5. Shared code and what stays with each feature

Built by Dashboards, in the web app:

| Piece         | Where                          | Shared as                                                        |
| ------------- | ------------------------------ | ---------------------------------------------------------------- |
| Chat blocks   | `routes/agent/chat-blocks.tsx` | A map from a fence's language to the component that draws it     |
| Draft card    | `routes/agent/draft-card.tsx`  | The frame: content, a notice, and the feature's buttons          |
| Block history | `chat-blocks.tsx`              | The earlier drafts of one kind in the chat, for edits and Update |

On the server, the shared part is a pattern, not code: each feature has a
guide in `mcp/guides.ts`, a check tool in `retainer.read` and the MCP
server, and its own keep route. A shared "draft" type or table is not
made: each feature keeps what it keeps in its own table.

What stays with each feature: its fence format, its renderer inside the
card, its check, its keep buttons and routes, and its rules on who may keep
(`write` for dashboards and views, an admin's approval for routines).

### 5.1 Routines in the chat

Routines already have the rest of the pattern. Their builder contract
(`routines.md` §5.1) has a capabilities read, a check (`validate_routine`),
a preview (`preview_routine`, a dry run) and a keep step
(`propose_routine`), and any MCP agent can build with it today. Two things
change when the chat builds routines:

- **A routines guide.** `get_guide("routines")` is new: how to draft,
  check and preview a routine in the chat. Capabilities stay facts from
  `get_routine_capabilities`.
- **The chat agent gets the routine tools.** `get_routine_capabilities`,
  `validate_routine`, `get_routine_job` (a check can come back as a job
  still running), `preview_routine` and `get_routine_preview` join the
  chat's tools. `propose_routine` does not: in the chat, the **Propose**
  button proposes, as the person, what the card shows (rule 1). An MCP
  agent keeps calling `propose_routine`; its proposal still waits for an
  admin.
- **The fence names the checked source, not only a preview.** A proposal
  needs the routine's source and the builder's report, and a routine that
  matched no recent record has no preview at all (`preview_routine`
  returns `previewId: null`). So the card must be able to show and propose
  a checked draft with "no recent matches", without a dry run to point at.
- **The Routines page's text box is replaced by a link to the chat**, a
  chat that starts as §5.2 says. The built-in builder, a job in the sandbox that
  called the model through the proxy, is gone; the chat's agent builds.

How the `retainer-routine` fence and the card work in detail is in
[routines-in-chat.md](routines-in-chat.md), including the daily model cap:
dry runs stop at half of it, so a long chat cannot use up what live
routines need.

### 5.2 Starting from a feature page

Decided with the product owner, 2026-11-28, after trying the prompt by
hand on dashboards and views; revised the same day after Codex's review.
It teaches the pattern by example: the person sees what the agent can
make from their own data before they have to describe anything.

**The entries.** Each is shown when the workspace agent is available and
the person has `write`; routines also need `routinesAvailable`:

| Page                       | Entry                            | Opens                          |
| -------------------------- | -------------------------------- | ------------------------------ |
| Dashboards                 | **New dashboard** button         | `/chat?new=dashboard`          |
| Dashboards, empty          | its **Open chat** link           | `/chat?new=dashboard`          |
| An object page, views menu | **New view with the agent** item | `/chat?new=view&object=<name>` |
| Routines                   | **New routine** button           | `/chat?new=routine`            |

`<name>` is the object's `nameSingular`, as the view bar's API calls use;
the chat shows its `labelPlural`. The views menu keeps **New view…**, the
manual dialog, which is the only entry when the agent is off.

**The starter.** `/chat?new=…` is the chat index (`ChatsPage`), not a
stored chat: opening it creates nothing, so leaving it leaves the chat
list as it was. In place of the general intro and suggestions it shows:

- **A short explanation** of the five steps in the feature's words, three
  lines at most. For dashboards: "Describe a dashboard and the agent drafts
  it from your workspace's data. You see it live here, with real numbers.
  Pin it to keep it; only you see it until you share it." Views say Save;
  routines say Propose and that an admin approves before anything runs.
- **One suggestion prompt**, a button that sends it:
  - "Suggest a few dashboards I could build from this workspace's data."
  - "Suggest a few views of Companies I could keep." (the object's
    `labelPlural`)
  - "Suggest a few routines that would save time in this workspace."
- **The composer**, its placeholder naming the feature ("Describe a view
  of Companies…").

Pressing the prompt or sending typed text creates a web chat and hands the
text over as its first message, the path the index already uses. The text
is exactly what the person sees in the thread; nothing hidden is added. So
typed text carries no context the person did not write: "group these by
stage" does not say which object. The guide tells the agent to ask one
short question when a request does not say which feature or object it
means, as the routines guide already does for an unclear routine.

The URL is checked when the page reads it, not only when the entry is
shown. A `new` value the person cannot use (no `write`, routines off, an
unknown or renamed object) gives the plain index, so a bookmarked link
never offers what the server does not. **Edit with the agent** keeps its
own path: it creates the chat at once, with the kept thing in its first
message.

**Finding the guide.** The line the server adds to a web chat's first
message (`agent-sessions/context.ts`) says to read a feature's guide
"before drafting one"; it becomes "before drafting one or suggesting
ideas for one". The dashboards, views and routines guides' MCP
descriptions say the same, so an MCP agent asked for ideas finds them.

**The answer.** Each guide gains a short **Suggesting** section. When asked
for ideas, the agent:

1. Reads `describe_schema` (and, for routines, `get_routine_capabilities`).
2. Looks at the data: counts and groupings with `aggregate_records`, a few
   records with `query_records`, enough to tell which objects and fields
   are filled and which are empty.
3. Looks at what exists: `list_views` for the object, `list_routines` for
   routines, so it does not suggest a near copy.
4. Answers with up to five ideas. Each has a short name, one line on what
   it shows or does, and why it fits this workspace ("212 deals, 80% with
   a stage and amount"). It leaves out ideas the data cannot support: no
   "revenue by month" when no record has an amount. Fewer is fine, even
   none: then it says what is missing (no records yet, no amounts) or
   points to the view or routine that already does the job.
5. Ends by asking which one to build. It drafts nothing until the person
   picks one or describes their own; then the five steps run as usual.

For routines, suggesting never validates or previews: a dry run calls the
model and counts against the daily cap (§3), so it waits until the person
picks an idea. Every idea uses only what `get_routine_capabilities`
offers. The person's pick is the request "built only from what the person
asked" refers to.

**Limits.** The agent has no tool that lists dashboards, so it may suggest
one the person already has. Accepted: the person sees their dashboards one
page back. The ideas come from a model and vary between chats; the guide
asks for ideas grounded in the data, not a fixed list.

**Tests.**

- Web unit tests: each entry links to the right URL and shows only when
  allowed; the starter at each `new` value shows its explanation, prompt
  and placeholder; a `new` value that is not allowed (routines off, no
  `write`, unknown object) shows the plain index; opening the starter
  creates no chat; sending creates one with the visible text as its first
  message.
- Server unit test: the web-chat line names suggesting.
- End to end, per feature: press the entry, press the prompt, the agent's
  answer arrives (the e2e agent fixture). The routines tests that expect
  **New routine** to create a chat at once
  (`routines/routines.test.tsx`, `e2e/routines-chat.spec.ts`) change to
  the starter.
- By hand on a seeded workspace before merging, from a fresh chat for each
  feature: the tool calls read the guide, the schema and the data; a
  routine suggestion reaches `get_routine_capabilities` and stops before
  `validate_routine` or `preview_routine`; an empty object gets fewer
  ideas and says why.

## 6. Later

- **MCP clients.** An MCP agent can draft and check today. To keep, it
  could hand the person a link that opens the draft in the web app, where
  the card and its buttons are. Not designed yet.
- **A describe box on feature pages**, if the New button (§5.2) still
  proves hard to find. It would open the chat with the person's words as
  the first message.
