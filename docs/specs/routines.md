# Routines: spec

Status: **proposal**, 2026-11-19. Not accepted and not built. This is the
third draft of the day: after two reviews, the product owner decided that a
routine is TypeScript code, not a JSON flow, and that the first version stays
lean. Section 2 lists what is decided and what is only proposed.

Builds on the extension platform in [extensions.md](extensions.md), model calls
in [extensions-model-calls.md](extensions-model-calls.md) and the two-step
install in [extensions-configure.md](extensions-configure.md). If accepted it
amends:

- `extensions.md` §5 (a new `tool` trigger), §9.1 (the run result gains an
  optional output, and a first-party bundle may run code written inside a
  workspace in a closed process), §9.4 (routines keep their own cursor on the
  change feed) and §12 (tools an agent can call).
- `extensions-model-calls.md` §3.2.1 (a narrower list of allowed requests
  for a routine's model token) and §3.4 (`ai_usage` rows name the routine
  and the run).
- `ARCHITECTURE.md` §2.1 (`forget` clears a routine run's stored results).

The write rules and the actor types in `ARCHITECTURE.md` do not change: a
routine writes as an agent (§6.4).

Background: [the Rapid Image feature mapping](../research/rapid-image-features.md)
and [the earlier design page](https://claude.ai/artifact/FDjGnvenXbdHzjuBfomvXv).
A visual version of this spec is at
<https://claude.ai/artifact/MD4KBw6MMHr5JErEZCnXQm>. The design draws on Macro's
routines and Twenty's workflows; §13 records what was taken from each and where
to look.

The document goes top-down. Section 1 is the whole idea on one page. Sections
3 to 6 add a layer of detail each. Sections 7 and 8 cover what routines share
with extensions and what extensions must gain. Sections 9 and 10 show what is
possible, where the design stops and what is left for later. Section 11 is the
delivery order, its acceptance tests and the hosted rollout. Section 13 lists
the prior art.

## 1. The idea on one page

A **routine** is a standing instruction for the workspace: when something
happens, if a condition holds, do something.

A person never builds a routine by hand. They describe it in plain words. An
agent translates the description into a small **manifest** (when it runs) and
**code** (what it does), written in TypeScript against Retainer's SDK. The
agent must also say honestly how much of the description the routine covers.
The person reviews what it will do and approves it. From then on Retainer
runs it.

```mermaid
flowchart LR
  P["Person"] -->|"1. describes it in plain words"| B["Builder agent"]
  B -->|"2. asks what is possible"| R["Retainer"]
  B -->|"3. proposes a manifest, code and an honest report"| R
  R -->|"4. shows its limits and a dry run"| P
  P -->|"5. approves"| R
  R -->|"6. runs the code when triggered"| S["Closed sandbox"]
```

Who does what:

- **The person** writes the description and approves the result. Nothing runs
  without a person's approval.
- **The builder agent** writes the manifest and the code and reports what it
  could not cover. It is either Retainer's built-in builder or the person's
  own agent connected over MCP.
- **Retainer** tells the builder what is possible, checks every routine,
  stores it, decides when it fires and starts its runs. All of that is fixed
  logic. Retainer's core still never calls a model and never runs the code
  itself.
- **The closed sandbox** runs the code. It can reach Retainer's API and
  nothing else.
- **Extensions** supply the data a routine reacts to, by writing records, and
  the **tools** a routine can call, such as "send a WhatsApp message".

## 2. Decided and proposed

Decided with the product owner on 2026-11-19:

- Automations are a primitive of their own, called **Routine**, not a generic
  extension.
- **The builder is free text.** People do not assemble triggers and steps.
- **The builder agent gives honest feedback** on whether the routine is
  possible with the tools it has.
- **A routine is code.** The builder writes TypeScript, and it runs later in
  the sandbox, as Macro's routines do (§13.1). The first two drafts used a
  JSON flow that Retainer interpreted.
- **A routine can call a model** from its code.
- **Authority is one fixed rule** with nothing to configure: a routine writes
  as an agent (§6.4).
- **The first version is lean.** What is left out is listed in §10 with the
  room left for it.
- Scope includes the **extension upgrade** that lets extensions take part
  (§8).
- **Retainer pays for the model calls** a routine makes, with its own key, as
  it does for extension model calls. A workspace is never asked for a model
  key.
- **Member accounts** are used only in manual runs, by the person who pressed
  the button (§8.3). A standing routine uses workspace connections only.
- **No safeguards against hidden instructions in the first version** beyond
  what the structure gives (§6.3). The risk and its solutions get a proper
  study for the second version.

What the move to code dropped from the earlier drafts:

- The flow format: steps, `each`, `find` and value references.
- A rank worked out for every value. A routine now has one rank.
- The readback Retainer generated from the flow. Fixed code cannot describe
  what a program does, so the review shows other things (§5.2).
- The agent step with tools. Code calls a model for a typed answer instead
  (§4.5).

Proposed in this document, open to change: the manifest format, the SDK's
shape, the limits and the delivery order. §12 records the answers recommended
for the open questions.

## 3. Architecture

### 3.1 Vocabulary

| Term           | Meaning                                                                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Routine        | A named standing instruction. Holds a description and its approved version.                                       |
| Description    | The person's plain-language text. It is the source; the rest is derived from it.                                  |
| Manifest       | The data part of a version: the trigger, the condition and what the code may use.                                 |
| Code           | The TypeScript part of a version: one module with a `main` function.                                              |
| Trigger (when) | What starts a run: a record created or updated, an event's links changing, a time, or a person pressing a button. |
| Condition (if) | A record filter checked when a run starts.                                                                        |
| Tool           | A function an extension publishes for others to call.                                                             |
| Run            | One execution of the code, with a record of every call it made.                                                   |
| Effect         | A call that changes something or costs something: a write, a tool call or a model call.                           |
| Dry run        | A run whose writes and sends are refused and only reported.                                                       |
| Builder agent  | The agent that translates a description into a manifest and code.                                                 |

### 3.2 Where each part runs

```mermaid
flowchart LR
  subgraph People["People and agents"]
    PE["Person, in the web app"]
    UA["Person's own agent, over MCP"]
  end
  subgraph Trusted["Retainer, trusted"]
    API["API and write rules"]
    ST["Routine store and manifest checker"]
    FEED[("Change feed")]
    MATCH["Matcher"]
    SCHED["Scheduler"]
    Q[("Job queue")]
    PROXY["Model proxy"]
  end
  subgraph Sandbox["Closed sandbox"]
    BUILD["Built-in builder"]
    RUN["Routine runner: type-checks and runs the code"]
    TOOLS["Extension tools"]
  end
  PE --> API
  UA --> API
  API --> ST
  API --> FEED
  FEED --> MATCH
  SCHED --> MATCH
  ST --> MATCH
  MATCH --> Q
  Q --> RUN
  Q --> BUILD
  Q --> TOOLS
  RUN -->|"reads, writes, tool calls"| API
  RUN -->|"model calls"| PROXY
  BUILD --> PROXY
  BUILD --> API
  TOOLS --> API
```

Four rules decide the placement:

1. **Code a model wrote runs in the closed sandbox, never in Retainer.** That
   is every routine's code. Retainer does not interpret it, import it or
   evaluate any part of it.
2. **Everything Retainer needs before a run starts is data.** Checking a
   manifest, matching triggers, evaluating the `if` and applying the holds
   and caps need no model and no outside code, so the trusted worker does
   them.
3. **The sandbox only ever holds agent-rank tokens.** A routine writes as an
   agent (§6.4), so nothing with a person's authority leaves Retainer.
4. **Sandbox runs never talk to each other.** When routine code calls an
   extension tool, the call goes through Retainer (§8.3), which checks it,
   attaches the extension's credentials and runs the tool as its own job.
   Routine code never holds an extension's secrets, and extension code never
   holds a routine's token.

### 3.3 The closed sandbox

Today the sandbox runs only reviewed code that Tamloot publishes, and hosted
job functions can reach any public address (`extensions.md` §9.1). Code that
a model wrote inside a workspace can read that workspace's records, so it
must not be able to send them anywhere. Routines therefore need a stricter
kind of run. This is the first thing to build (§11).

- **The routine runner** is a first-party bundle. Its job input carries IDs
  only: the routine version and the triggering record. It fetches the code
  and the record through the API with its run token.
- **A fresh, restricted process for every run.** The runner starts one
  process per run and gives it no files, no environment variables, no
  subprocesses and no imports beyond the bundled SDK. Nothing a run leaves
  behind is visible to the next run, including on a reused hosted function.
- **Network to Retainer only: its API and its model proxy.** Hosted, the
  runner's function has no public egress. In Compose, its container's proxy
  allows only those two.
  Outside effects come only from extension tools, called through Retainer.
- **The run token is the boundary.** It is bound to one run, expires with
  it, has agent rank, and can call only the tools the manifest lists and the
  model only if the manifest says so. A dry run's token cannot write at all.
- **The type-check runs here too**, in the same bundle, without running the
  code (§5.2).

Limits inside the process steer the code and catch mistakes. They are not the
security boundary: the token, the API and the network are. Macro says the
same of its own sandbox (§13.1).

## 4. The routine

### 4.1 Shape

A version is a manifest and a module. The manifest refers to objects and
fields by their stable keys, never by display names, so a rename does not
break it. (In the examples the keys of base fields equal their names.)

```json
{
  "when": {
    "kind": "record",
    "object": "deal",
    "on": ["updated"],
    "fields": ["stage"],
    "oncePerRecord": true
  },
  "if": { "stage": { "eq": "proposal" } },
  "uses": { "tools": [], "model": false }
}
```

```ts
export async function main({ retainer, record, run }: RoutineContext<'deal'>) {
  const due = new Date(run.at);
  due.setDate(due.getDate() + 2);
  await retainer.task.create({
    title: 'Send the proposal',
    dueDate: due.toISOString(),
    deal: record.id,
  });
}
```

What Retainer checks and what it does not claim:

- **The manifest is data.** Retainer checks it completely, matches on it
  without running anything, and describes it to the person in its own words.
- **The code is a program a model wrote.** Retainer does not claim to know
  what it will do. It type-checks it, limits what it can do (§3.3, §6.4),
  shows a dry run on real records before approval (§5.2) and records every
  call each run makes (§6.6).

### 4.2 Triggers (when)

| Kind       | Fires when                                                         | Example                                |
| ---------- | ------------------------------------------------------------------ | -------------------------------------- |
| `record`   | A record of one object is created or updated                       | A deal's stage changes                 |
| `relative` | A set time before or after a date field on a record                | 1 day before an appointment starts     |
| `schedule` | A cron time in the workspace's time zone, once per matching record | Every Monday 09:00, for each open deal |
| `manual`   | A person runs it on one or more records                            | A "Send quote" button on a deal        |

- Events are records, so "a meeting was logged" is a `record` trigger on that
  event type. So is anything an extension writes.
- `record` can name the fields to watch. A change to any one of them fires
  it; without a list, any change does. There is no "all of these changed
  together".
- **An event's links.** On an event type, `on` can also take `links`: the
  routine then fires when the event's participants or `about` records change,
  such as a participant matched to a newly created person when the event is
  logged again. The feed records this as the `links` operation, with no field
  keys, whenever a write changes an event's links and none of its fields
  (`changes/collect.ts`). It does not say whether a participant or an `about`
  link changed, so the `if` or the code decides whether the change matters. A
  write that changes a field and a link together is recorded as `update`, and
  fires the routine only through its watched fields.
- The matcher decides only whether a change concerns the routine: the object,
  the operation and the watched fields (§6.1). The `if` is evaluated when the
  run starts (§4.3), against the record as it is then.
- **Once per record.** `oncePerRecord: true` lets a routine act at most once
  for each record, ever. A deal that leaves Proposal and comes back does not
  get a second task, and a corrected transcript does not create the tasks
  again. Without it, every matching change can start a run.
  - A run counts only once it makes its first effect: a write, a tool call or
    a model call. A run skipped by the `if`, or one whose code returns before
    any effect, does not use up the record, so a meeting checked before its
    lead was matched is checked again when the lead arrives.
  - The mark is set in the same transaction that records that first effect,
    and Retainer checks for an existing mark just before it, so two runs
    queued close together cannot both act.
- **No `deleted` trigger in the first version.** A run reads the triggering
  record, and the record query excludes deleted records. A merge is not a
  trigger either; §6.1 says what it does to runs and firings.
- `relative` covers "no contact for 7 days": 7 days after `lastContactAt`.
  §6.1 says what happens to existing records and to due times already past.
- `schedule` may carry a record filter. Each matching record gets its own run,
  up to the fan-out limit (§4.6). Without a filter it produces one run with no
  record. Cron is read in the workspace's time zone, a setting workspaces
  don't have yet (§7).
- **Expiry.** A run expires 24 hours after it starts by default. A manifest
  can set an earlier expiry from a date field, such as the start of the
  appointment a reminder is for. After the expiry Retainer refuses the run's
  further effects and the run ends as `expired`, so a reminder is never sent
  late.

### 4.3 Condition (if)

The `if` is a record filter on the triggering record, in the grammar
`POST /v1/objects/:object/query` already takes: fields ANDed, `and`, `or` and
`not` for nesting, and per field the operators its type allows
(`FILTER_OPERATORS` in `packages/shared/src/api.ts`). The manifest stores field
keys where the query takes names; the checker resolves them to the current
names when it runs the query. Only filterable fields can be tested, as in a
query: the checker refuses any other, and the builder reports
`field_not_filterable` (§5.2).

The `if` is checked when the run starts, by running the ordinary record query
for that one record. A run whose `if` fails ends at once as `skipped`, and no
code runs. That makes the `if` the cheap first test: it costs no sandbox run.

A condition sees the record's current values. "The stage changed to
Proposal" works: watch the field and test its value. "Changed from Lead" does
not, because the change feed records which fields changed, not their earlier
values (§12).

Anything beyond the triggering record is tested in the code: a related
record's values, a count, a sum, a tool's answer or a model's answer. Code
that returns before its first effect leaves the record unused (§4.2).

### 4.4 The code

One module per version, exporting `main`. It gets:

| Argument   | What it is                                                                                |
| ---------- | ----------------------------------------------------------------------------------------- |
| `retainer` | The SDK, typed for this workspace's objects, fields and tools                             |
| `record`   | The triggering record as it is when the run starts. Absent on a `schedule` with no filter |
| `run`      | `id`, `at` (when the run counts as happening), `timezone` and `dryRun`                    |
| `trigger`  | `kind`, and for a manual run who pressed the button                                       |

What the SDK offers:

| Call                                            | Does                                                     | An effect |
| ----------------------------------------------- | -------------------------------------------------------- | --------- |
| `retainer.<object>.get`, `.query`, `.aggregate` | Reads records, with the API's own filters and aggregates | No        |
| `retainer.<object>.create`, `.update`           | Writes a record                                          | Yes       |
| `retainer.events.log`, `retainer.remember`      | Logs an event, stores a fact                             | Yes       |
| `retainer.tools.<name>(input)`                  | Calls a tool an extension publishes (§8)                 | Yes       |
| `retainer.ai.generate(...)`                     | Asks a model for a typed answer (§4.5)                   | Yes       |

Rules for the code:

- **Typed from the workspace.** Retainer generates the SDK's types from the
  workspace's schema and installed tools, with fields under their stable
  keys. Code that names a missing object, field or tool, or passes a value of
  the wrong type, does not type-check and cannot be saved.
- **No imports and no network.** The SDK is the only way out.
- **`run.at`, never the clock.** Code reads "now" from `run.at`, so a dry run
  and a retried run give the same answer.
- **It can loop, branch, count and build text.** That is the point of code:
  there is no step list to fit into.
- **It cannot** change the schema, extensions, members or routines, read
  personal memory, or approve anything. The run token refuses those calls.

### 4.5 Model calls from code

```ts
const answer = await retainer.ai.generate({
  instructions: 'List each thing someone promised in this meeting, who and by when.',
  input: { transcript: record.transcript },
  output: {
    type: 'object',
    properties: {
      commitments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            due: { type: 'string' },
          },
        },
      },
    },
  },
});
```

- **One call, one typed answer.** The model gets the instructions, the input
  the code passes and the shape to answer in. It has no tools and cannot read
  anything else. A yes-or-no question is the same call with a boolean in the
  shape.
- The instructions come from the approved code. Record content is passed as
  input and reaches the model as data.
- The code decides what to do with the answer. The model never acts.
- One model that the operator sets, by default the one the enrichment
  extension uses. Code never names a model.
- **The same model proxy extensions use** (`extensions-model-calls.md` §3),
  with a model token of its own kind. It is a plain model call, one request
  and one answer, not an agent. For a routine's token the proxy accepts only
  that: the operator's model, with no `tools` and no `mcp_servers`. An
  extension's token keeps the wider list. The code holds its token and could
  call the proxy directly, so the proxy is what makes "no tools" true. It
  also keeps the sandbox closed: a model's server-side tools, such as web
  fetch, would otherwise be a way out.
- A manifest must say `"model": true` for the call to work. The review then
  says that the routine sends workspace data to the model provider.
- **No agent with tools in the first version.** An open-ended agent that
  searches and writes on its own is left for later (§10).

### 4.6 Limits (proposed)

| Limit                                      | Value                           | Why                                                                    |
| ------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------- |
| Source of one routine                      | 64 KiB                          | Macro's limit; keeps a version reviewable                              |
| One run                                    | 120 s by default, 300 s at most | The extension run limits (`extensions.md` §9.1)                        |
| Calls of one SDK operation in a run        | 200                             | Stops a runaway loop                                                   |
| Model calls in a run                       | 50                              | Bounds cost per run                                                    |
| Model calls per workspace per day          | 1,000                           | Bounds spend. Dry runs and builder submissions count                   |
| Runs one routine may queue in an hour      | 200                             | Stops a runaway or a bulk import. Further runs are held, and it pauses |
| Records one `schedule` tick may fan out to | 200                             | Bounds a scheduled sweep. Above it the tick waits for an admin         |
| A run's expiry                             | 24 hours after it starts        | The queue's job lifetime. A manifest can set an earlier one            |
| One tool or model result                   | 64 KiB                          | The extension protocol limit                                           |
| Stored results kept after a run ends       | 7 days                          | Long enough to inspect a run, short for copied CRM data (§6.6)         |
| Shortest `schedule` interval               | 15 minutes                      | A routine is not a polling loop                                        |
| Precision of `relative` triggers           | 5 minutes                       | They are found by a periodic scan                                      |
| Depth of routines triggering each other    | 8 hops                          | The existing cause-chain cap                                           |

A self-hosted operator can change the daily model cap
(`RETAINER_ROUTINE_MODEL_CALLS_PER_DAY`).

## 5. Building a routine from free text

### 5.1 Two builders, one contract

- **The built-in builder.** The web app has a text box. Submitting it queues a
  job in the sandbox that reads the workspace's capabilities, calls the model
  through the proxy and saves a proposal. This is the pattern `configure`
  already uses to suggest a field mapping during an extension install: code
  with read-only access and model access prepares something for a person to
  review. Each submission counts against the daily model cap (§4.6).
- **The person's own agent.** Any agent connected over MCP can do the same
  with the same calls, from a chat.

Both use only the calls below. Neither can approve.

| Call                       | Returns                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `get_routine_capabilities` | The SDK's types for this workspace, the trigger kinds, the limits, every installed tool with its status, model availability |
| `validate_routine`         | Whether the manifest and the code pass, or a list of errors pointing at the part that failed                                |
| `preview_routine`          | Recent changes the trigger would have matched, and a dry run on a few of them (§5.2)                                        |
| `propose_routine`          | Saves the description, the manifest, the code, a one-sentence summary and the builder's report as a proposal for a person   |

`validate_routine` and `preview_routine` start a job in the sandbox and
return its result, or an ID to poll when it takes longer than a request may
(§8.3).

```mermaid
sequenceDiagram
  participant P as Person
  participant B as Builder agent
  participant R as Retainer
  P->>B: Description in plain words
  B->>R: get_routine_capabilities
  R-->>B: Types, tools and their status, limits
  B->>R: validate_routine (manifest and code)
  R-->>B: Errors, or valid
  B->>R: preview_routine
  R-->>B: Recent matches and a dry run
  B->>R: propose_routine
  R-->>P: Retainer's facts, the summary, the dry run, the builder's report
  P->>R: Approve, or edit the description and try again
```

### 5.2 Honest feedback

The builder's honesty does not rest on the model's good behaviour alone.
Five mechanisms back it:

1. **Capabilities are facts.** The builder gets what exists from Retainer, as
   types: which objects and fields, which are filterable, which tools, whether
   each tool's account is connected, whether a model is available. It does
   not answer from memory.
2. **The check is fixed logic.** Retainer checks the manifest itself, and the
   routine runner type-checks the code against the workspace's types. A
   routine that names a missing object, field or tool, tests a field that is
   not filterable, breaks a limit or passes a value of the wrong type cannot
   be saved.
3. **Every proposal carries a verdict**: `full`, `partial` or `not_possible`.
   A partial or impossible verdict lists each gap: the part of the
   description it concerns, a coded reason, and what would make it possible.
4. **The review says who wrote each part.** The person approves three things,
   each labelled:
   - **Retainer's facts**, generated from the manifest by fixed code: when it
     fires, the `if`, `oncePerRecord`, the expiry, the tools it may call,
     whether it calls a model, and that it writes as an agent (§6.4).
   - **The builder's summary**, one sentence, marked as written by the
     builder. Retainer does not vouch for it.
   - **The code**, behind a link, with a diff from the active version when
     there is one.
5. **A dry run on real records.** The preview runs the actual code on up to
   five recent records the trigger would have matched, with a token that
   cannot write. It lists every write and send the code tried, in order, and
   what the model answered. It also counts how many recent changes would have
   matched, which is the cost estimate. Two limits, stated on the screen:
   - records are read as they are today, not as they were when they changed;
   - a model can answer differently next time.

Gap reasons are a fixed list, so they can be counted to see what people want
that Retainer cannot do yet:

| Code                      | Meaning                                                            | What would fix it                                 |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `no_source`               | Nothing writes this event into Retainer                            | Install or extend an extension                    |
| `no_tool`                 | No installed extension offers this action                          | Install an extension that does                    |
| `tool_not_connected`      | The tool exists but its workspace account is not connected         | Connect the account                               |
| `member_account`          | A standing routine would act from one member's account             | Make it a button that member presses              |
| `field_not_filterable`    | The `if` tests a field that is not filterable                      | Make the field filterable, or test it in the code |
| `needs_aggregate_trigger` | The routine should fire when a sum or count across records changes | Rephrase as a scheduled check                     |
| `needs_previous_value`    | The condition needs the value a field had before the change        | Not available yet                                 |
| `needs_instant_answer`    | The description needs a reply while someone waits                  | Outside what routines do (§10)                    |
| `needs_blocking`          | The description wants to stop a change from being saved            | Outside what routines do (§10)                    |
| `needs_deletion_trigger`  | The routine should fire when a record is deleted                   | Not in the first version                          |
| `needs_person_rank`       | The routine should replace a value a person set, without review    | Not in the first version (§6.4)                   |
| `model_unavailable`       | The code needs a model call and the server has no model key        | Self-hosted only: the operator sets one           |
| `over_limit`              | The routine would exceed a limit in §4.6                           | Narrow the description                            |
| `unclear`                 | The description can be read more than one way                      | The builder asks, or the person rewrites          |

What this cannot guarantee: the builder can still misunderstand what the
person meant, the summary can be wrong, and code can behave differently on a
record the dry run did not see. The dry run, the test run (§5.3) and the run
history are how a person catches that.

### 5.3 Approval, versions and repair

- A proposal is checked again when it is approved, as a proposed schema
  change is, because the schema may have changed since.
- Only a workspace admin approves. Agents cannot approve through any tool.
- Each approval creates a new version. Editing the description produces a new
  proposal; the active version keeps running until the new one is approved.
  The review shows the difference between the two.
- **Code is checked again when the workspace changes.** A version records a
  fingerprint of the SDK types it was checked against. Before a run, if the
  workspace's types have changed (a schema change, a tool installed or
  removed, a new SDK), the code is type-checked again. If it still passes,
  the new fingerprint is recorded and it runs. If it fails, the routine
  pauses and is marked "needs attention".
- **Repair.** The description is the lasting record of intent. The builder
  can translate it again against the current workspace, and a person approves
  the repaired version. A rewrite never goes live without approval.
- If the approver leaves the workspace or loses the admin role, the routine
  pauses until another admin approves it.
- **Test run.** Before approving, an admin can test the routine on one record
  they choose. Everything runs for real except `send` tools, which only
  report what they would send. The run is marked as a test in the history.
  - Its writes are real, at agent rank like any run. They enter the change
    feed, so other routines and extensions react to them, and some of those
    may send. The confirmation says so before the admin starts it.

## 6. Running a routine

### 6.1 Matching

Routines read the same change feed as extensions, with their own cursor.

- **Their own cursor.** Each routine keeps a durable feed cursor, set to the
  feed's head when it is approved, so it starts from its approval and never
  runs on past events. Extension dispatch cannot carry routines: it
  discovers work per installation (`discoverChanges` in
  `extension-runtime/queue.ts`, called from `worker/changes.ts`), so a
  workspace with a routine and no extension would never be found. Routine
  discovery finds workspaces with an active routine whose cursor is behind
  the head, and works with no installations at all. It runs in the same
  maintenance tick.
- **What the matcher checks.** For each change it finds the active routines
  on that object, then checks the operation (`create`, `update`, or `links`
  for an event routine that watches its links, §4.2), the watched fields, the
  cause chain (§6.5) and whether a `oncePerRecord` routine has already acted
  on the record, and queues a run. It does not check the `if`; the run does,
  when it starts (§4.3).
- **Coalescing.** A run sees the record as it is when the run starts. Rapid
  successive edits to one record fold into one run, as extension change jobs
  already do: a queued, unstarted run for the same routine and record absorbs
  the later change.
- A write that loses on precedence changes nothing, so it triggers nothing.
- **Merges.** A merge is not a trigger. A queued run on the merged-away
  record runs on the survivor, because reads of a merged record return the
  survivor. Its firings and its `oncePerRecord` marks move to the survivor;
  where both records have one, the survivor keeps it, so the merge does not
  fire the routine a second time. `relative` due times are worked out again
  from the survivor's values.
- **Time triggers.** `relative` and `schedule` triggers come from the
  scheduler. A periodic scan finds due records and remembers what it already
  fired (`routine_firings`), so each record fires once per due time.
  - At approval, a `relative` routine applies to existing records whose due
    time is still ahead. Due times already past are not fired.
  - When a record gets a date whose due time has already passed (an
    appointment booked three hours ahead, with a reminder a day before),
    nothing fires by default. A manifest can say `late: "run"`, and then it
    fires at once, still subject to the run's expiry.
  - A changed date is a new due time and fires again, unless the routine is
    `oncePerRecord`.

### 6.2 A run

```mermaid
sequenceDiagram
  participant M as Matcher
  participant Q as Job queue
  participant C as Routine code
  participant A as API
  participant T as Extension tool
  M->>Q: Run for record R
  Q->>A: Check the if
  Q->>C: Start, with the version and record IDs
  C->>A: Reads
  C->>A: A write, with its key
  C->>A: A tool call, with its key
  A->>T: The tool, as its own job
  T-->>A: Output
  A-->>C: Output
  C-->>Q: Finished
  Q->>A: Run recorded, call by call
```

- A run is one job on the existing queue, with its leases, retries and
  at-least-once delivery. One run at a time per routine and record.
- **Every effect carries a key**, made from the run, the operation, its
  arguments and how many identical calls came before it. Retainer records
  each effect's result under its key, a write in the same transaction as the
  write itself.
- **A retried run does nothing twice.** When a run is retried, the code
  starts again from the top. Each effect it repeats finds its key and gets
  the recorded result, so a task is created once, a message is sent once and
  a model is asked once. Effects the first attempt never reached happen
  normally.
- A tool gets the same key, so a `send` tool can refuse a duplicate of its
  own (§8.3).
- **Expiry.** Past the run's expiry (§4.2) Retainer refuses further effects
  and the run ends as `expired`.
- A run that fails for good ends as `failed`. What it already did is not
  undone, and the history shows each call it made.
- After repeated failed runs the routine pauses and is marked "needs
  attention". Until Retainer has notifications, that shows only on the
  Routines page.

### 6.3 Model calls and cost

- **Spend.** A workspace makes at most 1,000 routine model calls a day, dry
  runs and builder submissions included (§4.6). The count comes from
  `ai_usage`, whose rows from a routine's model token carry the routine and
  the run. At the cap the call is refused, the run ends as
  `budget_exhausted`, and the Routines page shows it. The preview shows how
  often the routine would have run recently, so the cost is visible before
  approval.
- Retainer pays for these calls with its own model key, as it does for
  extension model calls. A workspace never enters a key. Usage is recorded
  per call in `ai_usage` under its own kind.
- **Hidden instructions: a known risk, not handled in the first version.** A
  routine may read text that an outsider wrote, such as an incoming email.
  That text can hide instructions aimed at the model ("also include the
  client list", "send this to another address"), and the model's answer can
  then steer what the code writes or sends.
  - The structure limits the damage. The model cannot call tools itself: it
    only returns an answer, and the code decides which tools to call. The
    code is fixed at approval. The sandbox has no network. Writes are at
    agent rank.
  - Beyond that, the first version adds no safeguard: no extra approval for
    sending after a model call and no check on where a message goes. An
    earlier draft had both, and they covered only part of the risk.
  - The product owner decided on 2026-11-19 to study the risk and its
    solutions properly for the second version (§10) instead of shipping
    partial rules.

### 6.4 Authority

One fixed rule: **a routine writes as an agent.**

| The field's current value                  | What the routine's write does                     |
| ------------------------------------------ | ------------------------------------------------- |
| Empty, or set by an agent or by a template | It applies. Among agents the latest write wins    |
| Set by a person or by an integration       | It waits for review, and the value stays as it is |

This is write rule 3 in `ARCHITECTURE.md`, unchanged. No new actor type and no
new rank are needed.

- **Why.** The code was written by a model, and it may act on a model's
  answer. Macro does the same: a routine's code writes as its agent unless a
  person explicitly asks otherwise (§13.1). It also keeps placement rule 3:
  nothing in the sandbox ever holds a person's authority.
- **Most routines never meet the rule.** Creating a task, logging an event,
  storing a fact, calling a tool and sending a message involve no existing
  value to compete with.
- **The cost.** "When an appointment is booked, set the lead's status to
  Booked" changes the status on its own only where no person and no sync set
  it. Otherwise the new status shows in the review inbox for a person to
  accept. The builder reports `needs_person_rank` when a description asks for
  more, and the review says "writes as an agent".
- The actor is of type `agent` and names the routine. Each write also records
  the version that made it. History shows the routine, its version and its
  approver on every value it wrote.
- Manual runs and test runs write the same way. History also names the
  person who started them.
- **Room for later.** A version stores the rank it writes at, and the first
  version accepts only `agent`. A rank equal to a person's, for routines that
  must replace people's values, is the first extension (§10).

### 6.5 Loops and load

- A routine joins the existing cause chain like an installation. A routine is
  never triggered by a change it caused, directly or through others, and
  chains stop at 8 hops.
- Runs count against a per-routine write budget and the workspace's limits,
  as installations do. Excess work waits; it is not dropped.
- **Bulk changes.** A routine that queues more than 200 runs in an hour (a
  bulk import firing every "on create" routine, or a sync touching thousands
  of records) is paused and marked "needs attention". The runs past the limit
  are held, not started: an admin runs or discards them. Nothing is sent for
  the held runs until then.
- **Scheduled sweeps.** A `schedule` tick whose filter matches more than 200
  records queues nothing, pauses the routine and says how many matched. As
  with held runs, an admin can run that tick once, over the cap, or discard
  it; narrowing the filter is the lasting fix.
- `oncePerRecord` (§4.2) stops repeat runs on records that come back to the
  same state.

### 6.6 Stored data

| Table                 | Holds                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `routines`            | Name, description, status (`draft`, `active`, `paused`, `needs_attention`, `archived`), the active version, the feed cursor        |
| `routine_versions`    | The manifest, the code, the summary, the types fingerprint, the rank, the builder's report, who built it, who approved it and when |
| `routine_runs`        | The trigger, record IDs, the status, each call's operation and outcome, held, test or dry-run flags, the cause chain               |
| `routine_run_results` | Each effect's key and result, so a retry can reuse it                                                                              |
| `routine_firings`     | What time triggers already fired, and which records a `oncePerRecord` routine already acted on                                     |

Routines are not records, so they don't appear in views or the change feed.

Run history copies no CRM content except in `routine_run_results`:

- Runs keep IDs, statuses, operation names and error codes, never arguments,
  values or text.
- A write's result is the ID of the record it wrote. A tool's or a model's
  result can hold copied content. Results are kept while the run may still be
  retried, then for 7 days so a person can inspect the run, then deleted.
- Code can read any record, and Retainer does not track reads, so it cannot
  know which records a stored result drew on. `forget` therefore deletes
  every stored tool and model result in the workspace, in the same deletion,
  and advances the fence of each in-flight run. A retry with the old fence
  cannot write a result back; the run ends as `erased`. This is how
  `ARCHITECTURE.md` §2.1 already treats jobs: they carry IDs only and must
  not resurrect deleted content. `forget` is rare and admin-only and results
  live 7 days at most, so losing some inspection history is the accepted
  price.

## 7. What routines share with extensions

A routine is not an extension. It has no release, no install and no secrets,
and its code is written inside the workspace, not published by Tamloot. But a
routine's run is the same kind of work as an extension's run, so it uses the
same machinery.

```mermaid
flowchart TB
  subgraph Author["How it is defined"]
    MAN["Extension: a manifest and code, built by Tamloot"]
    DESC["Routine: a description, translated to a manifest and code"]
  end
  subgraph Own["Their own parts"]
    INST["Installation control: releases, grants, settings, secrets"]
    RSTORE["Routine store: versions, manifest checker, approval"]
  end
  subgraph Shared["Shared machinery, exists today"]
    FEED[("Change feed")]
    SCHED["Scheduler"]
    Q[("Job queue, leases, retries")]
    EXEC["Executor and sandbox"]
    TOK["Run tokens"]
    PROXY["Model proxy and usage"]
    CAUSE["Cause chain and throttles"]
    FILT["Record filters"]
  end
  subgraph Code["Code that runs in the sandbox"]
    FN["Extension functions"]
    TOOL["Extension tools (new)"]
    RR["Routine runner and built-in builder (new, first-party)"]
  end
  MAN --> INST
  DESC --> RSTORE
  INST --> Q
  RSTORE --> Q
  FEED --> Q
  SCHED --> Q
  Q --> EXEC
  EXEC --> FN
  EXEC --> TOOL
  EXEC --> RR
  RR -->|"calls, through Retainer"| TOOL
  RR --> PROXY
  FN --> PROXY
```

| Shared piece               | Where it lives today                                              | How routines use it                            | Change needed                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Change feed and dispatcher | `record_changes`, `worker/changes.ts`, `queue.ts`                 | Routine matching in the same tick              | A cursor per routine, set at approval, and discovery that works with no installations (§6.1)                                            |
| Job queue, leases, retries | `extension-runtime/queue.ts`, `worker/extensions.ts`              | Run, check, tool and builder jobs              | A job can belong to a routine run, not only an installation                                                                             |
| Scheduler and cron parsing | `worker`, `packages/extension/src/cron.ts`                        | `schedule` and `relative` triggers             | Schedules created at approval; a workspace time zone setting and zone-aware cron, both new (cron is UTC-only today)                     |
| Executor and sandbox       | `launcher`, `worker/launch-driver.ts`, `packages/runner`          | Runs the routine runner, tools and the builder | The closed kind of run (§3.3); the result carries an optional output (§8.2)                                                             |
| Run tokens                 | `extension-runtime/tokens.ts`, `extension-runtime/credentials.ts` | The routine's and the builder's access         | A token bound to a routine run, at agent rank, limited to the manifest's tools. A dry run uses the existing `read` scope alone          |
| Model proxy and usage      | `model/`, `extensions/usage.ts`                                   | `ai.generate` and the built-in builder         | A model-token kind for routines; `ai_usage` rows name the routine and the run; a narrower list of allowed requests for that kind (§4.5) |
| Cause chain and throttles  | The dispatcher (`extensions.md` §9.4)                             | Loop prevention and budgets                    | A routine can be a member of a chain                                                                                                    |
| Record filters             | `packages/shared/src/api.ts`, `records/query.ts`                  | The `if`, and queries from code                | Field keys resolved to names                                                                                                            |
| Aggregates                 | `records/aggregate.ts`                                            | Sums and counts from code                      | None                                                                                                                                    |
| Propose, then approve      | Schema changes; the two-step install                              | Routine versions; the built-in builder         | None; the same pattern                                                                                                                  |
| Run history screens        | `packages/web/src/routes/extensions`                              | The Routines page                              | Reuse the run list                                                                                                                      |
| `forget`                   | `privacy`                                                         | Clears stored run results                      | Delete stored results and fence in-flight runs (§6.6)                                                                                   |

Not shared: installations, releases, grants, settings, secrets, key-value
storage, webhooks and source imports. A routine holds no secrets and stores
no data of its own beyond its run results.

What each package gains:

| Package              | License | Gains                                                                                                                                                          |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`    | MIT     | The manifest's schema and types, the generator that turns a workspace's schema and tools into SDK types, and the renderer for Retainer's facts                 |
| `packages/sdk`       | MIT     | The routine-facing SDK the code calls, and client methods for routines and for calling a tool                                                                  |
| `packages/extension` | MIT     | `defineTool`, the `tool` trigger, and the run result's optional output                                                                                         |
| `packages/runner`    | MIT     | Tool dispatch, plus two first-party bundles: the routine runner (type-check and run) and the builder                                                           |
| `packages/server`    | AGPL    | A `routines` module (store, manifest checker, effect keys and results), routine discovery and matching, tool invocation in the runtime, new REST and MCP calls |
| `packages/web`       | MIT     | The Routines page: describe, review, approve, runs, held runs; the workspace time zone setting                                                                 |

One thing to avoid, seen in Twenty (§13.2): it has three separate trigger
systems, for workflows, app functions and agents, each with its own queue and
condition format. Here extensions and routines read one feed, share one queue
and use one filter grammar; they keep separate cursors on the feed only
because their work is discovered differently.

## 8. The extension upgrade

Extensions take part in a routine in three places:

- **When.** No change. Whatever an extension writes is a record, and a
  routine can react to it.
- **If.** A read-only tool can answer a question, such as "is this address
  deliverable", for the code to test.
- **Do.** A tool performs an action, such as sending a message.

So the upgrade is one new capability, **tools**, and what it needs around it.

### 8.1 Declaring a tool

A tool is a function with the new `tool` trigger. `extensions.md` §5 already
reserves this as a future kind.

```ts
import { defineTool } from '@retainer/extension';

export const sendWhatsApp = defineTool({
  universalId: '…',
  name: 'send_whatsapp_message',
  title: 'Send a WhatsApp message',
  description: 'Sends one WhatsApp message to a person from the clinic number.',
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
  },
  connection: 'workspace',
  supportsDryRun: true,
  secrets: ['apiToken'],
  scopes: ['read', 'write'],
});
```

| Field                         | Purpose                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `name`, `title`               | How code and people refer to it                                                                            |
| `description`                 | Written for an agent: what it does and when to use it                                                      |
| `effect`                      | `read` (answers a question), `write` (changes Retainer records only) or `send` (acts outside Retainer)     |
| `inputSchema`, `outputSchema` | Checked by Retainer on the way in and out, and turned into the SDK's types                                 |
| `connection`                  | `workspace`, or `member` when the tool uses one person's account; a `member` tool runs only in manual runs |
| `supportsDryRun`              | The tool can say what it would do without doing it, for dry runs and test runs                             |
| `uses`                        | Declares a model call, as functions do today                                                               |

### 8.2 The run result carries an output

Today a function's result is only a status: `succeeded`, `retry` or `failed`.
A tool has to return data, so the protocol v1 result gains an optional
`output`, checked against the tool's `outputSchema` and held to the existing
64 KiB limit. It is an optional field in protocol v1, the way the invocation
gained `model` (`extensions-model-calls.md` §3.2), not a new protocol
version; every bundle is rebuilt with the new schema.

### 8.3 Calling a tool

One runtime call starts a tool and returns a call ID; the caller polls it for
the status and the output. A tool may run for 120 seconds, and the hosted API
answers every request within 30, so the call cannot hold a request open. The
SDK hides the polling: `retainer.tools.<name>(input)` returns the output.
Three kinds of caller use it:

| Caller            | How                                          | When                 |
| ----------------- | -------------------------------------------- | -------------------- |
| A routine         | `retainer.tools.<name>(input)` from its code | With routines        |
| A person          | A button on a record                         | With manual triggers |
| A connected agent | An MCP tool                                  | Later                |

What the platform adds around the call:

- **Approval.** Installing an extension shows the tools it offers. Approving a
  routine shows the tools its manifest lists, and the run token can call no
  others.
- **Whose account.** A standing routine uses `workspace` connections only. A
  `member` tool runs only in a manual run, acting as the person who pressed
  the button, with that person's own connection. The member comes from the
  credential of the person who pressed, never from the caller's payload, and
  Retainer checks again when the queued call executes that the person is
  still a member, the connection is still theirs and live, and the tool is
  still installed. An admin's approval never lets a routine act from another
  member's account, as each member's connection is theirs alone
  (`extensions-tamloot-connect.md` §14, item 2). A member granting a standing
  routine use of their account is deferred.
- **Calls from routine code.** The call gets a deadline that fits in the
  run's remaining time and is not retried by the queue: a failure goes back
  to the code as an error, and the code decides what to do.
- **Duplicates.** Every call carries its effect key (§6.2). Delivery is at
  least once, so a `send` tool must use the key to avoid sending twice.
- **Dry runs.** In a dry run a `read` tool runs. A `write` or `send` tool is
  not called: Retainer reports the call, or the tool's own dry run when it
  supports one.
- **Cause.** The call carries the cause chain, so a tool's writes cannot
  trigger the routine that called it.
- **Its own lane.** Installations run one job at a time by default. Tool
  calls need a separate allowance, or a busy routine would wait behind an
  extension's sync.

### 8.4 What the builder needs from extensions

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

### 8.5 What extensions do not get

- No new trigger kinds for routines. Extensions make something automatable by
  writing it down as a record or a field.
- No way to approve, edit or start a routine on their own.

## 9. Examples

### 9.1 Possible

| Description                                                                                      | How the routine does it                                                                                           |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| "When a deal moves to Proposal, create a task to send the proposal within two days."             | `record` trigger on stage, `oncePerRecord`; the code creates one task                                             |
| "If a lead has had no contact for a week and is still open, create a follow-up task."            | `relative` trigger on `lastContactAt`, an `if`; the code creates one task                                         |
| "When an appointment is booked, set the lead's status to Booked."                                | `record` trigger; the code updates the lead. Waits for review where a person or a sync set the status (§6.4)      |
| "The day before an appointment, send the patient a WhatsApp reminder if they haven't confirmed." | `relative` trigger, an `if`, one tool call; the run expires when the appointment starts                           |
| "Every Monday at 9, create a review task for each deal open longer than 30 days."                | `schedule` trigger with a record filter, one run per deal, up to 200 deals                                        |
| "After a meeting is logged with its transcript, list what people promised and create tasks."     | `record` trigger; the code asks a model for the list and creates a task for each item                             |
| "When an email arrives from a lead, if it reads like a complaint, open an urgent ticket."        | `record` trigger; the code asks a model yes or no and creates the ticket                                          |
| "Every Friday, summarise this week's new leads and post it to Slack."                            | `schedule`; the code queries, asks a model for the summary and calls a tool with a fixed channel                  |
| "When a patient emails a question, answer it."                                                   | `record` trigger; the code asks a model for the reply and calls a send tool. Nobody reviews the text first (§6.3) |
| "If a patient misses a third appointment, flag them for the manager."                            | `record` trigger; the code counts missed appointments and updates the patient                                     |
| "Every morning, if this quarter's won deals pass 100,000, create a task for me."                 | `schedule`; the code sums with `aggregate` and creates the task                                                   |
| "When a deal moves to Won and its company is in Israel, create an onboarding task."              | `record` trigger; the code reads the company and returns early when it does not match                             |
| "When a deal is won, create one onboarding task for each product on it, named after the client." | `record` trigger; the code loops over the products and builds each title                                          |
| "Add a Send quote button on deals."                                                              | `manual` trigger, one tool call                                                                                   |

### 9.2 Possible only with something else in place

The builder reports these as `partial` or `not_possible`, with the reason:

| Description                                                           | What it needs                                                                   | Gap code            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------- |
| "When a call is missed, create a lead."                               | A phone extension that logs missed calls as events                              | `no_source`         |
| "Send a WhatsApp reminder…" with no messaging extension               | An extension that offers a send tool                                            | `no_tool`           |
| "Email the patient from their therapist's Gmail" as a standing rule   | A member granting standing routines their account, deferred. A button works now | `member_account`    |
| "Summarise the transcript…" on a self-hosted server with no model key | The server's operator setting a model key                                       | `model_unavailable` |
| "Set the status to Booked even if someone set it by hand."            | A routine rank equal to a person's, left for later                              | `needs_person_rank` |

### 9.3 Not possible, by design

| Description                                                     | Why not                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| "Don't let anyone save a deal without an amount."               | A routine runs after a change is saved. It cannot refuse one                                 |
| "When a patient opens the booking page, show them free slots."  | A routine answers nobody. It runs in the background, seconds to minutes later                |
| "Book the room and the doctor together, or neither."            | Each write is its own. A failure midway does not undo earlier writes                         |
| "The moment revenue passes 100,000, tell me."                   | Triggers watch one record. A sum can only be checked on a schedule (§9.1)                    |
| "When a deal jumps from Lead straight to Won, alert me."        | A condition sees a field's current value, not the value before the change                    |
| "When a deal is deleted, …"                                     | No `deleted` trigger in the first version                                                    |
| "Check every ten seconds whether…"                              | The shortest schedule is 15 minutes                                                          |
| "Show the secretary a popup when…"                              | A routine changes records and calls tools. It has no effect on screens                       |
| "Look the company up on its website and fill in what you find." | Code has no network. Outside data comes only from an extension's tool                        |
| "Do whatever it takes to win this deal back."                   | The code is fixed at approval. A model call returns an answer and has no tools               |
| "Add a field for…", "Install…", "Create another routine that…"  | A routine cannot change the schema, extensions, members or routines                          |
| "Use my private notes about this client."                       | Runs are workspace-level and cannot read personal memory                                     |
| "Apply this to all last year's meetings."                       | A routine starts from its approval. It does not run on past events                           |
| "Charge the card exactly once, guaranteed."                     | Delivery is at least once. Avoiding a duplicate depends on the tool honouring the call's key |

### 9.4 A worked example

This example is also an acceptance test (§11.2).

The person writes:

> After every meeting with a lead, create tasks for anything we promised, and
> send the lead a thank-you on WhatsApp.

The workspace has the Tamloot extension installed and no messaging extension.
Tamloot logs a meeting first and fills its transcript later. The builder
proposes:

- **Verdict:** `partial`.
- **Gap:** "send the lead a thank-you on WhatsApp" is not covered. Reason:
  `no_tool`. Fix: install a messaging extension that offers a send tool.
- **Summary:** "After a meeting with a lead has its transcript, create a task
  for each thing that was promised."
- **Manifest and code:**

```json
{
  "when": {
    "kind": "record",
    "object": "conversation",
    "on": ["created", "updated", "links"],
    "fields": ["transcript"],
    "oncePerRecord": true
  },
  "if": { "medium": { "eq": "meeting" }, "transcript": { "isNull": false } },
  "uses": { "tools": [], "model": true }
}
```

```ts
export async function main({ retainer, record }: RoutineContext<'conversation'>) {
  const leads = await retainer.person.query({
    filter: { id: { in: record.participants }, status: { eq: 'lead' } },
  });
  if (leads.count === 0) return;

  const { commitments } = await retainer.ai.generate({
    instructions: 'List each thing someone promised in this meeting, who and by when.',
    input: { transcript: record.transcript },
    output: Commitments,
  });

  for (const item of commitments.slice(0, 20)) {
    await retainer.task.create({
      title: item.title,
      dueDate: item.due,
      conversation: record.id,
    });
  }
}
```

Three things in it matter:

- The trigger watches the links as well as the transcript. Tamloot usually
  fills the transcript before a new lead is matched (it logs the event, gets
  the lead back unmatched, the person is created, and the event is logged
  again to link them).
- The code returns before any effect when the meeting has no lead. That costs
  no model call and does not use up the meeting, so it is checked again when
  a lead is matched.
- The model call is the first effect. From then on the meeting is used up,
  and a corrected transcript does not create the tasks again.

What the person reviews:

> **Retainer's facts.** Runs when a meeting is logged, its transcript changes
> or its participants change, and it is a meeting with a transcript. Acts at
> most once per meeting. Calls a model, so meeting content is sent to the
> model provider. Calls no tools and sends nothing. Writes as an agent: its
> values never replace what a person or a sync set without review.
>
> **The builder's summary.** After a meeting with a lead has its transcript,
> create a task for each thing that was promised.
>
> **Dry run on 5 recent meetings.** Three would have created tasks (4, 2 and
> 6 of them, listed). Two stopped because no participant is a lead. 11
> meetings matched in the last 30 days.

The person can approve the partial routine now and add the thank-you later by
editing the description once a messaging extension is installed.

What must happen, case by case:

| Case                                                        | Expected                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A meeting logged with its transcript and a lead             | One run, tasks created as an agent                                                            |
| A meeting logged first, its transcript filled an hour later | Nothing at logging (the `if` fails); one run with tasks when the transcript arrives           |
| The transcript corrected after the tasks were created       | No second run, no duplicate tasks                                                             |
| A meeting with no lead among its participants               | A run that returns before any effect: no model call, no tasks, and the meeting is not used up |
| A lead matched after a run that returned early              | One more run, and tasks are created                                                           |
| A lead matched after a run that created tasks               | No second run                                                                                 |
| A call (medium `call`) with a transcript                    | No run                                                                                        |

## 10. Design limits and what is left for later

Each limit below follows from a choice made above.

| Limit                                                           | Comes from                                                                  |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Routines react after the fact; they cannot block or validate    | They read the change feed, which records committed changes                  |
| No instant answers                                              | Every run goes through the job queue                                        |
| No all-or-nothing across writes                                 | Each write is its own; Retainer has no multi-record transaction for callers |
| Sums and counts only on a schedule, never as a trigger          | Triggers watch one record; code computes aggregates when a run asks         |
| Conditions see current values only                              | The change feed records which fields changed, not their earlier values      |
| No trigger on deletion                                          | A run reads its record, and reads exclude deleted records                   |
| Code reaches nothing but Retainer                               | The closed sandbox. Outside effects come only from reviewed extension tools |
| Retainer cannot say in advance what the code will do            | It is a program. The dry run, the limits and the run history are the check  |
| A routine never replaces a person's value on its own            | It writes as an agent (§6.4)                                                |
| A run must finish in 300 seconds                                | One job per run                                                             |
| Triggers only on what is written down                           | The matcher sees records, not what happens inside other systems             |
| Fast successive edits fold into one run                         | Runs coalesce per routine and record                                        |
| Model answers are bounded and can vary                          | A model gives them; the limits in §4.6 and §6.3 apply                       |
| Hidden instructions in incoming text can steer a model's answer | No safeguard in the first version beyond the structure (§6.3)               |
| Outside actions may repeat on a retry                           | At-least-once delivery, unless the tool honours the call's key              |
| A standing routine cannot act from a member's account           | Each member's connection is theirs alone; only a button they press uses it  |
| Stored results are kept for days, not kept as history           | They copy CRM data, which `forget` must be able to remove                   |
| Failures are visible only on the Routines page for now          | Retainer has no notifications yet                                           |
| The builder can misread intent                                  | A model translates; the dry run and the test run are the check              |
| Nothing for one person only                                     | Routines are workspace-level and admin-approved                             |

Left out of the first version on purpose, with the room left for each:

| Later                                                                                                           | Room left for it now                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A routine rank**, equal to a person's, so a routine can replace people's values                               | A version stores its rank; only `agent` is accepted. It needs a new actor type, a switch only an admin can set and that the builder cannot, and a run token that holds that rank in the sandbox |
| **Safeguards against hidden instructions** in text a routine reads                                              | To be designed for the second version, after a proper study of the risk. Run history already records which runs called a model and which tools they called                                      |
| **Knobs**: values an admin changes without new code, such as a label or a number of days (Macro)                | An optional list in the manifest that the code reads as `knobs`; versions without it are unaffected                                                                                             |
| **An agent with tools**, for open-ended work                                                                    | A further SDK call beside `ai.generate`, handed to the workspace agent the model-calls spec plans (§11 there)                                                                                   |
| **Limits per object**: which objects a routine may write                                                        | `uses` in the manifest grows; the run token already enforces `uses.tools`                                                                                                                       |
| **Long runs and waits**                                                                                         | Effect keys already let a run stop and start again without repeating itself                                                                                                                     |
| Notifications for failures, a `deleted` trigger, previous values in conditions, members granting their accounts | Independent of the format                                                                                                                                                                       |

## 11. Delivery order and rollout (proposed)

### 11.1 Phases

1. **Extension tools.** `defineTool`, the optional
   `output` in protocol v1, the invoke call with its call ID and polling, the
   tool list. It has no caller until phase 3, so it lands before it or with
   it.
2. **The closed sandbox.** The routine runner bundle; a fresh restricted
   process per run; no public egress, hosted and in Compose; the generator
   for the SDK's types; the type-check; the routine run token and its
   read-only form for dry runs.
3. **Routines without model calls.** The manifest and its checker; routine
   discovery with its own cursor, working with no installations; matching for
   `record`, `schedule` and `manual` triggers; `oncePerRecord`; the hourly
   hold and the schedule fan-out cap; the workspace time zone and zone-aware
   cron; runs with effect keys and expiry; the dry run and the test run;
   approval, versions and the re-check when types change; stored results and
   `forget`; runs and history; the MCP calls for a person's own agent; the
   Routines page. Buttons (`manual`) come here, and member tools with them.
4. **The built-in builder.** The free-text box in the web app.
5. **Model calls from code.** `ai.generate`, the daily cap per workspace and
   consent on the review.
6. **More.** `relative` triggers, suggested routines from extensions, then
   the items in §10.

### 11.2 Acceptance tests

Beyond the unit and integration tests every feature needs, these must pass,
each against real Postgres:

- **Phase 2, the sandbox is closed.** Routine code cannot reach a public
  address, read a file or an environment variable, start a process, or see
  anything a previous run left. Code that calls the API directly with a dry
  run's token changes nothing.
- **Phase 3, the first routine.** "When a deal moves to Proposal, create one
  follow-up task", in a workspace with no extensions installed. The run is
  interrupted right after the task is created. The retry leaves exactly one
  task, and its history names the routine and the approved version.
- **A retry mid-loop.** Code that creates ten tasks is stopped after the
  third. The retry ends with exactly ten.
- **Two attempts at once.** Two attempts of the same run executing
  concurrently create each task once. This runs the competing operations
  concurrently, as the testing rules require.
- **Rank.** A routine's write to a field a person set waits for review and
  leaves the value as it was.
- **Expiry.** A reminder whose retries outlast its expiry is never sent late.
- **A schema change.** Removing a field the code uses pauses the routine
  before its next run.
- **`forget` during a run.** Erasing a record removes every stored tool and
  model result in the workspace, and a retry does not restore them.
- **Phase 5, the worked example** (§9.4), all seven cases.

### 11.3 Hosted rollout

- **A new trigger kind.** `tool` is a trigger kind no hosted bundle has used.
  The hosted server refuses a catalog with a kind it does not list
  (`extensionServices` in `extension-control/configuration.ts`), and on
  2026-11-15 that took production down when `connect` was added. A server
  release that accepts `tool` must be live before any bundle declaring a tool
  enters the hosted catalog.
- **Two new first-party bundles.** The routine runner and the builder are new
  bundles. Each needs the cloud repository's steps for a brand-new bundle:
  its Lambda function, the catalog configuration and the release allowlists.
- **A function with no public egress.** Hosted job functions reach any public
  address today, an accepted relaxation for reviewed code (`extensions.md`
  §9.1). The routine runner's function must reach Retainer's API and nothing
  else. That networking lives in the cloud repository.
- **Polling, not waiting.** Tool calls, checks and previews return an ID
  because the hosted API answers within 30 seconds (§8.3).
- **Model usage.** Routine model tokens are a new kind at the `model`
  function; usage rows carry the routine and the run (§6.3).
- **Discovery.** Routine discovery runs where change maintenance runs today,
  with its own budget, so a workspace with many routines cannot delay
  extension dispatch.

## 12. Open questions, answered

Answered by recommendation on 2026-11-19. Each stands unless the product
owner changes it.

| Question                                        | Answer                                                                                                                                                                                     | Why                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does a routine write as?                   | An agent, always, in the first version                                                                                                                                                     | The leanest rule: no new actor type, nothing with a person's authority in the sandbox, and it is Macro's default. A routine rank is the first extension (§10) |
| What runs the code?                             | A fresh restricted process per run, inside a first-party bundle, with network to Retainer's API only. Which runtime is settled by a spike: Deno, as Macro uses, or Node's permission model | The token, the API and the network are the boundary; the runtime only has to start clean and stay closed                                                      |
| Does a retried run repeat itself?               | No. Every effect has a key and its result is recorded                                                                                                                                      | The queue delivers at least once, and the code cannot be trusted to make itself safe to repeat                                                                |
| Can a rewrite go live without approval?         | No, never                                                                                                                                                                                  | Nothing runs without a person's approval. Macro applies some rewrites on its own; here an admin approves every version                                        |
| Can a condition test the value before a change? | Not in the first version. "Changed to" only                                                                                                                                                | The change feed keeps which fields changed, not their earlier values, and fast edits fold into one run                                                        |
| Which model do the builder and the code use?    | One model the operator sets. No choice per workspace                                                                                                                                       | The simplest thing that works. Code never names a model, so the model can change without touching routines                                                    |
| Does a routine need a spend guard?              | Yes: 1,000 routine model calls per workspace per day, dry runs and builder submissions included, counted from `ai_usage`                                                                   | One workspace cap bounds every routine, loop and preview                                                                                                      |
| May a routine send after asking a model?        | Yes, with no extra safeguard in the first version                                                                                                                                          | The product owner's decision: partial rules would cover only part of the risk. It is studied properly for the second version (§6.3, §10)                      |
| Can a standing routine use a member's account?  | No. A member tool runs only in a manual run, as the person who pressed the button                                                                                                          | Each member's connection is theirs alone; an admin cannot lend it out                                                                                         |
| Who may approve a routine?                      | Workspace admins only                                                                                                                                                                      | A routine acts across the whole workspace                                                                                                                     |
| Is there a test run before going live?          | Yes, optional, on one chosen record, by an admin, with `send` tools in dry run                                                                                                             | The dry run shows what the code tries. A test shows the real result, and its writes are real                                                                  |

Decided by the product owner on 2026-11-19:

- **Retainer pays for a routine's model calls and for the builder**, as it
  does for extension model calls. No workspace is ever asked for a model key.
  The daily cap per workspace and the provider-side limit on Retainer's key
  are the caps. On a self-hosted server the operator's key is used, as today.
- **A routine is TypeScript code**, the first version is lean, and it writes
  as an agent (§2).
- **No safeguards against hidden instructions in the first version** beyond
  the structure (§6.3).

## 13. Prior art

This design draws on two products, read from local checkouts on 2026-11-19.
Their code and docs were read; nothing was run. Both projects change quickly,
so a review of this spec should check the pointers below against the current
code before relying on them.

| Product | What it calls this | Local checkout         | Commit read | Commit date |
| ------- | ------------------ | ---------------------- | ----------- | ----------- |
| Macro   | Routines           | `~/Development/macro`  | `be50abb4d` | 2026-11-19  |
| Twenty  | Workflows          | `~/Development/twenty` | `1dd1c249a` | 2026-11-14  |

### 13.1 Macro

Paths are from the root of the Macro repository.

Taken from Macro:

- **The name.**
- **A routine is a structured trigger plus TypeScript that a model writes
  against the product's SDK** (§4). See `crates/routine_program/src/model.rs`,
  `crates/routine_program/src/code_steps.md` and
  `services/agent_harness_service/src/routine_code.rs`.
- **Type-check before saving, against the SDK's declarations, without running
  the code** (§5.2). See `crates/code_execution/src/outbound/deno/check.rs`
  and `crates/scheduled_action/src/domain/code_check.rs`.
- **A fresh restricted process for every run, with the network limited to the
  product's own API**, and the plain statement that those limits steer the
  code while the token and the API are the boundary (§3.3). See
  `crates/code_execution/README.md`.
- **Code writes as an agent by default** (§6.4). Macro's code steps write as
  its agent acting for the owner; writing as the owner needs the person's
  explicit request, which a program cannot make. See `CodeIdentity` in
  `crates/routine_program/src/model.rs` and `crates/scheduled_action/AGENTS.md`.
- **A dry run whose token cannot write**, so code written to get around the
  dry run is still refused (§5.2). See `routine_claims` in
  `services/agent_harness_service/src/routine_code.rs`.
- **A fingerprint of the SDK the code was checked against, and a re-check
  when it changes** (§5.3). See
  `crates/scheduled_action/src/domain/code_upgrade.rs`.
- **The run's time from the trigger, never the clock** (§4.4). See
  `crates/routine_program/src/contract.rs`.
- **A cap on calls of one operation, to stop a loop** (§4.6), and **run
  history that records each call's operation and outcome, never its
  arguments** (§6.6). See `crates/code_execution/README.md` and
  `services/agent_harness_service/src/routine_code.rs`.
- **Drafting from a plain-language description, checked before it is saved**
  (§5). See `crates/scheduled_action/src/domain/drafts.rs` and
  `apps/web/src/features/routines/`.
- **Pausing and repairing a routine when what it depends on changes** (§5.3).
  See `crates/scheduled_action/src/domain/code_upgrade.rs`.
- **Trigger content reaches a model as data, not instructions** (§4.5). See
  `crates/scheduled_action/`.

Done differently on purpose:

- A Macro routine belongs to one user and acts with that user's access. Here
  a routine belongs to the workspace and an admin approves it (§5.3).
- Macro saves some model rewrites of a routine's code without asking. Here
  every version needs an admin's approval (§5.3).
- Macro has no ranking of authors; "as an agent" is a label there. Here it is
  a rank: an agent's value waits for review against a person's (§6.4).
- Macro's code asks a model yes-or-no questions and gets probabilities
  (`macro.ai.decide`), and hands open-ended work to one "Ask AI" agent step.
  Here code asks for a typed answer, and an agent with tools is left for
  later (§4.5, §10).
- Macro shows each code step as a sentence with knobs its owner can change.
  Knobs are left for later; the review shows Retainer's facts, the builder's
  summary and a dry run (§5.2, §10).
- Macro runs do not record a result per effect; a failed step stops the run.
  Here every effect has a key, so a retry repeats nothing (§6.2).
- In Macro a routine's write never starts a routine. Here routines can chain,
  up to 8 hops (§6.5).
- Macro's triggering events are a closed list in code. Here any record
  change can trigger, including what extensions write (§4.2).
- Macro lets a model answer a yes-or-no condition before a run starts. Here
  the `if` is fixed logic and judgment happens in the code (§4.3).
- Third parties cannot add triggers or actions to Macro. Here extensions
  publish tools (§8).

### 13.2 Twenty

Paths are under `packages/` in the Twenty repository.

Taken from Twenty:

- **A manual trigger that is a button on a record**, for one record or many
  (§4.2). See `twenty-server/src/engine/core-modules/workflow/`.
- **Apps add actions, not trigger types** (§8, §8.5). An app's function can be
  exposed as a workflow action. See
  `twenty-server/src/engine/metadata-modules/logic-function/logic-function.entity.ts`
  and `twenty-sdk/src/sdk/define/workflows/define-workflow.ts`.
- **An agent can build an automation through tools** (§5). See
  `twenty-server/src/modules/workflow/workflow-tools/tools/`.
- **Watched fields plus a record filter on a record-change trigger** (§4.2,
  §4.3). See
  `twenty-server/src/modules/workflow/workflow-trigger/automated-trigger/listeners/workflow-database-event-trigger.listener.ts`.
- **Automations stored in their own tables, not as records** (§6.6). Twenty
  moved its workflows out of ordinary records. See
  `twenty-server/src/engine/core-modules/workflow/entities/workflow.entity.ts`.

Done differently on purpose:

- Twenty has a visual builder and about 20 step types, with branches and
  loops (`twenty-shared/src/workflow/types/WorkflowActionType.ts`). Routines
  have a free-text builder and code (§4).
- Twenty has three trigger systems, for workflows, app functions and agents.
  Routines and extensions share one feed, one queue and one filter grammar
  (§7).
- No loop detection was found in Twenty, only rate limits and a list of
  objects automations may not write
  (`twenty-shared/src/workflow/constants/ObjectsBlockedFromAutomation.ts`).
  Routines use the cause chain (§6.5).
- A Twenty workflow writes with full access and there is no ranking of
  authors
  (`twenty-server/src/modules/workflow/workflow-executor/services/workflow-execution-context.service.ts`).
  Routines write as an agent (§6.4).
- Twenty's docs warn that "record created" fires before the fields are filled
  in (`twenty-docs/user-guide/workflows/`). Here a routine watches the field
  that completes the data and tests it in the `if` (§8.4, §9.4).

Two findings about Twenty were not confirmed beyond a search of the code: that
its webhook trigger's authentication setting is not enforced, and that it has
no loop detection.
