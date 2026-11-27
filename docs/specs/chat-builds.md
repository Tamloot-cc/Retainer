# Building in the chat: dashboards, views and Routines

Status: **decided**, 2026-11-27. A short shared design, not a build spec.
Each feature's own spec says how it does each step:
[dashboards.md](dashboards.md) (shipped), [views.md](views.md) (proposed)
and [routines.md](routines.md) (shipped with its own builder; the move into
the chat is §5.1 here).

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

- **The chat is the only way in.** No "Describe…" button on the object
  page, the Dashboards page or the Routines page, though the object page
  would be the natural place for views. One entry keeps the app simple. A
  feature page may link to the chat, but it opens a plain chat.
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
| Draft      | An `openui-lang` fence: the program        | A `retainer-view` fence: the view's settings as JSON       | A `retainer-routine` fence naming the checked preview                       |
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
4. **The check runs before the answer.** The guide tells the agent to
   check its draft and fix what is reported. A draft the check would refuse
   shows its problems on the card and offers no keep button.
5. **The preview uses the viewer's access** and real data. It never copies
   numbers or records into the draft.
6. **Edit with the agent** opens a new chat whose first message carries
   the thing and any issues. A dashboard reopens the chat it was pinned
   from when the viewer owns that chat (dashboards.md §8.3).
7. **Renames never break a kept thing.** Dashboards and views store fields
   by key; a routine is type-checked again when the schema changes
   (`routines.md` §5.3). A removed field shows as an issue and offers
   **Edit with the agent**.

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
  `validate_routine`, `preview_routine` and `get_routine_preview` join the
  chat's tools. `propose_routine` does not: in the chat, the **Propose**
  button proposes, as the person, from the preview the card shows (rule 1).
  An MCP agent keeps calling `propose_routine`; its proposal still waits
  for an admin.
- **The Routines page's text box opens the chat.** The built-in builder,
  a job in the sandbox that calls the model through the proxy, stays until
  the chat version passes the routine eval. Then it is removed, and the
  chat's agent is the built-in builder.

How the `retainer-routine` fence and the card work in detail goes into
`routines.md` when that work starts, after Views.

## 6. Later

- **MCP clients.** An MCP agent can draft and check today. To keep, it
  could hand the person a link that opens the draft in the web app, where
  the card and its buttons are. Not designed yet.
- **A "Describe…" entry on feature pages**, if the chat as the only way in
  proves hard to find. It would open a chat that already knows the object
  or page.
