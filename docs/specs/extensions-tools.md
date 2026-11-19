# Extension tools: spec

Status: **proposal**, 2026-11-19. Not accepted and not built. Extracted from
the routines spec ([routines.md](routines.md), §8 there), which is its first
caller. The rules for how a routine calls a tool stay in that spec.

Builds on the extension platform in [extensions.md](extensions.md), model calls
in [extensions-model-calls.md](extensions-model-calls.md) and the two-step
install in [extensions-configure.md](extensions-configure.md). If accepted it
amends `extensions.md`:

- §5: a new `tool` trigger. §5 already reserves it as "a new capability, not
  an unknown kind silently accepted today".
- §9.1: the run result gains an optional output.
- §12: tools that a person or a routine can call. App-provided tools are
  deferred there today.

## 1. The idea

A **tool** is a function an extension publishes for others to call, such as
"send a WhatsApp message" or "is this address deliverable". It is the one new
capability extensions need to take part in routines, which they do in three
places:

- **When.** No change. Whatever an extension writes is a record, and a
  routine can react to it.
- **If.** A read-only tool can answer a question, such as "is this address
  deliverable", for the routine's code to test.
- **Do.** A tool performs an action, such as sending a message.

A tool is extension code. It runs in its own job, with its extension's
credentials, and nothing that calls it ever holds those credentials.

## 2. Declaring a tool

A tool is a function with the new `tool` trigger.

```ts
import { defineTool } from '@retainer/extension';

export const sendWhatsApp = defineTool({
  universalId: '…',
  name: 'send_whatsapp_message',
  title: 'Send a WhatsApp message',
  description: 'Sends one WhatsApp message to a person from the clinic number.',
  handlerDigest, // Computed by the release build, as for other hosted functions.
  effect: 'send',
  inputSchema: {
    type: 'object',
    properties: {
      person: { type: 'string', description: 'Record ID of the recipient' },
      text: { type: 'string', maxLength: 1000 },
    },
    required: ['person', 'text'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { messageId: { type: 'string' } },
    required: ['messageId'],
    additionalProperties: false,
  },
  connection: 'workspace',
  secrets: ['apiToken'],
  scopes: ['read', 'write'],
});
```

| Field                         | Purpose                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `name`, `title`               | How code and people refer to it                                                                            |
| `description`                 | Written for an agent: what it does and when to use it                                                      |
| `effect`                      | `read` (answers a question), `write` (changes Retainer records only) or `send` (acts outside Retainer)     |
| `inputSchema`, `outputSchema` | Use the extension platform's bounded JSON Schema subset. Retainer validates values against them and uses them to generate routine SDK types. |
| `connection`                  | Matches the release's `workspace` or `member` connection mode; a `member` tool runs only in manual runs |
| `secrets`, `scopes`           | As for any function (`extensions.md` §5)                                                                   |
| `uses`                        | Declares a model call, as functions do today                                                               |

## 3. The run result carries an output

Today a function's result is only a status: `succeeded`, `retry` or `failed`.
A tool has to return data, so a successful protocol v1 result gains an
optional JSON `output`, checked against the tool's `outputSchema`. The
serialized result still has a 64 KiB limit. Every bundle is rebuilt with the
updated v1 schema, as when the invocation gained `model`
(`extensions-model-calls.md` §3.2).

## 4. Calling a tool

One runtime call starts a tool and returns a call ID; the caller polls it for
the status and the output. A tool may run for 120 seconds, and the hosted API
answers every request within 30, so the call cannot hold a request open. The
routine SDK hides the polling: `retainer.tools.<name>(input)` returns the
output. Three kinds of caller use it:

| Caller            | How                                          | When                 |
| ----------------- | -------------------------------------------- | -------------------- |
| A routine         | `retainer.tools.<name>(input)` from its code | With routines        |
| A person          | A button on a record                         | With manual triggers |
| A connected agent | An MCP tool                                  | Later                |

What the platform adds around every call:

- **Approval.** Installing an extension shows the tools it offers. A normal
  routine run can call only tools listed in its approved version. An admin
  can start a test before approval, with access limited to the tools in that
  test run's validated proposal (`routines.md` §5.3 and §8).
- **Polling.** Retainer binds each call to its workspace and initiating
  routine run or authenticated member. Each poll for status or output
  requires a valid credential for that same run or member in that workspace.
  The member must still have workspace access. A poll outside that scope
  returns 404.
- **Whose account.** A standing caller uses `workspace` connections only. A
  `member` tool runs only when a person starts it, such as a button they
  press, acting as that person, with that person's own connection. The member
  comes from the credential of the person who pressed, never from the
  caller's payload, and Retainer checks again when the queued call executes
  that the person is still a member, the connection is still theirs and
  live, and the tool is still installed. An admin's approval never lets a
  routine act from another member's account, as each member's connection is
  theirs alone (`extensions-tamloot-connect.md` §14, item 2). A member
  granting a standing routine use of their account is deferred.
- **Duplicates.** Every call carries a key; a routine's call carries its
  effect key (`routines.md` §6.2). Delivery is at least once, so a `send` tool
  must use the key to avoid sending twice.
- **Input and output are checked.** Retainer checks the input against
  `inputSchema` before the tool job is queued and the output against
  `outputSchema` when it returns. A call that fails either check fails.
- **Cause.** The call carries the cause chain, so a tool's writes cannot
  trigger the routine that called it.
- **Its own lane.** Installations run one job at a time by default. Tool
  calls need a separate allowance, or a busy routine would wait behind an
  extension's sync.

Retainer blocks all tool calls in a routine dry run and blocks tools declared
as `send` in a test run before queueing (`routines.md` §5.1). Installed tool
code must honor its declared effect: `read` tools must avoid writes and
external side effects, and `write` tools must limit mutations to Retainer
records. Retainer uses the declaration to decide which tools to start. Tools
that run keep their extension's credentials and network access
(`extensions.md` §9.1), so the test-run policy depends on the declaration
accurately describing the code.

## 5. What the routine builder needs from extensions

- **A tool list with status.** `get_routine_capabilities` reports each tool,
  whether its extension is healthy and whether its account is connected.
- **Good descriptions.** Tools and contributed fields need descriptions
  written for an agent. They are what the builder reads, and they become the
  comments on the SDK's types.
- **A way to tell data is complete.** Extensions that bring data in stages
  (a meeting first, its transcript later) should write something a condition
  can test, such as the transcript field being filled.
- **Optional: suggested routines.** An extension may ship routine
  descriptions, such as "after a Tamloot meeting, create a follow-up task".
  They install switched off and go through the same builder and approval.

## 6. What extensions do not get

- No new trigger kinds for routines. Extensions make something automatable by
  writing it down as a record or a field.
- No way to approve, edit or start a routine on their own.

This follows Twenty, where an app's function can be exposed as a workflow
action but apps add no trigger types (`routines.md` §13.2).

## 7. Delivery and rollout (proposed)

This is phase 1 of the routines delivery order (`routines.md` §11.1):
`defineTool`, the optional `output` in protocol v1, the invoke call with its
call ID and polling, and the tool list. It has no caller until routines'
phase 3, so it lands before it or with it.

What each package gains:

| Package              | License | Gains                                                                           |
| -------------------- | ------- | ------------------------------------------------------------------------------- |
| `packages/extension` | MIT     | `defineTool`, the `tool` trigger, and the run result's optional output          |
| `packages/runner`    | MIT     | Tool dispatch                                                                   |
| `packages/sdk`       | MIT     | A client method for calling a tool and polling its result                       |
| `packages/server`    | AGPL    | Tool invocation in the runtime: the invoke call, checks, the tool list, a lane  |

Hosted rollout:

- **A new trigger kind.** `tool` is a trigger kind no hosted bundle has used.
  The hosted server refuses a catalog with a kind it does not list
  (`extensionServices` in `extension-control/configuration.ts`), and on
  2026-11-15 that took production down when `connect` was added. A server
  release that accepts `tool` must be live before any bundle declaring a tool
  enters the hosted catalog.
- **Polling, not waiting.** Tool calls return an ID because the hosted API
  answers within 30 seconds (§4).

## 8. Acceptance tests (proposed)

Beyond the unit and integration tests every feature needs, against real
Postgres:

- **Output.** A tool whose output breaks its `outputSchema`, or exceeds
  64 KiB, ends as failed, and the caller gets an error, not the output.
- **Polling.** The initiating routine run or member can poll its call.
  Another run or member in the same workspace, a caller in a different
  workspace, and a member who has lost workspace access get neither status
  nor output.
- **Member tools.** A `member` tool called by a standing routine is refused.
  Called from a button, it runs with the presser's connection; if the person
  left the workspace or the connection was revoked before the queued call
  executes, it is refused.
- **Cause.** A tool's write does not trigger the routine that called it.
- **Its own lane.** A tool call is not held behind a long-running sync job of
  the same installation.
- **Hosted catalog.** A catalog with a `tool` function loads on a server that
  lists the kind.
