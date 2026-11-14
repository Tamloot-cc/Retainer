# Company enrichment extension v1

**Status** — Proposed. Builds on the [Retainer extensions platform](extensions.md) and its [hosted Lambda runtime](extensions-lambda.md).

## 1. Product goal

When a company has a website domain, fill in useful company details from a structured data provider. Each workspace chooses where those details go. A workspace admin can use an external AI agent to suggest the mapping, then edit and approve it before the extension runs. The same approved mapping applies to each lookup.

For example, the provider returns `employee_count: 52` and `linkedin_url` for `acme.com`. An admin maps the count to the workspace’s existing **Team Size** field and approves adding a **LinkedIn URL** field. When someone creates Acme with `acme.com` as its domain, the extension fills those fields if they have no value. If Team Size already says `40`, the extension skips it.

## 2. V1 scope

- One reviewed HTTPS provider with structured JSON and a workspace-supplied API key. The fields below are the proposed launch contract.
- One installation per workspace, targeting the base **Company** object and its **Domain** field by stable IDs. The lookup uses the primary domain link. Preview reports a schema conflict if that field is missing or incompatible.
- Run on Company creation and when its domain changes. A company created without a domain is eligible once someone adds one. The trigger can queue a creation with a blank domain, which the handler skips before making a provider request.
- Fill only unset fields. An unset field has no effective value or explicit clear. A value such as `0` counts as populated. If the domain changes later, fill any remaining unset fields using the new domain. Refreshing already populated values is deferred.
- Defer bulk backfill, periodic scans, provider webhooks, and a manual **Enrich now** action. The standard run list and failed-run retry cover operational recovery in v1.

| Provider output  | Meaning                                                                                    | Compatible Company field | New-field option |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------ | ---------------- |
| `employee_count` | Employees Exa finds for the company, mostly from public profiles; often below its own band | Number                   | Employee Count   |
| `linkedin_url`   | Company LinkedIn profile URL, from Exa's company profile                                   | Links                    | LinkedIn URL     |
| `headquarters`   | Headquarters city, postcode and country                                                    | Address                  | Headquarters     |

The provider is Exa company search. A founded year is deferred, because Exa's sample data was unreliable.

The reviewed bundle defines the source keys, their meanings, how to parse them, and the suggested field definitions. For example, a provider’s count of LinkedIn profiles must be described as such in review. The admin chooses which outputs to use. The adapter converts valid values to Retainer’s field formats. A missing or invalid individual value is omitted while other valid values can still be used.

## 3. Install and review

1. In **Extensions**, the admin selects **Company Enrichment**, enters the provider key, and sees that the extension will send company domains to the provider. The existing secret broker stages the key for approval.
2. For each supported output, the admin chooses an existing compatible field, creates the suggested field, or skips it. At least one output must be mapped. The form shows the source definition, destination field, and any field additions.
3. Optionally, an external agent reads the workspace schema and the bundle’s published output definitions. It proposes a draft using the same three choices. The admin imports the draft into the mapping form and can change every choice. The agent only needs schema and catalog metadata. The provider key and company records stay outside the suggestion step. The form also works by itself.
4. Retainer previews the mapping, any schema additions, the `agent` write authority, and the approved read/write scopes. The admin approves that exact preview. Retainer applies the selected additions and saves the approved mapping in the same transaction that records the installation and queues setup.
5. The setup handler validates the connection using the provider’s supported credential check. The installation activates after setup succeeds. Setup failures use the existing redacted status, retry, and reconnect flows.

An admin can edit the mapping from the installation using the same preview and approval flow. Changing a mapping advances the execution generation, so work based on the old mapping loses write access. The new mapping applies to future triggers. The mapping screen tells the admin that changing it does not backfill existing companies.

## 4. Extension platform changes

The platform already supplies reviewed manifests, install previews, human approval, atomic schema contributions, staged secrets, record-change triggers, and scoped runner credentials. Extend that flow for one bounded kind of mapping.

**Declare outputs.** Add an optional manifest capability for named outputs on a declared object. Each output specifies its meaning, compatible field type, and optional predeclared field definition for **Create field**. Each field definition has a stable universal ID. An agent draft selects only declared outputs and these three mapping choices. The platform accepts compatible existing fields by API name, resolves each to its stable universal ID at preview, and creates fields from reviewed definitions. Publish the output definitions through the catalog. The schema read response stays as it is: universal IDs remain internal, as `ARCHITECTURE.md` requires.

**Review and persist.** Extend preview and commit to accept mapping choices and return the resolved bindings plus schema operations. Validate that every target is active, writable, type-compatible, and on the target object. Reject duplicate destinations and the domain field as a destination. Plan selected additions through the existing schema engine. Treat existing fields as references and track fields created by the extension as contributions. Bind normalized choices and resolved targets into the existing preview digest alongside schema version, release, settings, and generation. Stale previews require a fresh review. Persist the approved mapping as installation configuration and expose it to admitted runs. Only the reviewed control flow can change it.

**Handle schema changes.** Resolve fields by stable identity so display and API name changes survive. Revalidate the mapping on upgrade, re-enable, and use. A missing or incompatible target produces `schema_binding_conflict` in run diagnostics. The mapping screen identifies the affected output and field so the admin can remap it or skip it in a new review. Keep the binding and contribution history so a previously deleted field is surfaced for repair.

**Enforce fill-only writes.** Add a mapped write operation for the installation’s approved enrichment handler with write scope and a live run credential. The runner supplies the Company record ID, the domain it looked up, and values keyed by approved output. Under the schema and record locks, Retainer resolves the active mapping, verifies the exact record is still live and its normalized primary domain still matches, and checks each target for absence before writing. A populated target or explicit clear yields a skip for that field. A changed domain, deleted record, or merged-away ID yields a skip for the request. Unknown or incompatible bindings return a structured error. Reuse the ordinary record write transaction, field validation, assertions, and actor precedence.

## 5. Runtime behavior

1. A Company change queues a job for the active installation. The TypeScript handler resolves the change position to a record ID through Retainer’s API, then reads the current Company and approved mapping. It skips a company with an empty or unusable primary domain or with every mapped field already populated or explicitly cleared.
2. The runner extracts the hostname from the primary domain link and calls the fixed provider HTTPS endpoint. It sends the normalized domain and the authentication required by the provider. The runner bounds time and response size and validates the returned company details before using them. Retainer and the runner make zero model calls. (Since the enrichment release of [extensions-model-calls.md](extensions-model-calls.md) §6, the search also sends the company's name, and the bundle calls a model through Retainer's model proxy to pick the result when the domain alone doesn't settle it. Retainer's core still calls no model.)
3. The runner submits valid, mapped results to Retainer. Retainer applies the guarded write as assertions attributed to the installation’s `agent` actor. Existing assertion rules and audit history apply. The change trigger watches Domain, so enrichment field updates cause no additional lookup.
4. A no-match or a valid response with no usable values completes as a skip. Transient network errors, throttling, and provider 5xx use bounded job retries and honor `Retry-After` when present. Invalid credentials produce a reconnect diagnostic. The existing run list uses safe outcome codes to distinguish applied results, skips, and actionable failures. Keep provider responses and credentials out of job payloads, diagnostics, and logs.

## 6. Delivery and acceptance

Retainer owns the manifest contract, approval UI, guarded write, adapter, tests, and immutable bundle. Self-hosting uses the existing Compose launcher. For hosted rollout, `retainer-cloud` provisions and publishes the job bundle through the existing Lambda pipeline. This bundle uses the job configuration only. Verify real provider credentials and an end-to-end staging lookup before enabling the catalog entry for customers.

| Acceptance                              | Evidence                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin controls the mapping              | With a fresh web build, import an agent draft, edit it, preview field additions and grants, approve, and confirm the saved bindings match the review. Complete the same flow manually. An agent cannot approve.                                                                                |
| Install is atomic                       | With real Postgres, reject stale schema and changed mapping previews, wrong types, duplicate destinations, and targets present only in another workspace. Verify that a failed commit rolls back schema, mapping, and setup. Exercise installation of a bundle without mappings.               |
| Trigger uses the current domain         | A new Company with a domain enriches. A blank domain makes zero provider requests. Adding a domain later enriches. Updating mapped output fields makes zero additional lookups.                                                                                                                |
| Fill-only behavior survives races       | Delay a fake provider response while a competing request fills or explicitly clears a target, changes the domain, or deletes or merges the record. Confirm the stale response cannot modify protected values or the wrong company. Replaying a completed write yields no duplicate assertions. |
| Mapping survives ordinary customization | Renaming a target preserves the binding. Removing it produces a field-specific conflict. A reviewed remap fences old runs and uses the new target on a subsequent trigger.                                                                                                                     |
| Failures are operable                   | Exercise partial provider results, no-match, malformed responses, 429, invalid credentials, disable, and retry. Verify safe diagnostics and that setup and jobs operate through the isolated runner.                                                                                           |

The provider selection, authentication check, response contract, and rate limits are the remaining integration decisions. A fixture with the two launch outputs is sufficient to develop and verify the platform flow before selecting a provider.
