# Company enrichment: implementation spec

Status: proposal, 2026-11-12. Not implemented. Implements the product
requirements in [extensions-company-enrichment.md](extensions-company-enrichment.md)
(the PRD) on the platform in [extensions.md](extensions.md) and
[extensions-lambda.md](extensions-lambda.md). Line references are to `main`
at `390d0a0`.

The work has two parts. Part A upgrades the extension platform with a
reviewed **output mapping**: a release declares outputs, an admin binds them
to fields in a reviewed plan, and runs write through a server-enforced
**fill-only mapped write**. Part B is the enrichment bundle that uses it. Part
A is generic. Nothing in it names Company, domains or a provider.

## 1. Decisions

| Question                                              | Decision                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where does the mapping live?                          | A new manifest capability `mapping`, a new `mapping` column on `extension_installations` and a new reviewed control flow. It does not live in `settings`, which are flat scalars edited without preview (`service.ts:882-972`).                                                                 |
| How are suggested fields applied?                     | They are declared on outputs, not in `schema`, because every `schema` contribution is always applied. A **Create field** choice adds a `create_field` op to the same plan, and the field becomes a contribution.                                                                                |
| How is fill-only enforced?                            | On the server, under the record lock, in one new runtime endpoint. The handler's own check only saves a provider call. Ordinary `PATCH`/`upsert` cannot express "only if unset", and an agent write over a user value goes to `pending_review` instead of being skipped (`winner.ts:55-71`).    |
| How are replays made idempotent?                      | Fill-only makes them idempotent. A replayed write finds its targets populated and skips them, so no idempotency key is needed.                                                                                                                                                                  |
| How does the extension identify fields?               | By universal ID. Every field has one: `apply.ts:143` generates it when the definition has none, and `fields_universal_uq` makes it unique per workspace. The schema read response starts returning it.                                                                                          |
| Which change events start a lookup?                   | Direct `create` and `update` changes on Company, watching Domain only. A new trigger flag stops related-record link changes from firing it (§3.4).                                                                                                                                              |
| What happens to queued work when the mapping changes? | The generation advances, so running attempts are fenced. Queued, never-started change jobs are restamped to the new generation, because they hold only a change position and read the mapping when they run. A company created a second before a remap is still enriched, with the new mapping. |
| Does a mapping change re-run setup?                   | No. Credentials are unchanged, so the installation stays `active`.                                                                                                                                                                                                                              |
| What is the hosted bundle called?                     | `enrichment`. Hosted bundle names are limited to 12 characters (`retainer-cloud/infra/aws/extension-runtime.tf:11`). The display name stays **Company Enrichment**.                                                                                                                             |

## 2. Gaps in the current platform

These are the facts the PRD's §4 assumes but `main` does not yet provide.

1. The manifest has no outputs or mapping (`packages/extension/src/index.ts:124-217`). Settings are only `string`, `boolean` or `number`.
2. `extension_installations` has no mapping column (`db/schema.ts:1441-1486`).
3. `GET /v1/schema` and `describe_schema` do not return universal IDs (`schema-engine/present.ts:65-102`).
4. A field-scoped change trigger always fires on `create`, `delete`, `merge` and the other lifecycle operations. It also fires indirectly when a related record's links change (`extension-runtime/queue.ts:577-592`).
5. No write is "set only if unset". `lockRecord` follows merges to the survivor (`records/write.ts:149`), but the PRD needs a merged-away ID to be skipped.
6. The base Company `domain` field (`bf87f1cd-b6f4-4c93-9ac7-df7a1b6bf641`, `templates/base.ts:140`) is not protected, so it can be renamed or deleted.
7. No per-extension egress allowlist exists. Lambda job functions have open public egress by design (extensions-lambda.md §4).

## 3. Part A: platform upgrade

### 3.1 Manifest: `mapping` capability

Add an optional top-level `mapping` to `manifestSchema`:

```ts
mapping?: {
  objectId: uuid;                       // object the outputs target
  lookup?: { fieldId: uuid; type: FieldType }; // field the handler reads; never a destination
  outputs: Array<{
    key: string;                        // /^[a-z][a-z0-9_]{0,39}$/, stable across releases
    label: string;
    description: string;                // the provider's definition, shown in review
    types: FieldType[];                 // compatible destination types, non-empty
    field?: FieldDefinition;            // suggested field for "Create field"; type ∈ types
  }>;                                   // 1..32 outputs
}
```

`defineExtension` rejects the following:

- A duplicate output key.
- A duplicate `field.universalId`, or one that collides with any other universal ID in the manifest.
- A `field.type` that is not in `types`.
- A `lookup.type` that is not a valid field type.
- `types` containing `relation` or `files`. Mapped writes carry scalar values only in v1.

Add a per-function flag `mappedWrite: true`. Only functions that declare it may call the mapped write (§3.5), and only in a release that declares `mapping`. The flag is part of the reviewed release digest, like `secrets` and `scopes`.

Old manifests have no `mapping`, so catalogs built before this change keep their digests. The catalog already returns full manifests (`api/routes/extensions.ts:65-67`), so the output definitions are published with no extra work.

### 3.2 Schema read: universal IDs

`presentSchema` adds `universalId` to every object and field. This changes `GET /v1/schema`, MCP `describe_schema` and the SDK type in `@retainer/shared`. The change is additive. Update the `describe_schema` tool description to say that extension mappings reference fields by universal ID.

### 3.3 Preview, commit and persistence

**Input.** `installInputSchema` (`service.ts:44-53`) gains:

```ts
mapping?: Record<OutputKey,
  | { action: 'existing'; fieldId: uuid }   // a field universal ID
  | { action: 'create' }
  | { action: 'skip' }>
```

The input must list every output in the release exactly once. This is also the **draft format** an external agent produces (§3.7).

**Resolution.** `plan()` runs under the schema lock and resolves each choice:

| Choice                                                                 | Resolution                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `existing`                                                             | The field must be active, belong to `mapping.objectId`, have a type in `types`, and not be the lookup field. The binding is a reference.          |
| `create`, and no active field has `field.universalId`                  | Add a `create_field` op (from `contributionOperations`) to the plan. The binding becomes a contribution.                                          |
| `create`, and an active compatible field already has that universal ID | Resolve it as `existing`, for example after a reinstall or when a template created the field. A warning says so. Incompatible: `mapping_invalid`. |
| `skip`                                                                 | No binding.                                                                                                                                       |

Validation is all-or-nothing and returns `422 mapping_invalid`, with `details` naming each failing output and a reason. The reasons are:

- `unknown_output`
- `missing_output`
- `field_not_found`, which also covers a field from another workspace
- `wrong_object`
- `incompatible_type`
- `lookup_field`
- `duplicate_destination`
- `nothing_mapped`

A release with `mapping.lookup` also checks the lookup field: it must exist, be active, belong to the object and match `lookup.type`. If it does not, preview fails with `schema_binding_conflict`, as an unresolved trigger already does (`service.ts:473-488`).

**Preview response.** `ExtensionPreview` gains:

```ts
mapping?: Array<{
  output: string; action: 'existing' | 'create' | 'skip';
  field?: { universalId; key; name; label; type };  // resolved target
  contribution: boolean;                             // created by this installation
}>
```

**Digest.** Add the normalized choices and the resolved bindings (output → field universal ID and type) to the plan digest (`service.ts:503-522`). The digest already binds the schema version, generation, release and settings. A changed choice, or a target field changed after preview, returns `409 stale_plan` at commit.

**Persistence.** Add `mapping jsonb not null default '{}'` and `mapping_revision integer not null default 0` to `extension_installations`. The stored shape is:

```ts
{ outputs: { [key]: { fieldUniversalId: uuid; contribution: boolean } } }
```

Skipped outputs are absent. Only universal IDs are stored, never keys or names, so renames survive. Install commit writes the column in the transaction that already applies the schema, contributions, installation, secrets and setup job (`install()`, `service.ts:576-780`). A failed commit rolls all of it back. Created fields get `extension_contributions` rows like any other contribution. They are protected from deletion while the extension is installed (extensions.md §7), and they stay contributions after a remap moves away from them.

A release without `mapping` must not send `mapping` in its input; doing so returns `422 mapping_invalid`. Its plans and digests are otherwise unchanged. The acceptance tests cover this "bundle without mappings" case.

**Mapping edits.** Add `POST /v1/extensions/:id/mapping`. Preview is the same `POST /extensions/preview` with `installationId`, the installed `version` and a new `mapping`. The digest records the operation as `mapping`. Commit needs a human admin, an `Idempotency-Key` and the matching plan digest. In one transaction it:

1. Takes the exclusive schema lock, then the installation lock.
2. Applies any new `create_field` ops and contributions.
3. Writes `mapping` and increments `mapping_revision`.
4. Advances `generation` but not `grant_generation`, and cancels running attempts.
5. Restamps the installation's queued change jobs to the new generation.
6. Writes a receipt.

The state stays `active`, and setup does not re-run. The commit is refused with `409 installation_disabled` while the installation is `uninstalling` or `uninstalled`.

**Upgrade.** The stored mapping carries over. A new release's outputs that the stored mapping does not name default to `skip`, and the preview lists them as available. An output the new release drops loses its binding, and the preview warns. A stored binding whose target is no longer compatible with the new `types` returns `409 upgrade_conflict` naming the output. The upgrade input may include a `mapping` to change bindings in the same reviewed plan.

### 3.4 Change trigger: `related: false`

Extend the change trigger to `{ kind: 'change', objectId, fieldIds, related?: boolean, operations?: ('create'|'update')[] }`.

- `related: false` turns off indirect firing through `relatedRecordIds` and `mergedIntoId` (`queue.ts:584-592`).
- `operations` limits direct firing to the listed operations. When it is set, field scoping applies to `update` only, and `create` always fires.

Both default to today's behavior, so existing digests are unchanged. Without them, linking a person to a company would queue a company lookup.

When a release declares `mapping`, preview, re-enable and the dispatcher also resolve the mapping. A missing target, or one whose type is no longer compatible, does **not** stall the dispatcher, because only that output is broken. The mapped write reports it instead (§3.5).

### 3.5 Runtime: mapped write

Add `POST /v1/extensions/:id/runtime/mapped-writes`. It accepts only run credentials, with `write` in the run's scopes, and only for a job whose function declares `mappedWrite`. Admission is the existing `admitRun` (`extension-runtime/admission.ts:7-87`) plus that function check. Request:

```ts
{
  recordId: uuid;
  lookup?: string;                         // normalized lookup value the handler used
  values: Record<OutputKey, FieldValue>;   // only outputs the handler has a valid value for
  observedAt?: iso;                        // default: now
}
```

The handler runs in one transaction. Lock order is schema (shared), then installation (shared), then the record lock, as extensions.md §6 requires.

1. Load the stored mapping. If a key in `values` is not a bound output, return `422 mapping_invalid` (`unknown_output`).
2. Resolve each output it needs by universal ID. If a target is missing, inactive, or has an incompatible type, return `409 schema_binding_conflict` with `details: [{ output, fieldUniversalId, reason: 'missing' | 'incompatible' }]`, write nothing, and set installation health to `degraded` with that `last_error`.
3. Lock the record **without following merges**. Add `lockRecord(..., { followMerge: false })`. Skip the whole request in these cases:
   - The record is deleted: reason `record_deleted`.
   - The record is merged away: reason `record_merged`.
   - With `lookup` set, the record's current lookup value, normalized by the shared function in §4.2, differs: reason `lookup_changed`.
4. For each value, check `records.data` for the field key:
   - The key is absent: the field is unset, so write it.
   - The key is present with a non-null value: skip it as `populated`. This includes `0`, `false` and an empty links value.
   - The key is present with `null`: the value was explicitly cleared, so skip it as `cleared`.

   `write.ts:442-443` keeps these three cases distinct. A pending suggestion from another agent is not a winner, so it does not count as populated.
5. Validate the values with ordinary field validation. An invalid value means the handler has a bug: return `422 validation_failed` and write nothing.
6. Write the unset fields with `writeFields`, using the ordinary `withWrite` path. Pass the installation's `agent` actor and confidence `1` so the workspace threshold cannot hold the value. Assertions, actor precedence, the change collector (with this installation's cause), the write budget and audit all apply as for any write.

Response:

```ts
{ outcome: 'applied' | 'skipped';
  reason?: 'record_deleted' | 'record_merged' | 'lookup_changed' | 'nothing_to_fill';
  fields: Record<OutputKey, 'applied' | 'populated' | 'cleared'> }
```

The endpoint is idempotent by construction. A replay after a commit finds every target populated and adds no assertions. Generation fencing makes a remap revoke old runs: the run token binds generation, so a write from before the remap gets `409 installation_disabled`.

### 3.6 Reading the mapping at run time

`GET /v1/extensions/:id` already lets a run read its own installation (`service.ts:172-198`). Add `mapping` to it:

```ts
{ revision, outputs: [{ output, field: { universalId, key, name, type } | null, status: 'ok' | 'missing' | 'incompatible' }] }
```

The handler checks this before calling the provider, so a broken binding fails the run without a wasted lookup. Admin reads return the same shape for the mapping screen.

### 3.7 Agent drafts

An external agent needs only metadata:

- The output definitions, from `GET /v1/extensions/catalog`.
- The schema with universal IDs, from `describe_schema`.
- Optionally, a check of its draft with `preview_extension`. Preview is already open to schema-capable agents, and approval is not.

It produces the `mapping` object from §3.3. Add a short `get_guide("extension_mapping")` that gives the format and states that agents propose and admins approve. No provider key or record data is involved.

### 3.8 Web

The mapping step is part of `ExtensionSettings` (`packages/web/src/routes/extensions.tsx:362-593`). It renders when the selected release declares `mapping`.

- **One row per output.** Each row shows the label, the provider's definition and a destination picker with three choices:
  - Existing compatible fields on the object, by label. The lookup field is never offered.
  - **Create "<suggested label>"**, when the output has a suggested field.
  - **Skip**.
- **Import draft.** A dialog takes the pasted JSON, validates it against the input schema in the browser and fills the rows. Every row stays editable. Unknown outputs, or fields that don't exist, are shown inline rather than dropped.
- **Review panel** (:515-577). Adds the resolved bindings and marks fields that will be created. It also keeps the existing agent authority, scope and operation lines. Approval commits the plan digest as it does today.
- **Installed view.** Shows the mapping with a per-output status from §3.6 and an **Edit mapping** action. The action runs the same form and review against `/:id/mapping`, with the note "Changing the mapping does not fill in existing companies."
- **Conflicts.** A `schema_binding_conflict` from §3.5 names the output and the field's last known label so the admin can remap or skip it.

The `pnpm test:web` Playwright suite covers two flows: importing a draft, editing it and approving; and completing the same flow by hand.

## 4. Part B: the enrichment bundle

### 4.1 Contract

Add the following files flat in `packages/runner/src`, following Granola's layout. Wire them through `registry.ts` and `scripts/build-extension-artifacts.mjs` as bundle `enrichment`.

- `enrichment-contract.ts`: universal IDs, the provider's response schema in zod, and the manifest.
- `enrichment-provider.ts`: the HTTP client.
- `enrichment.ts`: the handlers.

Allocate permanent UUIDs in the contract file before the first release.

Manifest essentials:

- `requestedActor: 'agent'`, `scopes: ['read', 'write']`, catalog `actorCeiling: 'agent'`.
- `settings`:
  - `apiKey`: a string with `secret`, `required` and `reconnect` set.
  - `shareDomains`: a boolean with `consent: true`. Its label is "Send company domains to <provider> to look up company details".
- `schema: []`. All field additions come through the mapping.
- `mapping.objectId` is the base Company object. `mapping.lookup` is `{ fieldId: bf87f1cd-…, type: 'links' }`.
- `mapping.outputs` (the PRD's launch contract):

| Key              | Types    | Suggested field                                                                                                                                                                                                  |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employee_count` | `number` | `employeeCount`, "Employee Count". It reuses the sales template's universal ID `0dc97bea-8bbe-4bd8-9713-0c6628049268` (`templates/sales.ts:91`), so a sales workspace resolves **Create** to its existing field. |
| `linkedin_url`   | `links`  | `linkedinUrl`, "LinkedIn URL". It gets a new universal ID.                                                                                                                                                       |

- The description of `employee_count` is the provider's own definition. For example, if the provider counts LinkedIn profiles, the description says so.
- Functions:

| Function | Trigger                                                                                             | Settings and scopes                                                     | Timeout |
| -------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------- |
| `setup`  | `install`                                                                                           | `secrets: ['apiKey']`, no scopes                                        |         |
| `enrich` | `change` on Company with `fieldIds: [domain]`, `operations: ['create', 'update']`, `related: false` | `secrets: ['apiKey']`, `scopes: ['read', 'write']`, `mappedWrite: true` | 60 s    |

### 4.2 Domain normalization

Add `normalizeDomain(url): string | null` to `@retainer/shared`, so the runner and the server's lookup check (§3.5) agree. It works as follows:

1. Parse with `URL`. If the value has no scheme, add `https://`.
2. Take the hostname. `URL` already lowercases it and converts it to punycode.
3. Strip a trailing dot and one leading `www.`.
4. Return `null` for any of these: an IP literal, `localhost`, a single label, a name longer than 253 characters, or a non-http(s) scheme.

The lookup value is the field's `primary.url`. Additional links are ignored.

### 4.3 `setup`

1. Read `apiKey` through the runtime secret endpoint.
2. Call the provider's credential check.
   - A 401 or 403 means a bad key: return `failed` with `provider_unauthorized`. `failInstallation` marks it `needs_reconnect`.
   - A network error, 429 or 5xx is transient: retry.
   - Success: return `succeeded`, which activates the installation.

Setup reads no records, as lifecycle runs cannot.

### 4.4 `enrich`

| Step | Action                                                                                                                                                                                                                                                          | Outcome                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1    | `sdk.change(position)`. Skip any operation other than `create` or `update`.                                                                                                                                                                                     | `succeeded`, `not_applicable`                                            |
| 2    | Read the installation mapping (§3.6).                                                                                                                                                                                                                           | Any output `missing`/`incompatible`: `failed`, `schema_binding_conflict` |
| 3    | `sdk.record(recordId)`.                                                                                                                                                                                                                                         | Deleted or not found: `succeeded`, `record_gone`                         |
| 4    | Normalize `domain.primary.url`.                                                                                                                                                                                                                                 | Empty or unusable: `succeeded`, `no_domain`. **No provider request.**    |
| 5    | Pre-check whether every bound field is already set. This check is advisory, because the server decides.                                                                                                                                                         | `succeeded`, `nothing_to_fill`                                           |
| 6    | Call the provider with the domain and key. The timeout is 15 s, the response cap 256 KiB, and the result must parse with the zod schema.                                                                                                                        | See below                                                                |
| 7    | Adapt values: `employee_count` must be an integer from 0 to 10,000,000; `linkedin_url` becomes `{ primary: { url }, additional: [] }` when its host is `linkedin.com` or `*.linkedin.com` and the path starts with `/company/`. Drop invalid values one by one. | No usable values: `succeeded`, `no_usable_values`                        |
| 8    | Call the mapped write with `recordId`, `lookup` = the normalized domain, and only the bound outputs.                                                                                                                                                            | `succeeded`, with `applied`, or `skipped` and its reason                 |

Provider outcomes:

- No match: `succeeded`, `no_match`.
- 401 or 403: `failed`, `provider_unauthorized`, which marks the installation `needs_reconnect`.
- 429: `retry`, `provider_rate_limited`, passing `Retry-After` through as `retryAfterSeconds`. The cap is 3600 (`protocol.ts:24`).
- 5xx, a network error or a timeout: `retry`, `provider_unavailable`.
- A malformed body: `failed`, `provider_invalid_response`.

The queue's bounded retry (`retry_exhausted`) still applies.

The handler never logs or returns provider bodies, keys or domains. Only codes reach the run list. The job input stays `{ changePosition }`. Neither the runner nor Retainer calls a model.

Enrichment writes change only mapped fields. Those aren't watched, and the change collector records this installation in the cause chain, so they start no further lookup.

## 5. Hosted rollout (`retainer-cloud`)

- Add `enrichment` to `var.extension_bundles` and to the `EXTENSION_BUNDLES` workflow variable. Do not add it to `var.extension_webhook_bundles`, so it gets a job function only (512 MB, 310 s, no VPC).
- The bundle publishes through the existing release pipeline. Terraform does not change per release.
- Egress stays open, as for Granola. A manifest-declared egress allowlist is out of scope and is listed under Later.
- Add the bundle to the hosted catalog only after a staging lookup with real provider credentials succeeds from beginning to end. Until a provider is chosen, the platform and handler are developed and tested against the fixture provider (§6). The fixture never enters a published catalog.

## 6. Tests

All tests that touch the database run against real Postgres with a fresh clone per file. Concurrency rules have tests that run the competing operations in parallel.

| Area                               | Tests                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest (`packages/extension`)    | Rejects duplicate outputs, a suggested type outside `types`, `relation`/`files` types, and `mappedWrite` without `mapping`. Old fixture digests stay unchanged.                                                                                                                                                                                                     |
| Preview/commit (`server/test/api`) | One test for each `mapping_invalid` reason, including a field from another workspace. Stale schema and a changed mapping return `stale_plan`. A failed commit rolls back schema, mapping, contributions and the setup job. **Create** resolves to an existing universal ID. A release without mappings installs unchanged. An agent key can preview but not commit. |
| Mapping edit                       | Remap advances generation, fences a running attempt, restamps queued change jobs, and the next trigger writes the new target. A rename keeps the binding. Deleting a referenced field produces a field-specific `schema_binding_conflict`.                                                                                                                          |
| Trigger                            | Create with a domain queues a job. Create without a domain queues a job that makes zero provider requests. Adding a domain later queues a job. Updating a mapped field queues nothing. Linking a person to the company queues nothing (`related: false`).                                                                                                           |
| Mapped write races                 | Hold the fake provider while a competing request does each of these: fills a target, clears it explicitly, changes the domain, deletes the record, merges it away. The stale write never changes protected values or another company. Run the write and the competing change in parallel. Replay produces no new assertions.                                        |
| Failures                           | Partial results, no match, a malformed body, 429 with `Retry-After`, 5xx, invalid key at setup and at run time (`needs_reconnect`), disable during a run, admin retry. No secret, domain or body appears in diagnostics or logs.                                                                                                                                    |
| Bundle                             | Unit tests for the provider adapter and `normalizeDomain`. A `test-enrichment-bundle.mjs` like Granola's runs the built bundle through the isolated runner against a fake provider origin, injected the same way Granola's tests inject theirs.                                                                                                                     |
| Web                                | The Playwright flows in §3.8.                                                                                                                                                                                                                                                                                                                                       |

## 7. Delivery sequence

1. **Schema read IDs** (§3.2). Small and independent.
2. **Manifest and trigger flags** (§3.1, §3.4) with their digest tests.
3. **Mapping preview, commit, persistence and edit** (§3.3, §3.6), plus the migration.
4. **Mapped write** (§3.5) with the race tests.
5. **Web mapping form, import and review** (§3.8).
6. **Enrichment bundle against the fixture provider** (§4), plus local acceptance through Compose.
7. **Provider selection and staging verification** with real credentials, then the hosted catalog entry (§5).

Steps 1–5 are platform work and can merge before a provider is chosen.

## 8. Later

- Refreshing populated values, bulk backfill, periodic rescans, **Enrich now**, provider webhooks.
- A per-extension egress allowlist declared in the manifest.
- A record ID in the run list, so admins can see which company a run touched.
- `relation` and `files` outputs.
- Protecting the base Company `domain` field.

## 9. Open questions

1. Which provider, which credential check, which response contract and which rate limits. The PRD leaves these open. The spec assumes one `GET` lookup by domain and an authenticated check endpoint.
2. Should a binding conflict on one output fail the run, as specified here, or apply the healthy outputs and report the broken one? Failing keeps the admin's attention on the conflict; partial application fills more data.
3. Should an `existing` destination exclude fields that another installation contributed, or that another installation's mapping already binds? The spec allows both, because writes still follow assertion precedence.
