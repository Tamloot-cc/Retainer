# Model calls in extensions

Status: proposed, 2026-11-13. Builds on the extension platform in
[extensions.md](extensions.md) and the output mapping and enrichment bundle in
[extensions-company-enrichment-implementation.md](extensions-company-enrichment-implementation.md)
(the enrichment spec). Line references are to `main` at `059b7ff`.

Extensions can call a language model at two points:

1. **Before installation**, to suggest the output mapping. The admin still
   reviews and approves it.
2. **During runs**, to make a judgment the code can't make on its own. For
   enrichment, that's choosing which search result is the company, or deciding
   that none is.

Retainer pays for these calls with its own model key. Extensions never see the
key: they call a **model gateway** in the server, which holds the key, enforces
budgets, records usage and keeps prompts out of logs.

## 1. Product rule change

Until now, Retainer never called a language model. That rule is dropped for
extensions. The new rule:

> Retainer's core (writes, conflict resolution, search, consolidation) stays
> deterministic and calls no model. Extensions may call a model, only through
> the model gateway, and only from functions whose reviewed release declares
> it. No embeddings or semantic search: search stays Postgres full-text.

Agents still decide what to remember. A model call inside an extension is a
bounded judgment inside one function, not a second agent.

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

- **Where the key lives.** In the server only: `RETAINER_MODEL_API_KEY`. On
  the hosted service it's set in the `retainer-cloud` production environment.
  The runner never holds it. A key inside a runner Lambda or container would
  reach every bundle that runs there, and per-workspace budgets would depend
  on extension code obeying them.
- **Self-hosting.** The operator may set the same variable with their own key.
  Without it, the gateway returns `503 model_unavailable`, and every
  model-backed step has a deterministic fallback (§5.4, §6.5). No extension
  requires a model to work.
- **Provider and model.** Anthropic, through the official TypeScript SDK
  (`@anthropic-ai/sdk`) in a new server module. The default model is
  `claude-opus-5-5`, set by `RETAINER_MODEL` (§10 asks whether to use a cheaper
  one). Extensions don't choose the model: the gateway does, so a model change
  needs no new release.
- **What a model may decide.** Only a choice from options the code built, in a
  fixed output schema. Code always produces the written values. In enrichment,
  the model picks a candidate's index and code extracts the values from that
  candidate. A model never writes a field value it made up.
- **Who reviews.** A mapping suggestion is a draft. The existing preview,
  review and commit flow (enrichment spec §3.3) is unchanged, and only a human
  admin commits.
- **Authority of model-picked values.** Mapped writes already use the
  installation's `agent` actor (enrichment spec §3.5, step 6), so they never
  outrank a person. A low-certainty pick is written with a lower confidence,
  so the workspace's review threshold can hold it as `pending_review` (§6.4).

## 3. Model gateway (server)

### 3.1 Manifest

A function declares `model: true`. As with `mappedWrite` and `secrets`, the
flag is part of the reviewed release digest. The install review shows it in
plain words: "This extension sends data from your workspace to Anthropic, which
Retainer uses to process it." Releases without the flag keep their digests.

A release that declares `suggestMapping` (§5.1) must also declare `mapping`.

### 3.2 Endpoint

`POST /v1/extensions/:id/runtime/model`, for runs, and
`POST /v1/extensions/runtime/suggestions/:suggestionId/model`, for suggestion
runs (§5.2). Both accept only run credentials for a function that declares
`model: true`. Admission is the existing `admitRun`
(`extension-runtime/admission.ts`) plus that check.

Request:

```ts
{
  purpose: string;              // /^[a-z][a-z0-9_]{0,39}$/, e.g. 'pick_company'; for usage reports
  system: string;               // ≤ 8 KiB
  input: string;                // ≤ 64 KiB, the user turn
  output: JSONSchema;           // the answer's shape; ≤ 8 KiB, objects only
  effort?: 'low' | 'medium' | 'high';  // default 'low'
  maxOutputTokens?: number;     // default 4,000, cap 16,000
}
```

Response: `{ output: unknown, usage: { inputTokens, outputTokens } }`. The
server validates `output` against the request's schema before returning it.

The gateway calls the Messages API with:

- the configured model;
- `output_config: { effort, format: { type: 'json_schema', schema } }`
  (structured outputs);
- no tools, no files and no images in v1;
- server-side refusal fallback (`fallbacks: 'default'`), so a refused request
  is retried on a fallback model in the same call.

Error mapping:

| Condition                                      | Response                          | Run should              |
| ---------------------------------------------- | --------------------------------- | ----------------------- |
| No key configured                              | `503 model_unavailable`           | Use its fallback        |
| Workspace or installation budget spent (§3.3)  | `429 model_budget_exhausted`      | Use its fallback        |
| Provider 429, 5xx, timeout (30 s)              | `503 model_retry`, `Retry-After`  | `retry`                 |
| Refusal after fallback                         | `422 model_refused`               | Treat as no answer      |
| Output fails the schema                        | `502 model_invalid_output`        | Treat as no answer      |
| Request over the limits above                  | `422 validation_failed`           | Fix the bundle          |

The SDK gets a `model(...)` method that throws `RetryLater` on
`model_retry` and returns a typed result for the rest.

### 3.3 Budgets and usage

New table `model_usage`: workspace, installation (nullable for suggestion
runs), registration, function ID, purpose, run or suggestion ID, model, input
and output tokens, cost in micro-dollars, created at. No prompt, input or
output text.

Limits, checked before each call under the installation lock:

- Per workspace per calendar month (UTC), in dollars:
  `RETAINER_MODEL_WORKSPACE_MONTHLY_USD`. Hosted default $5. Self-hosted
  default: unlimited.
- Per installation: 60 calls per minute, like the write budget
  (`extensions.md:658`).

The cost of a call is known only after it returns, so a workspace can go over
its limit by one call's cost. That's accepted.

Admins see the month's model spend per extension on the installed view. The
operator status page (extensions-lambda.md §3.5) adds total spend per day.

### 3.4 Privacy

- The gateway never logs `system`, `input` or `output`, and neither do
  handlers: the run list shows codes only, as today.
- Nothing the model saw is stored in Retainer, so erasure has nothing new to
  remove. `model_usage` holds no content.
- Anthropic becomes a subprocessor of the hosted service. The privacy policy
  and the install review text (§3.1) must say so before the first model-backed
  release ships to hosted.
- Search results and web text sent to the model are untrusted. The prompts
  label them as data, and the fixed output schema limits what a manipulated
  answer can do: at worst it picks the wrong one of the candidates, which §6.3
  guards against.

### 3.5 Layering

The gateway is a new server module, `packages/server/src/model/`, at the same
layer as `egress`. `extension-runtime` calls it. It joins the layer list in
`ARCHITECTURE.md` §8 and `scripts/check-layers.mjs`. Core modules (`records`,
`schema-engine`, `retrieval`, `worker/consolidate`) must not import it, and
the layer check enforces that.

## 4. Platform: suggestion runs

Today every run belongs to an installation, and lifecycle functions can't read
CRM data before activation (`extensions.md:459`). A mapping suggestion has to
run before the installation exists, so it needs a new kind of run.

### 4.1 Trigger

A new trigger kind, `suggestMapping`. At most one function per release. It
takes no `scopes` and no `secrets`, and must declare `model: true`.

### 4.2 Request and lifecycle

New table `extension_mapping_suggestions`: ID, workspace, registration,
release digest, schema version, requested by (user), status (`queued`,
`running`, `succeeded`, `failed`), result JSON, error code, created at,
expires at (1 hour after creation).

1. **Request.** `POST /v1/extensions/mapping-suggestions` with
   `{ registrationId, version, installationId? }`. Human admin only, as
   approval is. `installationId` is set when editing an installed mapping.
   The server checks that the release declares `suggestMapping`, then stores
   the request with a snapshot of its input (§4.3). Returns
   `202 { id }`. A second request for the same workspace, release and
   schema version within the hour returns the existing one.
2. **Run.** The worker claims queued suggestions and invokes the function
   through the existing `ExecutionDriver`, with a 60-second deadline and no
   retry beyond one transient failure.
3. **Read.** `GET /v1/extensions/mapping-suggestions/:id` returns the status
   and, once done, the validated result (§4.4). Expired rows are deleted by
   the existing maintenance sweep.

### 4.3 Invocation

`invocationSchema` (`packages/extension/src/protocol.ts:6`) becomes a union.
The existing shape is unchanged; a new shape adds:

```ts
{
  protocolVersion: 1,
  kind: 'suggestMapping',
  suggestionId: uuid,
  releaseDigest, functionId, apiOrigin, deadline,
  runToken: string,          // usable only on the suggestion model endpoint
  input: {
    outputs: Array<{ key, label, description, types, suggested?: { name, label, type } }>,
    object: { name, label },
    fields: Array<{ name, label, type, description? }>,  // active fields on the mapping object
    current?: Record<OutputKey, Choice>,                  // the installed mapping, when editing
  }
}
```

The input carries schema metadata only: no records, no values. The run token
binds the suggestion ID, workspace and release, expires at the deadline, and
grants nothing but the model endpoint. The function never calls the Retainer
API otherwise. Hosted runs use the job Lambda; self-hosted runs use the
launcher with the egress proxy, as jobs do.

### 4.4 Result

The function returns, alongside `status`:

```ts
suggestion: Record<OutputKey, Choice & { reason: string /* ≤ 200 chars */ }>
```

where `Choice` is the draft format from the enrichment spec §3.3
(`existing` with a field name, `create` or `skip`).

The server runs the suggestion through `resolveMapping` in review mode
(`packages/server/src/extensions/mapping.ts:60`). Any output whose choice
fails validation becomes `skip`, with reason "Suggested field could not be
used." Missing outputs become `skip` too. So the stored result always passes
preview, though schema changes after the suggestion can still make preview
fail, as with any draft.

## 5. Mapping suggestions

### 5.1 Deterministic starting point

Before any model runs, the mapping form starts from a better default than
today's `defaultChoices` (`packages/web/src/routes/extension-mapping.tsx:65`),
which offers only "create" or "skip":

- An existing compatible field whose API name equals the output key, or whose
  label equals the output label ignoring case, is chosen as `existing`.
- Otherwise the suggested field (`create`), otherwise `skip`.

This logic moves to `packages/shared` so the web app, the server and bundles
use the same function. It's also the fallback whenever no suggestion is
available.

### 5.2 Web flow

The mapping step (enrichment spec §3.8) changes like this:

1. When the release declares `suggestMapping` and the admin opens the mapping
   step, the web app requests a suggestion and shows the rows filled from
   §5.1, with a "Suggesting matches…" line above them.
2. When the suggestion arrives, rows the admin hasn't touched take the
   suggested choice. Each suggested row shows a small "Suggested" label and
   the reason under the picker. Rows the admin already changed keep the
   admin's choice.
3. If the suggestion fails or the model is unavailable, the line reads
   "Suggestions aren't available right now," and the form keeps the §5.1
   defaults.
4. **Suggest again** re-runs it, for example after the admin adds a field.
5. The review panel and commit are unchanged. Import draft stays.

Edit mapping on an installed extension uses the same flow, with
`installationId`, and passes the current mapping so the model can leave good
bindings alone.

### 5.3 Enrichment's `suggestMapping`

Prompt input: the three outputs with their definitions and accepted types, and
the Company fields from §4.3. Output schema: one entry per output key with
`action`, optional `field` and `reason`.

Instructions to the model, in short:

- Choose an existing field only when its meaning matches the output, not just
  its type. A `number` field called `deal_size` is not an employee count.
- Prefer an existing field over creating one when it clearly matches.
- Prefer `create` over a doubtful match; the admin can change it.
- `skip` only when the output duplicates something the workspace clearly
  doesn't want, which is rare.

`effort: 'low'`.

### 5.4 Fallback

No key, budget spent, refusal or invalid output: the suggestion fails with
that code, and the form keeps the §5.1 defaults. Installation is never blocked
on a suggestion.

## 6. Enrichment: choosing the right result

### 6.1 Today

`companyFromSearch` (`packages/runner/src/enrichment-provider.ts:39`) asks Exa
for one result restricted to the domain and accepts it only if its homepage
normalizes to the domain exactly. It misses companies whose site redirects,
whose profile lives under another domain after a rebrand, or whose top result
is a different company on a shared host.

### 6.2 New lookup

1. **Search.** `POST /search` with `query` = `"<company name> <domain>"` (the
   domain alone when the record has no name), `category: 'company'`,
   `numResults: 5`, and no `includeDomains`. Contents: text, 4,000 characters,
   as today.
2. **Candidates.** Keep results that carry a company entity. For each, build
   `{ index, url, name, homepage, linkedin, headquarters, workforce, excerpt }`,
   where `excerpt` is the first 1,500 characters of the profile.
3. **Shortcut.** If exactly one candidate's homepage normalizes to the domain,
   and its `Homepage:` line (if any) agrees, accept it without a model call.
   This is today's rule, and covers most lookups.
4. **Model pick.** Otherwise, if any candidates remain, call the gateway with
   `purpose: 'pick_company'`, `effort: 'low'`. Input: the record's name,
   domain and any other values of the mapped fields it already has, and the
   candidates. Output schema:

   ```ts
   { index: number | null, certainty: 'high' | 'medium' | 'low', reason: string }
   ```

5. **No candidates**, or `index: null`: `no_match`.

### 6.3 Guards on the pick

Code checks the model's answer before using it:

- `index` must be one of the candidates sent.
- A pick whose homepage normalizes to the domain is accepted at `high` or
  `medium`.
- A pick on another domain is accepted only at `high`, and only if the
  candidate's name matches the record's name after normalization (case,
  punctuation, legal suffixes such as Inc or Ltd). That covers rebrands and
  redirects without trusting the model alone.
- `low` certainty is `no_match`.

The accepted candidate goes through the existing value mapping (enrichment
spec §4.3). The model's `reason` is not stored or logged.

### 6.4 Confidence

The mapped write gains an optional `confidence` (0 to 1, default 1):

- Shortcut or `high` pick: 1.
- `medium` pick: 0.7.

The write path already compares confidence with the workspace's review
threshold, so a workspace that set its threshold above 0.7 gets `medium`
picks as `pending_review` instead of written values. The mapped write's
fill-only rule (enrichment spec §3.5) is unchanged.

### 6.5 Fallback

If the gateway returns `model_unavailable`, `model_budget_exhausted`,
`model_refused` or `model_invalid_output`, the run uses only the shortcut
(step 3). If the shortcut doesn't apply, the outcome is `no_match` with code
`no_match_model_unavailable`, so the run list shows why. `model_retry` retries
the run.

### 6.6 Retries

Jobs run at least once, so a retry after the model call but before the write
would call the model again. The handler stores each pick in installation KV
under `pick:<recordId>:<domain>`:
`{ candidateUrl, certainty, at }`, kept 7 days. A retry with the same record,
domain and a candidate at the same URL reuses it without a model call. The
value holds a public URL and no record data; erasure of the record deletes the
key with the record's other KV references.

### 6.7 Costs

Per lookup that needs the model, the estimate is about 4,000 input tokens and
up to 1,000 output tokens (thinking included). At `claude-opus-5-5` prices ($4
input, $20 output per million tokens) that's at most about $0.04, on top of
Exa's $0.008. The shortcut avoids the call for most lookups. Staging measures
the real share (§9, step 6).

## 7. Run outcomes

New codes in the run list:

- `matched_shortcut`, `matched_model_high`, `matched_model_medium`
- `no_match_model`, `no_match_model_unavailable`
- `model_retry` (as a retry reason)

Suggestion runs show on the mapping screen only, not in the run list.

## 8. Tests

- **Gateway (unit and integration, real Postgres):** admission refuses runs of
  functions without `model: true`; schema validation of output; each error
  mapping in §3.2; budgets under concurrency (two runs at the limit, only one
  passes the per-minute cap); `model_usage` rows contain no content. The
  provider is faked at the HTTP boundary; the database is real.
- **Suggestion runs:** the token works only on the suggestion endpoint and
  only until the deadline; input contains no record values; invalid suggested
  choices become `skip`; expiry deletes rows; a duplicate request returns the
  same suggestion.
- **Layer check:** core modules importing `model/` fail `pnpm lint`.
- **Enrichment (unit):** shortcut path makes no model call; every guard in
  §6.3; confidence 0.7 for `medium`; fallbacks in §6.5; KV reuse on retry.
- **Web (`pnpm test:web`):** suggestion fills untouched rows only; failure
  keeps the §5.1 defaults; Suggest again.
- **Recorded evals (not in CI):** a fixed set of about 50 real domains with
  known answers, including redirects, rebrands and shared hosts, run against
  the real model before each prompt change, recording accuracy and cost.

## 9. Delivery sequence

1. Docs: update the rule everywhere in §1. This spec moves to "accepted".
2. Gateway: module, endpoint, `model_usage`, budgets, SDK method, manifest
   flag, layer rule.
3. Mapped-write `confidence` (§6.4).
4. Suggestion runs: table, endpoints, invocation union, worker dispatch.
5. Web: §5.1 defaults in `shared`, then the suggestion flow.
6. Enrichment release with `suggestMapping` and the new lookup. Staging with a
   real Exa key and the platform model key, plus the recorded eval.
7. Hosted: `RETAINER_MODEL_API_KEY`, `RETAINER_MODEL` and the monthly limit in
   the `retainer-cloud` production environment; privacy policy update before
   release.

## 10. Open questions

1. **Model.** `claude-opus-5-5` is the default here. Picking from five
   candidates is a small classification task, and `claude-haiku-5-5` would cost
   about a fortieth as much. Measure both on the recorded eval in step 6 and
   choose then?
2. **Hosted monthly limit.** $5 per workspace is a placeholder. Should it
   depend on the plan?
3. **Sample values in suggestions.** Field names alone can be ambiguous.
   Sending a few values per field would improve suggestions, but it means CRM
   data leaves before installation. Left out of v1.
