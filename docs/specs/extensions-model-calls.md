# Model calls in extensions

Status: accepted, 2026-11-14; being built, nothing in it has shipped yet.
First written 2026-11-13. Builds on the extension platform in
[extensions.md](extensions.md) and the output mapping and enrichment bundle in
[extensions-company-enrichment-implementation.md](extensions-company-enrichment-implementation.md)
(the enrichment spec). Line references are to `main` at `77d06f1`.

Extension code may call a language model, with Retainer's model key. The
extension is responsible for the call: which model, the prompt, tools,
structured output, effort, streaming, what workspace data goes in and what it
does with the answer. The platform adds two things:

1. **A model proxy** (§3). Extension code uses the official Anthropic SDK as
   it would anywhere, through a client the extension SDK builds for it
   (`modelClient`). The proxy swaps the run token for Retainer's key,
   forwards the request unchanged and records usage. The key never reaches
   extension code.
2. **Mapped-write confidence** (§5), so a write can say it is less certain and
   the workspace's review threshold can hold it.

Suggesting a mapping before the schema is approved is no longer part of this
spec: the `configure` function of
[extensions-configure.md](extensions-configure.md) ships it as an ordinary
read-only run after access approval, and may call the model like other
functions (§6.1). The draft runs first proposed here (§4) are replaced.

v1 is shaped for a later step: a Retainer workspace agent that extensions hand
tasks to instead of writing their own agent code (§11). Nothing in v1 builds
that agent, but the proxy, the client helper, the manifest field and the usage
table are named and placed so it fits without changing existing extensions.

Enrichment (§6) is the first model-backed bundle: its `configure` suggests
the mapping with the model, and its lookup uses the model to pick the right
search result. Those are its choices, not platform rules. Other extensions may
call the model from any function for any purpose.

There are no users yet, so this change keeps no compatibility with existing
releases: every bundle is rebuilt (§3.2).

## 1. Product rule change

Until now, Retainer never called a language model. That rule is dropped for
extensions. The new rule:

> Retainer's core (writes, conflict resolution, search, consolidation) stays
> deterministic and calls no model. Extension code may call a model. No
> embeddings or semantic search: search stays Postgres full-text.

Updated in the commit that accepted this spec. The places that stated the old
rule:

- `CLAUDE.md:50`
- `ARCHITECTURE.md:20`, `:997`, §4.3 (`:1149-1155`), `:1466`, `:2000`, `:2051`
- `README.md:18` and `docs/README.md:9`
- `docs/agents.md:71`
- `docs/specs/extensions.md:23-24` and `:58`
- `docs/specs/extensions-slack.md:15`
- `docs/specs/extensions-company-enrichment-implementation.md:365`
- `docs/specs/accounts-and-access.md:53`
- Code comments in `packages/server/src/worker/index.ts:7` and
  `worker/consolidate.ts:7` stay true (the core calls no model). They were left
  for the first code change of step 2, so this docs commit doesn't deploy.

`docs/specs/schema-events-and-history.md:564` (the consolidator stays
deterministic) is unchanged.

## 2. Decisions

- **The extension owns the call.** The platform doesn't choose the model,
  shape the prompt, constrain the output or limit which data is sent. Bundles
  are reviewed first-party code; the release review is where a call's
  purpose is checked.
- **Where the key lives.** In the server only: `RETAINER_MODEL_API_KEY`. On
  the hosted service only the `model` function holds it (§3.6).
  A key inside a runner Lambda or container would reach every bundle that
  runs there, and usage couldn't be attributed to a workspace reliably.
- **Provider.** Retainer's key is an Anthropic key, so the proxy speaks the
  Anthropic Messages API. An extension that wants another provider can still
  use it with a key the admin enters as an extension secret, as Exa's key is
  today; the proxy isn't involved.
- **SDK.** Bundles call the proxy with the official TypeScript SDK,
  `@anthropic-ai/sdk`, through `modelClient(invocation)` from
  `@retainer/extension` (§3.2). Bundles never write the proxy's URL, so what
  sits behind it can change without a new release. The server needs no model
  SDK: it forwards HTTP.
- **Authority from the run.** Anything Retainer runs on behalf of a run acts
  with that run's access and is recorded as the extension. The proxy runs no
  tools, so in v1 this costs nothing; it is the rule the workspace agent
  (§11) must follow.
- **Anthropic API, not Bedrock.** The hosted service uses Anthropic's API with
  Retainer's key, as self-hosting does.
- **Self-hosting.** The operator may set `RETAINER_MODEL_API_KEY` with their
  own key. Without it, the proxy returns `503 model_unavailable`, and each
  extension decides what to do without a model. Enrichment falls back to its
  current rule (§6.5).
- **Spend.** No spend limit in v1. Usage is recorded per call (§3.4), so a
  limit can be added later without new data (§10).

## 3. Model proxy

### 3.1 Manifest

A function declares what platform capabilities it uses:

```ts
uses: ['model']
```

Like `mappedWrite` and `secrets`, the list is part of the reviewed release
digest. Any function kind may declare `model`, `configure` included, except
webhook verifiers, which have no network. Releases without the field keep their
digests. The list is open for later capabilities (`agent`, `memberAgent`,
§11); adding one to a release is an access change and holds automatic
upgrades.

The claim copies the function's `uses` into its run token, next to its scopes,
so the proxy can check it without the database (§3.6). The token's claims
schema (`extension-runtime/tokens.ts`) is strict; the API and coordinator ship
together, and tokens issued before the deploy are refused once, so those runs
retry.

The install review says, in plain words: "This extension sends data from your
workspace to Anthropic, which Retainer uses to process it." Approving the
release approves that; there's no separate list of which fields or records may
be sent.

### 3.2 Endpoint

The proxy mirrors the Anthropic API paths under its base URL. A bundle gets
its client from the extension SDK:

```ts
import { modelClient } from '@retainer/extension';

const anthropic = modelClient(invocation);
```

`modelClient` returns an `Anthropic` client whose `apiKey` is the run token and
whose `baseURL` is `invocation.modelOrigin` when the invocation has one (the
hosted `model` function, §3.6), otherwise
`${invocation.apiOrigin}/v1/extensions/runtime/model`. `modelOrigin` is a new
optional field of the protocol v1 invocation (`invocationSchema`,
`packages/extension/src/protocol.ts`). The schema is strict, so older runners
reject it: every bundle is rebuilt and published with the new schema, and
installations move to it by automatic upgrade, since nothing they approve
changes. The coordinator sets `modelOrigin` on every hosted invocation.

The SDK sends the run token as `x-api-key`. The proxy:

1. Verifies the token: signature with the run public key, audience, expiry,
   and that its `uses` includes `model`. It doesn't ask the database whether
   the run is still current (§3.6).
2. Replaces `x-api-key` with Retainer's key and forwards the request with its
   body and `anthropic-version`/`anthropic-beta` headers unchanged.
3. Streams the response back as it arrives, including server-sent events.
4. Records usage from the response (§3.4).

Allowed paths:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models` and `GET /v1/models/:id`

Everything else returns `404`. Retainer's Anthropic account is shared by every
workspace, so anything that stores state in the account is refused: the Files,
Skills, Batches, Managed Agents and Admin APIs, and Messages requests that
refer to stored state (a `file_id` source, a `container`, or a `thread`).
Otherwise one workspace's extension could read what another's stored.

Errors the proxy adds, with Anthropic's error body shape so the SDK raises
its usual typed errors:

| Condition                    | Response                      |
| ---------------------------- | ----------------------------- |
| No key configured            | `503`, `model_unavailable`    |
| Token not admitted           | `401`, `authentication_error` |
| Token lacks `uses: model`    | `403`, `permission_error`     |
| Path or stored state refused | `404` or `400`, as above      |

Provider errors (429, 5xx, refusals in the response) pass through unchanged.
The extension handles them, for example by throwing `RetryLater` on a 429.

A request may run until the run's deadline. The proxy's own timeout covers
the longest handler deadline (300 s) plus a margin.

### 3.3 Privacy

- The proxy never logs request or response bodies, and neither do handlers:
  the run list shows codes only, as today.
- Nothing the model saw is stored in Retainer, so erasure has nothing new to
  remove. `ai_usage` holds no content.

### 3.4 Usage

New table `ai_usage`: `kind` (`model` in v1; `agent` later, §11), workspace,
installation, registration, release digest, function ID, run ID, model, input,
output, cache-read and cache-write tokens, created at. No content. One table
for both kinds, so spend limits later read one place.

The proxy reads `usage` from a non-streamed response, or from the stream's
`message_start` and final `message_delta` events. A stream cut off before its
final event records what it saw.

Admins see the month's token use on an extension's Overview tab when its
release uses the model. The operator status page (extensions-lambda.md §3.5)
adds the total per day.

### 3.4.1 Request size

A request body may be at most 6 MB, the Lambda function URL's limit; the
self-hosted proxy applies the same limit. A larger one returns `413` with
Anthropic's error shape (`request_too_large`). Large images or PDFs should be
resized or split; the Files API isn't available (§3.2).

### 3.5 Layering

The proxy is a new server module, `packages/server/src/model/`, at the same
layer as `egress`, and is called only from `extension-runtime`. It joins the
layer list in `ARCHITECTURE.md` §8 and `scripts/check-layers.mjs`. Core modules
(`records`, `schema-engine`, `retrieval`, `worker/consolidate`) must not import
it, and the layer check enforces that. The hosted entry point is
`packages/server/src/lambda/model.ts`.

### 3.6 Hosted placement

On the hosted service the proxy can't live in the `api` function: `api` runs in
the database VPC's private subnets, which have no route to the internet
(`retainer-cloud` `infra/aws/network.tf`), so it can't reach Anthropic. Only
`control` has a way out, through a NAT gateway, for sign-in.

The proxy runs as its own Lambda function, **`model`**, outside the VPC, like
extension job functions:

- **Admission without the database.** It verifies the run token's signature
  with the run public key (`RETAINER_EXTENSION_RUN_PUBLIC_KEY`), its audience
  and expiry, and the `uses` claim (§3.1). It doesn't check that the run is
  still current, so a token for a run that was fenced or cancelled keeps
  working for model calls until it expires, at most five minutes. That costs
  tokens, never data: the proxy can't read or write anything in Retainer.
- **Usage.** After each response finishes, it reports the call's usage to
  the `extensions` function, which writes `ai_usage`:

  ```
  POST /v1/extensions/internal/ai-usage
  Authorization: Bearer <RETAINER_MODEL_USAGE_SECRET>
  {
    id, kind: 'model', workspaceId, installationId, registrationId,
    releaseDigest, functionId, jobId, runId, model,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, at
  }
  ```

  `id` is a UUID the proxy makes per request, and `ai_usage.id` is unique, so
  a repeated report is a no-op (`200`). Workspace and run come from the
  verified token, never from the extension. The secret is compared in constant
  time; a wrong or missing one is `401`. The proxy tries three times with
  backoff before its invocation ends; after that it logs the `id` and the
  counts (no content), and that call goes uncounted.
- **Streaming.** It answers through a Lambda function URL with response
  streaming, set as `modelOrigin` in each invocation. Its timeout covers 300 s
  plus a margin.
- **The key.** `RETAINER_MODEL_API_KEY` is set on this function only (and moves
  to Secrets Manager with the others, `retainer-cloud` issue #19).
- **Traffic.** Model requests leave Lambda directly, not through the NAT
  gateway, so they add no NAT data charges.

Self-hosted Compose serves the same module at
`/v1/extensions/runtime/model/` in the server process, with the same token
checks, and writes `ai_usage` directly.

## 4. Draft runs (replaced)

Draft runs were dropped for installation in two steps
([extensions-configure.md](extensions-configure.md), shipped in #90 and #91).
Mapping suggestions come from the release's `configure` function, an ordinary
read-only run after access approval, which may call the model (§3.1, §6.1).

## 5. Mapped-write confidence

The mapped write (enrichment spec §3.5) gains an optional `confidence`, from
0 to 1, default 1. It is passed to `writeFields` instead of the fixed 1. The
write path already compares confidence with the workspace's review threshold,
so a value below the threshold is held as `pending_review`. The fill-only rule
is unchanged.

## 6. Enrichment

Enrichment's model use, as the first example. Its model is a constant in
`enrichment-contract.ts`, starting with `claude-opus-5-5`; §6.6 says how it
will be revisited.

### 6.1 Configure: mapping suggestion with the model

Today's `configure` (configure spec §8) suggests by API name and type. With
the model, it declares `uses: ['model']` and, after checking the Exa key:

1. Samples up to 20 companies, preferring recently updated ones, and keeps up
   to 5 non-empty values per field whose type an output accepts
   (`compatibleFields`).
2. Calls the model with the outputs (label, definition, accepted types), the
   Company fields (name, label, type) with their sampled values, and the
   current mapping on an upgrade or a request. Structured output: one entry per
   output with `action`, optional `field` and `reason`. Effort `low`.
3. Saves the result through the suggestions endpoint (configure spec §2.2).

Prompt guidance, in short:

- Choose an existing field only when its meaning matches, not just its type.
  A `number` field called `deal_size` is not an employee count; a field called
  `size` holding 12, 340 and 5,000 probably is.
- Prefer a clearly matching existing field over creating one, and `create`
  over a doubtful match.
- On an upgrade or a request, keep current bindings unless they look wrong.

If the proxy returns `model_unavailable` or any error, `configure` falls back
to today's name-and-type suggestions, so the admin always gets some.

### 6.2 Today's lookup

`companyFromSearch` (`packages/runner/src/enrichment-provider.ts:39`) asks Exa
for one result restricted to the domain and accepts it only if its homepage
normalizes to the domain exactly. It misses companies whose site redirects,
whose profile lives under another domain after a rebrand, or whose top result
is a different company on a shared host.

### 6.3 New lookup

1. **Search.** `POST /search` with `query` = `"<company name> <domain>"` (the
   domain alone when the record has no name), `category: 'company'`,
   `numResults: 5` and no `includeDomains`. Contents: text, 4,000 characters,
   as today.
2. **Candidates.** Keep results that carry a company entity. For each, build
   `{ index, url, name, homepage, linkedin, headquarters, workforce, excerpt }`,
   where `excerpt` is the first 1,500 characters of the profile.
3. **Shortcut.** If exactly one candidate's homepage normalizes to the domain,
   and its `Homepage:` line (if any) agrees, accept it without a model call.
   This is today's rule and covers most lookups.
4. **Model pick.** Otherwise, if candidates remain, call the model with the
   record's name, domain and other values of mapped fields, and the
   candidates, marked as untrusted web content. Structured output:
   `{ index: number | null, certainty: 'high' | 'medium' | 'low' }`. Effort
   `low`.
5. **No candidates**, or `index: null`: `no_match`.

Enrichment's own guards on the pick:

- `index` must be one of the candidates sent.
- A pick whose homepage normalizes to the domain is accepted at `high` or
  `medium`.
- A pick on another domain is accepted only at `high`, and only if the
  candidate's name matches the record's name after normalization (case,
  punctuation, legal suffixes such as Inc or Ltd).
- `low` is `no_match`.

The model only picks; the existing value mapping (enrichment spec §4.3)
extracts the values from the chosen candidate.

### 6.4 Confidence

Shortcut or `high` pick: 1. `medium` pick: 0.7 (§5).

### 6.5 Fallback and retries

- `model_unavailable`, a refusal, or output that fails to parse: use only the
  shortcut. Otherwise `no_match` with code `no_match_model_unavailable`.
- A 429 or 5xx from the proxy: `retry`.
- A retry after the model call but before the write would call the model
  again, so the handler stores each pick in installation KV under
  `pick:<recordId>:<domain>` as `{ candidateUrl, certainty, at }`, kept 7
  days. A retry that finds a candidate at the same URL reuses it. Erasure of
  the record deletes the key with the record's other KV references.

New run codes: `matched_shortcut`, `matched_model_high`,
`matched_model_medium`, `no_match_model`, `no_match_model_unavailable`.

### 6.6 Cost and model choice

Per lookup that needs the model, about 4,000 input tokens and up to 1,000
output tokens. At `claude-opus-5-5` prices ($4 input, $20 output per million
tokens) that's at most about $0.04, on top of Exa's $0.008. The shortcut
avoids the call for most lookups.

A fixed set of about 50 real domains with known answers, including redirects,
rebrands and shared hosts, is run against the real model before each prompt
or model change, recording accuracy and cost. Picking from five candidates is
a small task, so the first run compares `claude-opus-5-5` with
`claude-haiku-5-5`, which costs about a fortieth as much, and the bundle keeps
the cheaper one if accuracy holds.

## 7. Tests

- **Proxy (integration, real Postgres):** it refuses tokens without
  `uses: model`, with a bad signature or audience, or expired; the key never
  appears in a response or log; bodies and beta headers pass through
  unchanged; streamed responses stream; refused paths and stored-state
  requests are refused; usage is recorded for plain and streamed responses,
  including concurrent calls; `ai_usage` has no content. Anthropic is faked at
  the HTTP boundary; the database is real.
- **Hosted `model` function:** admission works with no database configured;
  usage reports carry the service credential and are refused without it; a
  repeated report with the same `id` writes one row, including when sent
  concurrently; a failed report is retried; a body over 6 MB returns `413`;
  `modelClient` uses `modelOrigin` when present and the API path otherwise.
- **Claims:** the run token carries the function's `uses`; a release that adds
  `model` is held from automatic upgrade; the invocation schema accepts
  `modelOrigin`.
- **Configure:** a `configure` run with `uses: ['model']` can call the proxy
  with its read-only token.
- **Mapped-write confidence:** a value below the threshold is held as
  `pending_review`; fill-only still holds.
- **Layer check:** core modules importing `model/` fail `pnpm lint`.
- **Enrichment (unit):** the shortcut makes no model call; every guard in
  §6.3; confidence by certainty; fallbacks; KV reuse on retry; the configure
  function's suggestions for a fixture schema.

## 8. Hosted

In `retainer-cloud`: the `model` function outside the VPC, its function URL
with response streaming, `RETAINER_MODEL_API_KEY` on it alone,
`RETAINER_MODEL_USAGE_SECRET` on it and on the `extensions` function, and the
coordinator's `modelOrigin` setting.

## 9. Delivery sequence

1. Docs: the rule updated everywhere in §1, and this spec accepted. Done.
2. Proxy: module, `ai_usage` and its internal usage route, `uses` in the
   manifest and the run token, `modelClient` and `modelOrigin`, the request
   size limit, layer rule. Every bundle rebuilt with the new protocol schema.
   The usage figure on the Overview tab (§3.4).
3. Hosted `model` function (§3.6), with a staging check of streaming.
4. Mapped-write `confidence` (§5).
5. Enrichment release: `configure` suggests the mapping, and the new lookup;
   staging with a real Exa key and the model key, plus the domain set in §6.6.
   (Installation in two steps itself shipped in #90 and #91.)
6. Hosted rollout (§8).

## 10. Later

- **Spend limits.** None in v1. A per-workspace or per-plan limit can be
  checked against `ai_usage` when it's needed.
- **Sharing the rate limit.** Every workspace uses one Anthropic key, so one
  busy workspace can use up the rate limit and others get `429` (passed through;
  extensions retry). If that happens in practice, add a per-workspace limit on
  concurrent model requests in the proxy.
- **The workspace agent** (§11).

## 11. Later: the workspace agent

Retainer will have its own agent: a harness with a system prompt, model choice,
Retainer's tools, and the connections people make (Gmail, calendar), with
Retainer itself as its memory. Extensions will then hand it tasks instead of
writing their own agent code. This section records what's decided so v1 doesn't
work against it; the agent gets its own spec when it's built.

Decided:

- **Harness: Mastra**, used as a library. Only its Apache-2.0 core: agents,
  tools, workflows and the MCP client for connections. No code from `ee/`
  folders, which needs a paid license in production (RBAC, fine-grained
  authorization, Agent Builder, Studio sign-in with a third-party provider);
  Retainer has its own sign-in, permissions and run access. Mastra's own
  memory and storage aren't used: Retainer is the memory, and step state is
  saved through Retainer's API.
- **No Anthropic Managed Agents, no Bedrock AgentCore, no Lambda durable
  functions.** Self-hosting must run the same code.
- **Model: the Anthropic API** with Retainer's key, through the `model`
  function, so the key stays in one place and agent usage lands in `ai_usage`
  with `kind: 'agent'`.
- **Where it runs: a new `agent` Lambda function outside the database VPC**, like
  extension functions; the worker container on self-hosted Compose. It reaches
  jobs and records only through Retainer's API, with a task token. Chosen over
  running it inside the VPC behind `control`'s NAT gateway: the API enforces the
  run's access instead of our code having to, and a function that reads outside
  content (email, web pages) has no path to the database. Given up: control over
  where the agent sends data, since outbound connections from outside the VPC
  can't be restricted or logged.
- **Tasks as jobs.** Each agent task runs as a series of short jobs on the
  Postgres queue, saving state after each model turn or tool call, so no step
  nears Lambda's limit. An extension starts a task and its run ends; when the
  task finishes, a child job resumes the extension with the answer.

Rules it must follow:

1. **Harness from the agent, authority from the run.** The agent brings its
   prompt, tools and connections; its Retainer actions use the run's access
   (read-only in `configure`) and are recorded as the extension.
2. **Workspace agent or member agent.** A workspace agent fits the
   installation's access approval (`uses: ['agent']`). A person's agent, with
   their Gmail, follows the member connection model: each person connects
   theirs, with consent (`uses: ['memberAgent']`).
3. **Tasks are asynchronous**, so the 300 s run limit doesn't apply to agent
   work.

What v1 already provides for it: `modelClient` (an `agentClient` joins it), the
open `uses` list, `ai_usage` with `kind`, and the authority rule (§2).
