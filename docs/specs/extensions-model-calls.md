# Model calls in extensions

Status: proposed, 2026-11-13. Builds on the extension platform in
[extensions.md](extensions.md) and the output mapping and enrichment bundle in
[extensions-company-enrichment-implementation.md](extensions-company-enrichment-implementation.md)
(the enrichment spec). Line references are to `main` at `059b7ff`.

Extension code may call a language model, with Retainer's model key. The
extension is responsible for the call: which model, the prompt, tools,
structured output, effort, streaming, what workspace data goes in and what it
does with the answer. The platform adds three things and nothing else:

1. **A model proxy** (§3). Extension code uses the official Anthropic SDK as
   it would anywhere, pointed at the proxy. The proxy swaps the run token for
   Retainer's key, forwards the request unchanged and records usage. The key
   never reaches extension code.
2. **Draft runs** (§4). A function can run before installation, when the
   admin opens the install screen, and return a draft of the install form:
   the output mapping and settings. Today every run needs an installation.
3. **Mapped-write confidence** (§5), so a write can say it is less certain and
   the workspace's review threshold can hold it.

Enrichment (§6) is the first bundle to use them: it suggests its mapping in a
draft run and uses a model to pick the right search result. Those are its
choices, not platform rules. Other extensions can call a model from any
function for any purpose.

## 1. Product rule change

Until now, Retainer never called a language model. That rule is dropped for
extensions. The new rule:

> Retainer's core (writes, conflict resolution, search, consolidation) stays
> deterministic and calls no model. Extension code may call a model. No
> embeddings or semantic search: search stays Postgres full-text.

Places that state the old rule, to update when step 1 of §9 lands:

- `CLAUDE.md:50`
- `ARCHITECTURE.md:20`, `:997`, §4.3 (`:1149-1155`), `:1466`, `:2000`, `:2051`
- `README.md:18` and `docs/README.md:9`
- `docs/agents.md:71`
- `docs/specs/extensions.md:23-24` and `:58`
- `docs/specs/extensions-slack.md:15`
- `docs/specs/extensions-company-enrichment-implementation.md:365`
- `docs/specs/accounts-and-access.md:53`
- Code comments in `packages/server/src/worker/index.ts:7` and
  `worker/consolidate.ts:7`, which stay true (the core calls no model) but
  should say "the core".

`docs/specs/schema-events-and-history.md:564` (the consolidator stays
deterministic) is unchanged.

## 2. Decisions

- **The extension owns the call.** The platform doesn't choose the model,
  shape the prompt, constrain the output or limit which data is sent. Bundles
  are reviewed first-party code; the release review is where a call's
  purpose is checked.
- **Where the key lives.** In the server only: `RETAINER_MODEL_API_KEY`. On
  the hosted service it's set in the `retainer-cloud` production environment.
  A key inside a runner Lambda or container would reach every bundle that
  runs there, and usage couldn't be attributed to a workspace reliably.
- **Provider.** Retainer's key is an Anthropic key, so the proxy speaks the
  Anthropic Messages API. An extension that wants another provider can still
  use it with a key the admin enters as an extension secret, as Exa's key is
  today; the proxy isn't involved.
- **SDK.** Bundles call the proxy with the official TypeScript SDK,
  `@anthropic-ai/sdk`, in `packages/runner`. The server needs no model SDK:
  it forwards HTTP.
- **Self-hosting.** The operator may set `RETAINER_MODEL_API_KEY` with their
  own key. Without it, the proxy returns `503 model_unavailable`, and each
  extension decides what to do without a model. Enrichment falls back to its
  current rule (§6.5).
- **Spend.** No spend limit in v1. Usage is recorded per call (§3.4), so a
  limit can be added later without new data (§10).

## 3. Model proxy

### 3.1 Manifest

A function declares `model: true`. Like `mappedWrite` and `secrets`, the flag
is part of the reviewed release digest. Any function kind may declare it except
webhook verifiers, which have no network. Releases without the flag keep their
digests.

The install review says, in plain words: "This extension sends data from your
workspace to Anthropic, which Retainer uses to process it." Approving the
release approves that; there's no separate list of which fields or records may
be sent.

### 3.2 Endpoint

The proxy is mounted at `/v1/extensions/runtime/model/` and mirrors the
Anthropic API paths under it. A bundle creates its client like this:

```ts
const anthropic = new Anthropic({
  baseURL: `${invocation.apiOrigin}/v1/extensions/runtime/model`,
  apiKey: invocation.runToken,
});
```

The SDK sends the run token as `x-api-key`. The proxy:

1. Admits the token as the existing `admitRun` does
   (`extension-runtime/admission.ts`), or as a draft-run token (§4), and
   checks that the function declares `model: true`.
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

| Condition                       | Response                       |
| ------------------------------- | ------------------------------ |
| No key configured               | `503`, `model_unavailable`     |
| Token not admitted              | `401`, `authentication_error`  |
| Function lacks `model: true`    | `403`, `permission_error`      |
| Path or stored state refused    | `404` or `400`, as above       |

Provider errors (429, 5xx, refusals in the response) pass through unchanged.
The extension handles them, for example by throwing `RetryLater` on a 429.

A request may run until the run's deadline. On the hosted service the API
runs on Lambda, so the proxy route needs response streaming and a timeout at
least as long as the longest handler deadline; step 2 of §9 checks this in
staging.

### 3.3 Privacy

- The proxy never logs request or response bodies, and neither do handlers:
  the run list shows codes only, as today.
- Nothing the model saw is stored in Retainer, so erasure has nothing new to
  remove. `model_usage` holds no content.
- Anthropic becomes a subprocessor of the hosted service. The privacy policy
  must say so before the first model-backed release ships to hosted.

### 3.4 Usage

New table `model_usage`: workspace, installation (null for draft runs),
registration, function ID, run or draft ID, model, input, output, cache-read
and cache-write tokens, created at. No content.

The proxy reads `usage` from a non-streamed response, or from the stream's
`message_start` and final `message_delta` events. A stream cut off before its
final event records what it saw.

Admins see the month's token use per extension on the installed view. The
operator status page (extensions-lambda.md §3.5) adds the total per day.

### 3.5 Layering

The proxy is a new server module, `packages/server/src/model/`, at the same
layer as `egress`, and is called only from `extension-runtime`. It joins the
layer list in `ARCHITECTURE.md` §8 and `scripts/check-layers.mjs`. Core modules
(`records`, `schema-engine`, `retrieval`, `worker/consolidate`) must not import
it, and the layer check enforces that.

## 4. Draft runs

Today every run belongs to an installation, and lifecycle functions can't read
CRM data before activation (`extensions.md:459`). A draft run happens before
the installation exists, while the admin fills in the install form, and its
result fills that form. What the function does to produce it is up to the
extension: read the workspace, call a model, call its provider, or none of
these.

### 4.1 Trigger

A new trigger kind, `draft`. At most one function per release. Its `scopes`
may include only read scopes and must be a subset of the release's scopes. It
may declare `model: true`. It takes no `secrets`: provider keys are entered at
install, after the draft.

### 4.2 Request and lifecycle

New table `extension_drafts`: ID, workspace, registration, release digest,
schema version, installation (null on first install), requested by (user),
status (`queued`, `running`, `succeeded`, `failed`), result JSON, error code,
created at, expires at (1 hour after creation).

1. **Request.** `POST /v1/extensions/drafts` with
   `{ registrationId, version, installationId? }`. Human admin only, as
   approval is. `installationId` is set when editing an installed extension.
   Requesting a draft is the admin's consent to that one run reading the
   workspace with the function's read scopes, and, if it declares
   `model: true`, sending what it reads to Anthropic. The web app says so
   (§4.5). Returns `202 { id }`. A second request for the same workspace,
   release and schema version within the hour returns the existing one.
2. **Run.** The worker claims queued drafts and invokes the function through
   the existing `ExecutionDriver`, with a 60-second deadline and one retry
   after a transient failure.
3. **Read.** `GET /v1/extensions/drafts/:id` returns the status and, once
   done, the validated result (§4.4). Expired rows are deleted by the existing
   maintenance sweep.

### 4.3 Invocation

`invocationSchema` (`packages/extension/src/protocol.ts:6`) becomes a union.
The existing shape is unchanged; the new one:

```ts
{
  protocolVersion: 1,
  kind: 'draft',
  draftId: uuid,
  releaseDigest, functionId, apiOrigin, deadline,
  runToken: string,
  input: {
    schema: SchemaView,            // the workspace schema, as GET /v1/schema returns it
    current?: {                    // when editing an installed extension
      mapping?: Record<OutputKey, Choice>,
      settings?: Record<string, unknown>,   // non-secret settings
    },
  }
}
```

The run token binds the draft ID, workspace and release, and expires at the
deadline. It grants the function's declared read scopes on the REST API and,
with `model: true`, the model proxy. It can't write, and it can't read secrets
or installation KV, since no installation exists yet. Hosted draft runs use the
job Lambda; self-hosted ones use the launcher with the egress proxy, as jobs
do.

### 4.4 Result

The function returns, alongside `status`:

```ts
draft: {
  mapping?: Record<OutputKey, Choice & { reason?: string /* ≤ 200 chars */ }>,
  settings?: Record<string, unknown>,       // non-secret settings only
}
```

where `Choice` is the format from the enrichment spec §3.3 (`existing` with a
field name, `create` or `skip`).

The server checks the draft before storing it:

- `mapping` goes through `resolveMapping` in review mode
  (`packages/server/src/extensions/mapping.ts:60`). An output whose choice
  fails becomes `skip`, with reason "Suggested field could not be used," and
  missing outputs become `skip`.
- `settings` are validated against the release's settings schema. Unknown or
  invalid keys, and any secret setting, are dropped.

So a stored draft always passes preview, though later schema changes can still
make preview fail, as with any draft.

### 4.5 Web

The install and edit screens (enrichment spec §3.8) change like this:

1. **Better defaults, always.** Before any draft, the mapping form starts
   from a better default than today's `defaultChoices`
   (`packages/web/src/routes/extension-mapping.tsx:65`), which offers only
   "create" or "skip": an existing compatible field whose API name equals the
   output key, or whose label equals the output label ignoring case, is chosen
   as `existing`; otherwise `create` when there is a suggested field;
   otherwise `skip`. This moves to `packages/shared`.
2. **Draft request.** When the release declares a `draft` function, opening
   the screen requests a draft. A line above the form reads "Preparing
   suggestions…" and, under it, "To suggest settings, <extension> reads your
   workspace" plus "and sends it to Anthropic" when the function declares
   `model: true`. A **Don't suggest** link cancels the request before it runs.
3. **Draft arrives.** Rows and settings the admin hasn't touched take the
   draft's values. Each one shows a small "Suggested" label, with the reason
   under mapping rows. Anything the admin already changed stays.
4. **Draft fails.** The line reads "Suggestions aren't available right now,"
   and the form keeps its defaults.
5. **Suggest again** requests a new draft, for example after the admin adds a
   field.
6. Review, approval and Import draft are unchanged. A draft is never
   committed without the admin.

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

### 6.1 Draft: mapping suggestion

The `draft` function declares `read` and `model: true`.

1. Sample up to 20 companies with `query_records`, preferring recently updated
   ones, and keep up to 5 non-empty values per field whose type an output
   accepts.
2. Call the model with the three outputs (label, definition, accepted types),
   the Company fields (name, label, type) with their sampled values, and the
   current mapping when editing. Structured output: one entry per output with
   `action`, optional `field` and `reason`. Effort `low`.
3. Return the result as `draft.mapping`.

Prompt guidance, in short:

- Choose an existing field only when its meaning matches, not just its type.
  A `number` field called `deal_size` is not an employee count; a field called
  `size` holding 12, 340 and 5,000 probably is.
- Prefer a clearly matching existing field over creating one, and `create`
  over a doubtful match.
- When editing, keep current bindings unless they look wrong.

If the proxy returns `model_unavailable` or any error, the function returns
`failed`, and the form keeps its defaults (§4.5).

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

- **Proxy (integration, real Postgres):** admission refuses functions without
  `model: true` and expired or foreign tokens; the key never appears in a
  response or log; bodies and beta headers pass through unchanged; streamed
  responses stream; refused paths and stored-state requests are refused;
  usage is recorded for plain and streamed responses, including concurrent
  calls; `model_usage` has no content. Anthropic is faked at the HTTP
  boundary; the database is real.
- **Draft runs:** the token reads with the declared scopes only, can't write
  or read secrets or KV, and stops at the deadline; `defineExtension` rejects
  a `draft` function with a write scope or secrets; invalid mapping choices
  become `skip` and invalid settings are dropped; a duplicate request returns
  the same draft; expiry deletes rows.
- **Mapped-write confidence:** a value below the threshold is held as
  `pending_review`; fill-only still holds.
- **Layer check:** core modules importing `model/` fail `pnpm lint`.
- **Enrichment (unit):** the shortcut makes no model call; every guard in
  §6.3; confidence by certainty; fallbacks; KV reuse on retry; the draft
  function's output for a fixture schema.
- **Web (`pnpm test:web`):** the draft fills untouched rows only; failure
  keeps the defaults; Don't suggest; Suggest again.

## 8. Hosted

`RETAINER_MODEL_API_KEY` in the `retainer-cloud` production environment, the
proxy route's streaming and timeout settings on the API Lambda, and the
privacy policy update before the first model-backed release.

## 9. Delivery sequence

1. Docs: update the rule everywhere in §1. This spec moves to "accepted".
2. Proxy: module, route, `model_usage`, manifest flag, layer rule; staging
   check of streaming on the hosted API.
3. Mapped-write `confidence` (§5).
4. Draft runs: table, endpoints, invocation union, worker dispatch.
5. Web: better defaults in `shared`, then the draft flow.
6. Enrichment release with its draft function and the new lookup; staging
   with a real Exa key and the model key, plus the domain set in §6.6.
7. Hosted rollout (§8).

## 10. Later

- **Spend limits.** None in v1. A per-workspace or per-plan limit can be
  checked against `model_usage` when it's needed.
