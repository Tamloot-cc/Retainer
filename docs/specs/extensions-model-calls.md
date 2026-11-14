# Model calls in extensions

Status: accepted, 2026-11-14, and revised the same day after a review against
the code (§12). PR 1 (the platform, §9) shipped in #92. PR 2 (the enrichment
release) is built; §6.7 records what it chose where this spec was silent.
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
   (`modelClient`). The proxy checks the run's model token, swaps in
   Retainer's key, forwards the request and records usage. The key never
   reaches extension code.
2. **Mapped-write confidence** (§5), so a write can say it is less certain and
   the workspace's review threshold can hold it.

Suggesting a mapping before the schema is approved is no longer part of this
spec: the `configure` function of
[extensions-configure.md](extensions-configure.md) (the configure spec) ships
it as an ordinary read-only run after access approval, and may call the model
like other functions (§6.1). The draft runs first proposed here (§4) are
replaced.

v1 is shaped for a later step: a Retainer workspace agent that extensions hand
tasks to instead of writing their own agent code (§11). Nothing in v1 builds
that agent, but the proxy, the model token, the client helper, the manifest
field and the usage table are named and placed so it fits.

Enrichment (§6) is the first model-backed bundle: its `configure` suggests
the mapping with the model, and its lookup uses the model to pick the right
search result. Those are its choices, not platform rules. Other extensions may
call the model from any function for any purpose.

There are no users yet, so this change keeps no compatibility with existing
releases, installations or tokens: every bundle is rebuilt (§3.2), and nothing
here is shaped around old ones.

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
  for PR 1 (§9), so this docs commit doesn't deploy.

`docs/specs/schema-events-and-history.md:564` (the consolidator stays
deterministic) is unchanged.

## 2. Decisions

- **The extension owns the call.** The platform doesn't choose the model,
  shape the prompt, constrain the output or limit which data is sent. Bundles
  are reviewed first-party code; the release review is where a call's
  purpose is checked. The one limit: the proxy refuses requests that could
  reach anything stored in Retainer's Anthropic account (§3.2.1).
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
- **Model use is granted.** `uses: ['model']` is access an admin approves and
  the installation stores, like scopes (§3.1). A run can call the model only
  when its function declares it and the grant includes it.
- **A token for the model only.** The proxy is reached with a model token,
  minted next to the run token and good for model calls alone (§3.2). The
  proxy sits on a public URL when hosted, so it never holds a credential that
  can read or write a workspace.
- **Authority from the run.** Anything Retainer runs on behalf of a run acts
  with that run's access and is recorded as the extension. The proxy runs no
  tools, so in v1 this costs nothing; it is the rule the workspace agent
  (§11) must follow.
- **Anthropic API, not Bedrock.** The hosted service uses Anthropic's API with
  Retainer's key, as self-hosting does.
- **Self-hosting.** The operator may set `RETAINER_MODEL_API_KEY` with their
  own key. Without it, the proxy returns `503 model_unavailable`, and each
  extension decides what to do without a model. Enrichment ends the lookup
  without a match (§6.5).
- **Spend.** No spend limit in Retainer in v1. Usage is recorded per call with
  the provider's whole usage object (§3.4), so a limit can be added later
  without new data (§10). Until then the hosted key sits in its own Anthropic
  workspace with a monthly spend limit set in the Console (§8).

## 3. Model proxy

### 3.1 Manifest and grant

A function declares what platform capabilities it uses:

```ts
uses: ['model']
```

Like `mappedWrite` and `secrets`, the list is part of the reviewed release
digest. Any function kind may declare `model`, `configure` included, except
webhook verifiers, which have no network. A release's uses are the union of
its functions'. The list is open for later capabilities (`agent`,
`memberAgent`, §11).

Model use is access, so an admin approves it and the installation stores it:

- **Stored.** `extension_installations.granted_uses`, next to `granted_scopes`,
  and `uses` on `extension_access_approvals` (configure spec §6.1).
- **Shown.** The access preview (configure spec §4.1) lists the release's uses
  with its scopes, actor and secrets, and its plan digest covers them. For
  `model` it says, in plain words: "This extension sends data from your
  workspace to Anthropic, which Retainer uses to process it." There's no
  separate list of which fields or records may be sent.
- **Granted at access approval.** Committing the access approval grants the
  release's uses in full, so `configure` can call the model before the mapping
  is reviewed. A release without `configure` grants them in its single
  approval.
- **Per run.** A run gets a capability only when its function declares it and
  the grant includes it, the rule scopes already follow
  (`extension-runtime/queue.ts:1023`).
- **Upgrades.** The access check before a reviewed upgrade (configure spec
  §5.2) compares uses along with actor, scopes and secrets. A release that
  uses more needs the new access approved first (configure spec §5.3), and a
  `configure` job pinned to the target release runs with the target
  approval's uses.
- **Automatic upgrades.** A release that adds a use differs in its contract,
  so the automatic upgrade pass already holds it (`releaseContract`,
  `extensions/auto-upgrade.ts`). No new rule is needed.

### 3.2 Endpoint

**Model token.** When a run has `model` (declared and granted), the
coordinator mints a model token next to the run token, signed with the same
key:

- Audience `retainer:extension-model`. Run tokens have
  `retainer:extension-run`, so the Retainer API refuses a model token and the
  proxy refuses a run token.
- Claims: `kind: 'model'`, workspace, installation, registration, release
  digest, function, job and attempt.
- Expiry as for the run token: five minutes or the run's deadline, whichever
  comes first.

It opens model calls and nothing else. The run token's claims
(`extension-runtime/tokens.ts`) don't change.

**Invocation.** The protocol v1 invocation (`invocationSchema`,
`packages/extension/src/protocol.ts`) gains one optional field, present only
for those runs:

```ts
model: { origin: string, token: string }
```

`origin` is the proxy's base URL: the hosted `model` function's URL (§3.6), or
`${apiOrigin}/v1/extensions/runtime/model` on self-hosted Compose. Every
bundle is rebuilt and published with the new schema. A later capability adds
its own field the same way (§11).

**Client.** A bundle gets its client from the extension SDK:

```ts
import { modelClient } from '@retainer/extension';

const anthropic = modelClient(invocation);
```

`modelClient` returns an `Anthropic` client whose `baseURL` is
`invocation.model.origin`, whose `apiKey` is the model token, and whose
`timeout` is the time left until `invocation.deadline`: the SDK's default is
ten minutes, far past any run. Retries stay at the SDK's default of two. It
throws when the invocation has no `model`, which means the function didn't
declare it or the grant doesn't include it.

**Proxy.** It mirrors the Anthropic API paths under its base URL. The SDK
sends the model token as its key: `x-api-key`, or `Authorization: Bearer` in
SDK 1.x; the proxy reads either and forwards neither. The proxy:

1. Verifies the token: signature with the run public key, audience and
   expiry. It doesn't ask the database whether the run is still current
   (§3.6).
2. Checks the request against the allow-lists (§3.2.1).
3. Replaces `x-api-key` with Retainer's key and forwards the request with its
   body and `anthropic-version`/`anthropic-beta` headers unchanged. No other
   request header is forwarded.
4. Streams the response back as it arrives, including server-sent events,
   with Anthropic's `request-id` and `retry-after` headers.
5. Records usage from the response (§3.4).

If the extension's connection closes before the response ends, the proxy
aborts its request to Anthropic, so generation stops being billed, and records
what it saw as partial (§3.4). §3.6 says where the hosted function may not be
able to.

A request may run until the run's deadline. The proxy's own timeout covers
the longest handler deadline (300 s) plus a margin, and never runs past the
model token's expiry, which is at or before that deadline.

### 3.2.1 Allowed requests

Retainer's Anthropic account is shared by every workspace, so a request must
not reach anything stored in the account: otherwise one workspace's extension
could read what another's stored. A list of refused fields would always be
behind the API, which already has several ways in (files, containers, threads,
user profiles, cache diagnostics) and adds more. So the proxy allows what it
knows and refuses the rest:

- **Paths.** `POST /v1/messages`, `POST /v1/messages/count_tokens`,
  `GET /v1/models` and `GET /v1/models/:id`. Everything else returns `404`,
  which covers the Files, Skills, Batches, Managed Agents and Admin APIs.
- **Top-level body fields** of the two Messages paths: `model`, `messages`,
  `system`, `max_tokens`, `stream`, `stop_sequences`, `metadata`, `tools`,
  `tool_choice`, `thinking`, `output_config`, `cache_control`,
  `context_management`, `mcp_servers`, `fallbacks`, `speed` and
  `inference_geo`. `container`, `thread` and `diagnostics` aren't on the list,
  and neither is anything newer.
- **Content.** No content block, at any depth, may have a `source` of type
  `file`.
- **Beta flags.** Each value of `anthropic-beta` must be on a list. It starts
  with flags for features that keep nothing in the account:
  `compact-2026-01-12`, `context-management-2025-06-27`,
  `server-side-fallback-2026-07-01`, `task-budgets-2026-03-13` and
  `mcp-client-2025-11-20`.

A refused field, content block or flag returns `400` naming it. Both lists
live in one file of `packages/server/src/model/`, and adding an entry is a
server change with a test. The cost is that an extension can't use a new API
field or beta until the server allows it. That's the safe direction, and it's
the one place the platform limits the call (§2).

Errors the proxy adds, with Anthropic's error body shape so the SDK raises
its usual typed errors:

| Condition                           | Response                       |
| ----------------------------------- | ------------------------------ |
| No key configured                   | `503`, `model_unavailable`     |
| Token missing, invalid or expired   | `401`, `authentication_error`  |
| Path not allowed                    | `404`, `not_found_error`       |
| Field, content or beta flag refused | `400`, `invalid_request_error` |
| Body over 6 MB (§3.4.1)             | `413`, `request_too_large`     |

Provider errors (429, 5xx, refusals in the response) pass through unchanged.
The extension handles them, for example by throwing `RetryLater` on a 429.

### 3.3 Privacy

- The proxy never logs request or response bodies, and neither do handlers:
  the run list shows codes only, as today.
- Nothing the model saw is stored in Retainer, so erasure has nothing new to
  remove. `ai_usage` holds no content.

### 3.4 Usage

New table `ai_usage`, one row per request Anthropic answered:

- `id`: a UUID the proxy makes per request.
- `kind`: from the token. `model` in v1; `agent` later (§11).
- From the token, never from the extension: workspace, installation,
  registration, release digest, function ID, job ID and attempt.
- `model`: the model named in the response. It can differ from the one
  requested, for example after a refusal fallback (§6.5).
- Input, output, cache-read and cache-write tokens.
- `usage`: the response's whole `usage` object, as jsonb. It holds counts and
  short labels only: server tool requests, speed, cache writes by lifetime,
  and the split by model when more than one answered. A price needs these, and
  the four token columns don't carry them.
- `provider_request_id`: Anthropic's `request-id`, to reconcile with
  Anthropic's own usage reports.
- `partial`: true when the stream ended before its final event.
- Created at.

No content. One table for both kinds, so spend limits later read one place.
Rows reference the workspace only, with no foreign key to the installation, so
a month's use and later limits survive an uninstall and reinstall. They are
deleted with the workspace.

The proxy reads `usage` from a non-streamed response, or from the stream's
`message_start` and final `message_delta` events. A stream cut off before its
final event records what it saw, with `partial` set; its output count is then
too low, because the final count arrives in the last event. A request
Anthropic rejects records nothing.

Admins see the month's token use on an extension's Overview tab when its
release uses the model (`GET /v1/extensions/:id/usage`). The operator gets the
total per day from `retainer model usage [--days <n>]`, which the hosted
service runs through the `ops` function's `cli` command.

### 3.4.1 Request size

A request body may be at most 6 MB, the Lambda function URL's limit; the
self-hosted proxy applies the same limit. A larger one returns `413` with
Anthropic's error shape (`request_too_large`). Large images or PDFs should be
resized or split; the Files API isn't available (§3.2.1).

### 3.5 Layering

The proxy is a new server module, `packages/server/src/model/`, at the same
layer as `egress`. Only the modules that mount it, report on it or start it
(`api`, `extension-control`, `operator`, `lambda`) may import it; the model
token it checks is minted in `extension-runtime`. It joins the layer list in
`ARCHITECTURE.md` §8 and `scripts/check-layers.mjs`. Core modules (`records`,
`schema-engine`, `retrieval`, `worker/consolidate`) must not import it, and the
layer check enforces that. The hosted entry point is
`packages/server/src/lambda/model.ts`.

### 3.6 Hosted placement

On the hosted service the proxy can't live in the `api` function: `api` runs in
the database VPC's private subnets, which have no route to the internet
(`retainer-cloud` `infra/aws/network.tf`), so it can't reach Anthropic. Only
`control` has a way out, through a NAT gateway, for sign-in.

The proxy runs as its own Lambda function, **`model`**, outside the VPC, like
extension job functions:

- **Admission without the database.** It verifies the model token's signature
  with the run public key (`RETAINER_EXTENSION_RUN_PUBLIC_KEY`), its audience
  and expiry. It doesn't check that the run is still current, so a token for a
  run that was fenced or cancelled keeps working until it expires, at most
  five minutes. That costs tokens, never data: a model token opens nothing in
  Retainer.
- **Usage.** After each response finishes, it reports the call's usage to
  the `extensions` function, which writes `ai_usage`:

  ```
  POST /v1/extensions/internal/ai-usage
  Authorization: Bearer <RETAINER_MODEL_USAGE_SECRET>
  {
    id, token, model, providerRequestId, partial,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, usage, at
  }
  ```

  `token` is the model token the request carried. The `extensions` function
  verifies its signature and audience itself and takes the kind, workspace,
  installation, registration, release, function, job and attempt from its
  claims, never from the body. It accepts a token up to 15 minutes past its
  expiry, because a report follows a response that may outlast the token.

  The secret shows that the proxy sent the report: extension code holds the
  token too. It is compared in constant time, and a wrong or missing one is
  `401`. Neither is enough alone, so a leaked secret can't add usage to a
  workspace without a token minted for it.

  The route is mounted outside the `/v1` caller chain, like webhook ingress:
  it has no workspace caller for the per-workspace rate limit to count
  (`extension-control/app.ts:43`). The proxy calls the public API origin, so
  the request passes the edge like any other.

  `ai_usage.id` is unique, so a repeated report is a no-op (`200`). The proxy
  tries three times with backoff before its invocation ends; after that it
  logs the `id` and the counts (no content), and that call goes uncounted.
- **Streaming.** It answers through a Lambda function URL with response
  streaming, set as `model.origin` in each invocation that has the field. Its
  timeout covers 300 s plus a margin.
- **Disconnects.** If a function URL doesn't tell the function that its
  caller went away, the proxy can't abort the request to Anthropic there: the
  call runs to its end and is recorded whole. The staging check in step 3
  (§9) finds out which it is.
- **Concurrency.** The function URL is public, with no edge in front of it,
  and each call holds one execution for up to 300 s. `model` gets reserved
  concurrency, so a large backfill or junk traffic can't take executions from
  `api`. Above it Lambda answers `429`, which the SDK retries and extensions
  treat as a provider `429`.
- **The key.** `RETAINER_MODEL_API_KEY` is set on this function only (and moves
  to Secrets Manager with the others, `retainer-cloud` issue #19). The
  function refuses to start without it, so `model_unavailable` can't happen on
  the hosted service: a broken deploy shows as a 5xx, and runs retry.
- **Traffic.** Model requests leave Lambda directly, not through the NAT
  gateway, so they add no NAT data charges.

Self-hosted Compose serves the same module at
`/v1/extensions/runtime/model/` in the server process, outside the run-token
caller chain, with the same token checks, and writes `ai_usage` directly.

## 4. Draft runs (replaced)

Draft runs were dropped for installation in two steps
([extensions-configure.md](extensions-configure.md), shipped in #90 and #91).
Mapping suggestions come from the release's `configure` function, an ordinary
read-only run after access approval, which may call the model (§3.1, §6.1).

## 5. Mapped-write confidence

The mapped write (enrichment spec §3.5) gains an optional `confidence`, from
0 to 1, default 1. It is passed to `writeFields` instead of the fixed 1
(`extensions/mapped-write.ts:145`). Three rules:

- **Agent actors only.** Review by confidence belongs to agent writes:
  `reviewReason` returns nothing for any other actor
  (`records/winner.ts:60`). So the mapped write refuses a `confidence` below 1
  from an installation whose granted actor is `integration`
  (`422 validation_failed`), rather than accept a number that does nothing.
- **Threshold.** A value below the workspace's confidence threshold is held as
  `pending_review`. The default threshold is 0.5
  (`records/service.ts:71`); a workspace can raise it.
- **Held values and fill-only.** A held value isn't in `records.data`, so the
  fill-only check alone would see the field as empty, and a later run would
  add a second pending assertion (`writeFields` inserts one per call). The
  mapped write therefore also skips an output whose field has a pending
  assertion from this installation, and reports it as `pending_review`.
  Otherwise the fill-only rule is unchanged.

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
   This is today's rule; §6.6 measures how many lookups it settles under the
   new search.
4. **Model pick.** Otherwise, if candidates remain, call the model with the
   record's name, domain and other values of mapped fields, and the
   candidates, marked as untrusted web content. Structured output:
   `{ index: number | null, certainty: 'high' | 'medium' | 'low' }`. Effort
   `low`, and `max_tokens` 4,000: Opus 5.5 always thinks, and thinking counts
   against the limit.
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

With the default threshold of 0.5 a `medium` pick is applied without review. A
workspace that raised its threshold above 0.7 gets it as `pending_review`.
That is intended: a `medium` pick is always on the record's own domain, since
a pick on another domain needs `high`.

### 6.5 Fallback and retries

The model step runs only after the shortcut found nothing, so a failure there
either ends the lookup without a match or retries it:

| What happened                                       | Result                                   |
| --------------------------------------------------- | ---------------------------------------- |
| `503 model_unavailable` (self-hosted, no key)       | `no_match`, `no_match_model_unavailable` |
| A refusal, after any fallback                       | `no_match`, `no_match_model_refused`     |
| Output cut off at `max_tokens`, or failing to parse | `no_match`, `no_match_model_output`      |
| A 429 or 5xx, after the SDK's own retries           | `retry`                                  |

**Refusals.** Opus 5.5's safety classifiers can refuse a request because of
what a company does (security, biotech), and such companies would then never
match. The call sets `fallbacks: 'default'` with the beta flag
`server-side-fallback-2026-07-01`, so Anthropic runs a refused request again
on another model inside the same call. The proxy records the model that
answered (§3.4). Haiku 5.5 has no server-side fallback, which the comparison
in §6.6 has to count.

**Retries.** A retry after the model call but before the write would call the
model again, so the handler stores each pick in installation KV under
`pick:<recordId>:<domain>` as `{ candidateUrl, certainty, at }`. A retry that
finds a candidate at the same URL reuses it. KV has no expiry, so the handler
ignores a pick older than 7 days and overwrites it with the next one; until
then one small row per model-picked company stays. Erasure of the record
deletes the key, as it does every key that names an erased record
(`privacy/extension-erasure.ts:70`).

New run codes: `matched_shortcut`, `matched_model_high`,
`matched_model_medium`, `no_match_model`, `no_match_model_unavailable`,
`no_match_model_refused`, `no_match_model_output`.

### 6.6 Cost and model choice

Per lookup that needs the model, about 4,000 input tokens. Output is harder to
guess, because Opus 5.5 always thinks and thinking is billed as output, so the
first run of the domain set measures it. If it stays under 1,000 tokens, a
lookup costs at most about $0.04 at `claude-opus-5-5` prices ($4 input, $20
output per million tokens), on top of Exa's $0.008.

A fixed set of about 50 real domains with known answers is run against the
real model before each prompt or model change. It includes redirects,
rebrands, shared hosts, and security and biotech companies (§6.5). Each run
records accuracy, cost, refusals and how many lookups the shortcut settled.

The new search drops `includeDomains` for every lookup, not only the ones
that reach the model. So the first run also puts today's lookup (§6.2)
through the same set: a company that matches today must still match.

Picking from five candidates is a small task, so the first run compares
`claude-opus-5-5` with `claude-haiku-5-5`, which costs about a fortieth as
much, and the bundle keeps the cheaper one if accuracy holds.

### 6.7 As built (PR 2)

Choices the enrichment release made where §6 left them open:

- **Trigger.** `enrich` still watches only the domain. The search and the
  guard on another domain use the company's name, so a company created
  without a name and named later isn't looked up again until its domain
  changes. Watching the base name field too was tried and dropped: that field
  isn't protected, a workspace can delete it once another field is the label,
  and a trigger on a deleted field makes every dispatch pass fail with
  `schema_binding_conflict` (`extension-runtime/queue.ts`), which would stop
  enrichment in that workspace. Watching the name needs a server change that
  lets a trigger skip a field that no longer exists.
- **Which functions use the model.** `configure`, `enrich` and `backfill`
  declare `uses: ['model']`; `setup` doesn't. Backfill runs the same lookup as
  `enrich`, so it gets the same shortcut, model pick, guards and confidence.
- **Timeouts and pages.** `configure` and `enrich` have 120 s, `backfill`
  300 s with pages of 10 companies instead of 20, since each company may need a
  search and a model call.
- **Exa consent.** The search now sends the company's name with its domain,
  so the `shareDomains` consent says so. A lookup asks for five results with
  text, about $0.012 at Exa's list prices. The key check falls back to a
  one-result search without contents.
- **"On the domain."** The shortcut keeps today's rule: the result's URL
  normalizes to the domain and any `Homepage:` line agrees. For the guards, a
  pick is on the domain when its `Homepage:` line, or its URL when the profile
  has none, normalizes to the domain, so a redirected site whose profile names
  the record's domain counts as on it.
- **Name matching.** Lower case, accents and punctuation dropped (`S.A.` reads
  as `SA`), `&` read as "and", and trailing legal suffixes removed (Inc, Ltd,
  LLC, GmbH, SA, PLC and similar).
- **Run codes.** A written match reports how it matched (`matched_shortcut`,
  `matched_model_high`, `matched_model_medium`) in place of `applied`; a
  skipped write still reports the mapped write's reason. No candidates is
  `no_match`; `index: null`, a `low` pick or a pick the guards refuse is
  `no_match_model`; an index that wasn't sent is `no_match_model_output`.
  Configure without a usable model answer reports
  `suggestions_ready_without_model`.
- **Other model errors.** A 429 retries as `model_rate_limited`; a 5xx or a
  lost connection as `model_unavailable`, both with Anthropic's `retry-after`
  or 30 s. Any other 4xx (the proxy refused the request) fails the run as
  `model_request_failed`, a bundle bug that a retry wouldn't fix.
- **Stored picks.** Only a pick the guards accept is stored: a refused one
  ends the run, so no retry reads it. Once the mapped write returns (or there
  are no usable values), the run clears the pick to `{}`, since installation
  KV is capped at 1 MiB and runs can't delete a key; otherwise picks would
  fill it and every later model lookup would fail with `quota_exceeded`.
  Storing and clearing are best-effort: a full quota, a concurrent run's
  write or an outage only costs a retry its reuse. A key longer than KV's 200
  characters (a very long domain) isn't stored. The 7-day limit still guards
  a pick whose run never finished.
- **Configure.** Samples are the 20 most recently updated companies; a value
  longer than 500 characters as JSON isn't sampled. A model choice the schema
  can't take (an incompatible or missing field, or Create for an output with
  no suggested field) keeps the name-and-type suggestion for that output.
  Reasons are cut to 500 characters.

## 7. Tests

- **Proxy (integration, real Postgres):** it refuses a model token with a bad
  signature or audience, or expired, and it refuses a run token; the key never
  appears in a response or log; bodies and allowed beta headers pass through
  unchanged, and no other request header does; streamed responses stream; a
  closed connection aborts the request to Anthropic and records a partial
  row; usage is recorded for plain and streamed responses, including
  concurrent calls, with the response's model, the whole `usage` object and
  the provider request ID; `ai_usage` has no content. Anthropic is faked at
  the HTTP boundary; the database is real.
- **Allowed requests:** each refused path returns `404`; a body with
  `container`, `thread`, `diagnostics` or an unknown top-level field returns
  `400` naming it, on both Messages paths; a `file` source is refused at the
  top level and inside a tool result; an unlisted beta flag is refused, alone
  and next to an allowed one.
- **Hosted `model` function:** admission works with no database configured;
  a usage report needs both the secret and a model token, and is refused with
  either one missing or invalid; its IDs come from the token, whatever the
  body says; a token up to 15 minutes past expiry is accepted, an older one
  refused; a repeated report with the same `id` writes one row, including when
  sent concurrently; a failed report is retried; a body over 6 MB returns
  `413`; the function fails to start without the key.
- **Grant and tokens:** the access preview lists the release's uses and its
  plan digest covers them; approving access stores `granted_uses`; a run gets
  a model token and the invocation's `model` field only when its function
  declares `model` and the grant includes it; the Retainer API refuses a model
  token; a release that adds `model` is held from automatic upgrade, and its
  reviewed upgrade needs the access approved first; `modelClient` throws
  without the field and sets its timeout from the deadline.
- **Configure:** a `configure` run with `uses: ['model']` can call the proxy
  after access approval and before turn-on.
- **Mapped-write confidence:** a value below the threshold is held as
  `pending_review`; fill-only still holds; a second mapped write to a field
  with a pending value from this installation adds no assertion, including
  when two run concurrently; an integration-actor installation sending a
  `confidence` below 1 gets `422`.
- **Layer check:** core modules importing `model/` fail `pnpm lint`.
- **Enrichment (unit):** the shortcut makes no model call; every guard in
  §6.3; confidence by certainty; each row of the table in §6.5; KV reuse on
  retry, and a pick older than 7 days ignored; the configure function's
  suggestions for a fixture schema.

## 8. Hosted

In `retainer-cloud`: the `model` function outside the VPC with reserved
concurrency, its function URL with response streaming, `RETAINER_MODEL_API_KEY`
on it alone, `RETAINER_MODEL_USAGE_SECRET` on it and on the `extensions`
function, and the coordinator's setting for `model.origin`. The key belongs to
an Anthropic workspace used for nothing else, with a monthly spend limit set
in the Console.

## 9. Delivery sequence

Two pull requests in this repo, with the hosted change between them.

1. **Docs.** The rule updated everywhere in §1, and this spec accepted. Done.
2. **PR 1: the platform.** One change: an extension can call the model.
   - The proxy module with its allow-lists, the request size limit and the
     layer rule.
   - `ai_usage`, its internal usage route, and the usage figure on the
     Overview tab (§3.4).
   - `uses` in the manifest, `granted_uses` and the access preview.
   - The model token, `modelClient` and the invocation's `model` field. Every
     bundle rebuilt with the new protocol schema.
   - The hosted entry point, `lambda/model.ts` (§3.6).
   - Mapped-write `confidence` with its three rules (§5).

   Nothing calls the model when it merges, because no release declares
   `uses: ['model']` yet, so it is safe to deploy on its own.

   Settings it adds: `RETAINER_MODEL_API_KEY` (the proxy), `RETAINER_MODEL_ORIGIN`
   (the coordinator's `model.origin`; defaults to the self-hosted route),
   `RETAINER_MODEL_UPSTREAM_ORIGIN` (defaults to Anthropic's API) and
   `RETAINER_MODEL_USAGE_SECRET` (hosted only). The `model` function also reads
   `RETAINER_EXTENSION_RUN_PUBLIC_KEY`, `RETAINER_EXTENSION_RUN_KEY_ID`,
   `RETAINER_EXTENSION_ISSUER` and `RETAINER_PUBLIC_ORIGIN`, and no database
   setting.
3. **Hosted, in `retainer-cloud`** (§8). The `model` function and its
   settings live in the private repo, so they are a separate change there. If
   deploying PR 1 needs the function to exist, this lands first. Then a
   staging check of streaming and of what the function sees when its caller
   disconnects; a fix it calls for in the proxy is a small follow-up before
   PR 2.
4. **PR 2: the enrichment release.** `configure` suggests the mapping, and
   the new lookup; staging with a real Exa key and the model key, plus the
   domain set in §6.6. (Installation in two steps itself shipped in #90 and
   #91.)

PR 1 holds everything generic, mapped-write confidence included, so PR 2
changes the enrichment bundle and nothing in the server. They stay two
because PR 2 is tested against the deployed proxy with real keys, and the
staging check in step 3 may still change the proxy.

## 10. Later

- **Spend limits.** None in Retainer in v1. A per-workspace or per-plan limit
  can be checked against `ai_usage` when it's needed.
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
  function, so the key stays in one place. The agent function gets a model
  token with `kind: 'agent'`, and the proxy takes the kind from the token, so
  agent usage lands in `ai_usage` under it.
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

What v1 already provides for it: `modelClient` (an `agentClient` joins it),
the invocation's field per capability (an `agent` field joins `model`), the
open `uses` list with `granted_uses`, the model token with its `kind`,
`ai_usage` with `kind`, and the authority rule (§2).

## 12. Revisions

2026-11-14, after a review of the accepted text against the code. There are no
users, so none of these keeps anything for old bundles or installations:

- Model use joined the grant: `granted_uses`, shown and approved at access
  approval (§3.1). Before, the function's `uses` went straight into the run
  token and nothing recorded the approval.
- A separate model token replaced the `uses` claim in the run token, and the
  invocation's `model: { origin, token }` replaced `modelOrigin` (§3.2). The
  proxy no longer receives a credential that opens a workspace.
- Allow-lists replaced the list of refused stored-state fields (§3.2.1).
- `ai_usage` gained the whole usage object, the response's model, the provider
  request ID, `partial` and the attempt (§3.4).
- The usage report carries the model token and takes its IDs from it, and its
  route sits outside the caller chain (§3.6). Reserved concurrency, the
  disconnect rule and the start-up check for the key were added there.
- Mapped-write confidence is refused for integration actors, and a field with
  a pending value is skipped (§5). §6.4 states what the default threshold does
  with a `medium` pick.
- Enrichment: separate codes for each model failure, the refusal fallback, a
  `max_tokens` with room for thinking, KV without expiry (§6.5), and a domain
  set that measures the shortcut and guards today's matches (§6.6).
- The delivery sequence became two pull requests, with the hosted change
  between them (§9).
