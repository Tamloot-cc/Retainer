# Connecting agents

Agents use Retainer through MCP. The server hosts the MCP endpoint itself at
`/mcp` (Streamable HTTP); clients that only speak stdio use the
`@retainer/mcp` bridge. Either way the tools are the same, because they are
defined once, on the server.

Create one API key per agent (see [Self-hosting](self-hosting.md#workspaces-and-api-keys)),
with an `agent` actor. `read,write` is enough for most agents; add
`schema:write` if the agent may add fields or apply a template. In
[accounts mode](self-hosting.md#accounts-mode), workspace admins create keys
in the web app under Settings, Agents, and apps that support OAuth, such as
Claude's web app, can connect without a key
([below](#connecting-claudes-web-app-over-oauth)).

```sh
retainer key create --workspace acme --name "Inbox agent" \
  --actor agent:inbox --scopes read,write,schema:write
```

## Over HTTP

Point the client at `https://<your-host>/mcp` and send the key as a bearer
token. In Claude Code:

```sh
claude mcp add --transport http retainer https://retainer.example/mcp \
  --header "Authorization: Bearer rtn_…"
```

Any client that supports Streamable HTTP with custom headers works the same
way. The endpoint is stateless: each request is authenticated on its own.

## Connecting Claude's web app over OAuth

In accounts mode, an app that speaks MCP OAuth connects with the person's own
sign-in instead of a key. In Claude's web app, add a custom connector with the
URL `https://<your-host>/mcp` and connect it. Claude opens Retainer in the
browser, where the person:

1. Signs in, if they are not already.
2. Picks the workspace Claude may use, from the ones they have a role in.
3. Reviews what Claude may do there and chooses Allow.

Claude then works in that workspace as "Claude for <name>", an `agent` actor,
so the rules that need a person still apply. It gets what it asked for that the
person's role allows: a viewer's Claude can only read, and no app can manage
people or keys. To use another workspace, connect again and pick it.

Connected apps are listed under Your account, and for workspace admins under
Settings, Agents. Disconnecting one, removing the person, lowering their role
or deleting the workspace applies at the app's next request. Clients that
register through dynamic client registration work the same way; Claude
identifies itself with a client metadata document.

## The Claude Code plugin

People with a Retainer account can install the Retainer plugin for Claude
Code. It adds the MCP server (signing in over OAuth through `/mcp`) and logs
what their chats teach Claude about their customers and work, without being
asked:

```
/plugin marketplace add Tamloot-cc/Retainer
/plugin install retainer@retainer
```

After each turn, a Stop hook checks in the background whether the turn holds
something the workspace should keep, by asking Claude Haiku through the
person's own Claude Code sign-in. If it does, Claude wakes up and follows the
`log_from_chat` guide. Retainer's core still calls no model. See
[the plugin's README](../plugins/retainer/README.md) for what the hook skips
and how to turn it off.

## Over stdio

For clients that start MCP servers as local processes, run the bridge. It
reads two environment variables and relays MCP messages between stdin/stdout
and the server's `/mcp` endpoint:

| Variable           | Value                                                                               |
| ------------------ | ----------------------------------------------------------------------------------- |
| `RETAINER_URL`     | The server's base URL, e.g. `https://retainer.example`. `/mcp` is added if missing. |
| `RETAINER_API_KEY` | The agent's API key.                                                                |

A client configuration in the common `mcpServers` format (Claude Desktop and
others):

```json
{
  "mcpServers": {
    "retainer": {
      "command": "npx",
      "args": ["-y", "@retainer/mcp"],
      "env": {
        "RETAINER_URL": "https://retainer.example",
        "RETAINER_API_KEY": "rtn_…"
      }
    }
  }
}
```

Or with Claude Code:

```sh
claude mcp add retainer \
  --env RETAINER_URL=https://retainer.example --env RETAINER_API_KEY=rtn_… \
  -- npx -y @retainer/mcp
```

From a checkout instead of npm (the only option until the first release is
published), build it (`pnpm build`) and use
`node /path/to/Retainer/packages/mcp/dist/index.js` as the command.

The bridge writes diagnostics to stderr only. If the server rejects the key or
cannot be reached, the client's request fails with a message saying which, for
example `Retainer at https://retainer.example rejected the API key (401).
Check RETAINER_API_KEY.` `retainer-mcp --help` prints its usage and
`--version` its version.

## Tools

Tools are generic, not one per object, so a workspace's custom objects never
change the tool list.

| Tool                    | What it does                                                                                                                 | Scope          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `describe_schema`       | The workspace's objects (entities and event types) and fields, and the built-in facts and comments                           | `read`         |
| `list_templates`        | Templates and what each would add                                                                                            | `read`         |
| `apply_template`        | Apply a template to the workspace                                                                                            | `schema:write` |
| `get_guide`             | Step-by-step instructions for a rare task, e.g. `discover_schema`                                                            | `read`         |
| `query_records`         | Filter, sort and page the records of one object; for an event type, or `event` for every type, the events linked to a record | `read`         |
| `get_record`            | One record by ID with its latest comments; merged IDs resolve to the surviving record                                        | `read`         |
| `list_comments`         | All of a record's comments, which people write for each other; read as context, never cite                                   | `read`         |
| `search`                | Keyword search across records, events and facts                                                                              | `read`         |
| `get_context`           | A context pack for one record, fitted to a token budget                                                                      | `read`         |
| `get_timeline`          | A record's history: events, values asserted for its fields and facts, newest first                                           | `read`         |
| `upsert_record`         | Create a record, or update one found by `id` or a unique `match`                                                             | `write`        |
| `log_event`             | Log a conversation (meeting, call, email, chat) or another event type, with who took part and what it is about               | `write`        |
| `remember`              | Store a plain-language fact about a record, citing an event                                                                  | `write`        |
| `propose_schema_change` | Add fields or objects (applied at once), or propose destructive changes for a person to approve                              | `schema:write` |
| `move_events`           | Change the type of logged events, keeping IDs, identity, links and citations; agents run it as a dry run                     | `schema:write` |

`describe_schema` returns `valueFormats`: how to write a value of each field
type the workspace uses, for example `full_name` as `{ first, last }` and
`emails` as `{ primary, additional: [...] }`. Validation errors name the field
and the allowed values, and for a composite field the expected format
(`expected`), so an agent can correct its call and retry.

## Setting up a new workspace

The `discover_schema` guide walks an agent through designing the workspace
from its user's own data. The agent works out the business from what it
already knows, finds the sources its own tools reach (an existing CRM,
spreadsheets, email, calendar), and reads the business's existing records
first. It asks its user only for what it cannot find. It samples those
sources and proposes a template plus the objects and fields the data calls
for, each with the evidence for it. Nothing is applied until the user
agrees.

An agent reads it with `get_guide`, and the server instructions tell it to
when `describe_schema` reports `initialized: false`. A person can also start
it as the MCP prompt `discover_schema`, with an optional `sources` argument
naming where to start; in Claude Code, with the server added as `retainer`,
that is `/mcp__retainer__discover_schema`. Applying the schema needs the
`schema:write` scope.

## Growing the schema

The `schema_design` guide holds the rules for changing a schema that is
already in use, and the server instructions point an agent to it before it
first adds an object. It also walks an agent through reviewing a schema in
use; a person can start that review as the MCP prompt `schema_design`.

## Logging from a chat

The `log_from_chat` guide tells an agent what to do when a chat with its user
holds something durable about the people, companies or work the workspace
tracks: what is worth keeping, which source to cite (the email or meeting it
read, or else the turn of the chat, logged as a conversation with the client
as its channel and the session and turn IDs as its external ID), and when to
ask before creating a record. The server instructions point an agent to it, and the
Claude Code plugin wakes Claude to follow it after a turn that needs it. A
person can start it as the MCP prompt `log_from_chat`.

## How an agent should write

Retainer does not read conversations; the agent does. After a meeting, call or
email thread, a well-behaved agent:

1. **Logs the event** with `log_event`: its type (`conversation` with a
   `medium` for meetings, calls, emails and chats; another event type only
   when the workspace defines one for that kind of event), channel (the
   source system or account, part of the event's identity), time (with a
   UTC offset), title, its own short
   summary, the type's other fields, the source's external ID, the
   participants as emails, phones or record IDs, and in `about` the IDs of
   the records it concerns. The response lists which participants matched a
   record and which did not. For an unmatched person worth keeping, create them
   with `upsert_record` citing the event as `source`, then re-log the same event
   with the same handle and role plus the new `recordId`. The stored participant
   is linked in place and listed in `added.participants.matched`.
2. **Updates records** with `upsert_record`, passing the event's ID as
   `source`. Cited values carry the event's date, so an old email can never
   overwrite a newer value.
3. **Stores facts** with `remember`, citing the same event and, optionally,
   a short quote.
4. **Creates tasks** someone committed to, as `task` records.

Things worth knowing:

- **Finding the record.** `upsert_record` finds its record by `id` or by a
  unique field in `match` (for example `{ "emails": "dana@acme.com" }`).
  `ifMissing` defaults to `"fail"`, so "update Dana's address" can never
  create a second Dana; pass `"create"` to create when nothing matches. To
  find someone by name or phone, use `search` or `query_records` first.
- **Pending values.** Each field in a write comes back as `applied`,
  `pending_review` or `superseded`. An agent's value that would overwrite what
  a person entered waits for review; the agent should say so rather than claim
  the update is done.
- **Lists of records.** A `many_to_many` relation (for example a deal's
  `contacts`) takes the whole list of record IDs, and a write replaces it, so
  read the record first and send every member to keep; `[]` clears it. The
  other side of a relation (`readOnly`, `isInverse` in `describe_schema`) is
  written from its owning side. A relation with `targetObjects` takes records of any
  of those objects; find the records pointing at one by filtering on it.
- **Rolled-up events.** A relation with `rollUpEvents` (shown in
  `describe_schema`) also lists the events of the records pointing at a record
  in its history: a company sees the calls about its deals, with
  `via: { kind: "rollup", field, record }`. It is one hop and follows the
  relation's current value, so a reassigned deal takes its events with it.
  Still put the company in an event's `about` when the event is about the
  company itself.
- **Participants and `about`.** Participants are who took part. A meeting
  with Dana about the Acme pilot lists Dana as a participant and the Acme
  company and the pilot project in `about`:

  ```json
  {
    "type": "conversation",
    "channel": "calendar",
    "externalId": "evt-4410",
    "fields": { "medium": "meeting" },
    "occurredAt": "2026-10-29T14:00:00+02:00",
    "title": "Acme pilot review",
    "participants": [{ "handle": "dana@acme.com", "role": "customer" }],
    "about": ["<acme company id>", "<pilot project id>"]
  }
  ```

  The meeting then shows in `get_context` and in `query_records` with
  `linked` for every record it is linked to. Don't list a company or project
  as a participant.

- **Retries are safe.** Logging the same `(channel, externalId)` again with the
  same type, time, title, summary and fields returns the existing event with
  `created: false`. Participants and `about` records it did not have yet are
  added and listed in `added`, so an agent that left the company out can log
  the same source again with it. Nothing is removed that way; a different
  payload is a conflict (`event_conflict`), and `event_retracted` means the
  source was deleted or erased: don't log it again. Writes are independent short
  transactions, so an agent that stops halfway leaves consistent data and can
  resume.
- **Events over time.** `query_records` on an event type lists its events by
  `occurredAt`, `channel` or a field, and with `linked: { record }` only
  those attached to one record, e.g. calls with a company this quarter
  (`conversation` filtered by `medium`). With `object: "event"` it lists
  events of every type at once, filtered by `type`, `occurredAt`, `channel`
  and `externalId`: everything logged this week, or every event about a
  company.
- **Comments.** People write comments to each other on records; an agent
  reads them with `get_record` and `list_comments`, and gets 403 if it tries
  to write one. They are context, not evidence: nothing can cite one. If a
  comment says "she moved to Berlin", check it, then record it with
  `upsert_record`, or `remember` it citing a real source.
- **Events name entities.** `about` and `participants` take entities only; an
  event in `about` is a 422 `invalid_link`.
- **Object or event.** Something with a state people change is an object;
  something that happened, reported by a source, is an event; a change to an
  object is its history. The `schema_design` guide has the full test.
- **Channel and medium.** `channel` is where the event came from, the source
  system or account (`gmail`, `zoom`, `whatsapp-business`); it is part of the
  event's identity and fixed once logged. `medium` is what kind of
  conversation it was. Leave `medium` empty when unsure; it can be corrected
  later with `upsert_record`. An event's type changes only with
  `move_events`, which a person runs.
- **Your own event types.** Add an event type only for events whose fields
  a conversation would never use: a payment (an amount, an invoice), a form
  submission, a site visit. `propose_schema_change` with `create_object` and
  `class: "event"`. It gets a title and summary of its own; add only the
  fields it needs. Conversation details such as duration or a recording
  link are fields on `conversation`, and a new kind of conversation is a
  new `medium` option.
- **Moving events to another type.** A workspace that logged meetings and
  calls as their own types can move them to `conversation` without
  re-logging: `move_events` with `from: "meeting"`, `to: "conversation"` and
  `defaults: { "medium": "meeting" }`. Each event keeps its ID, `channel` and
  `externalId`, participants, `about` records, and the values and facts that
  cite it. Never delete and re-log instead: that retracts what cites the
  events and blocks their source for good. Fields map by name; `fields` maps
  ones named differently. Values the target has no field for are refused
  with a list (`unmapped_fields`) until they are mapped or listed in `drop`,
  which deletes them, so drop only what your user agreed to lose. Moving
  needs a person (a `user` key with `admin`); an agent passes
  `dryRun: true`, which reports exactly what would move and changes nothing,
  and shows its user. A later sync logs the moved sources as `conversation`
  with the same medium, and they match the moved events.
- **Reading back.** `get_context` gives the current values (with who wrote
  each), open tasks, current facts and recent events, rolled-up ones
  included (each saying how it is attached, `via`), within
  `tokenBudget` tokens (default 2000, at most 16000). `omitted` counts what
  did not fit.
- **History.** `get_timeline` lists how a record got here: its events, every
  value asserted for its fields (`current` says whether it is the value now;
  one that is not may never have been) and its facts, newest first. Narrow it
  with `fields` (e.g. `["stage"]`), `eventTypes`, `types` and a `from`/`to`
  range, and pass `nextCursor` back with the same filters for the next page.
- **Schema.** Additive changes (new objects, fields, options) apply at once.
  Renames, removals and new required or unique constraints requested by an
  agent are stored as proposals for a person to approve in the web app.

## Several agents in one workspace

Give each agent its own key. Every write is attributed to the agent that made
it; between agents the most recent observation wins, and the full history of
each field stays available through the REST API and the web app.
