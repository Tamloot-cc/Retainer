# Company and people enrichment

**Status** — Proposed. Builds on the [Retainer extensions platform](extensions.md) and its [hosted Lambda runtime](extensions-lambda.md).

## 1. Product goal

When a company has a website domain, fill in useful company details from a structured data provider. Each workspace chooses where those details go. A workspace admin can use an external AI agent to suggest the mapping, then edit and approve it before the extension runs. The same approved mapping applies to each lookup.

For example, the provider returns `employee_count: 52` and `linkedin_url` for `acme.com`. An admin maps the count to the workspace’s existing **Team Size** field and approves adding a **LinkedIn URL** field. When someone creates Acme with `acme.com` as its domain, the extension fills those fields if they have no value. If Team Size already says `40`, the extension skips it.

## 2. V1 scope

- One reviewed HTTPS provider with structured JSON and a deployment-owned API key. The fields below are the proposed launch contract.
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

1. In **Extensions**, the admin selects **Company Enrichment** and approves sending company names and domains to Exa. The deployment operator configures the Exa key.
2. For each supported output, the admin chooses an existing compatible field, creates the suggested field, or skips it. At least one output must be mapped. The form shows the source definition, destination field, and any field additions.
3. Optionally, an external agent reads the workspace schema and the bundle’s published output definitions. It proposes a draft using the same three choices. The admin imports the draft into the mapping form and can change every choice. The agent only needs schema and catalog metadata. The provider key and company records stay outside the suggestion step. The form also works by itself.
4. Retainer previews the mapping, any schema additions, the `agent` write authority, and the approved read/write scopes. The admin approves that exact preview. Retainer applies the selected additions and saves the approved mapping in the same transaction that records the installation and queues setup.
5. The setup handler validates the connection using the provider’s supported credential check. The installation activates after setup succeeds. Setup failures use the existing redacted status and retry flow.

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
3. The runner submits valid, mapped results to Retainer. Retainer applies the guarded write as assertions attributed to the installation’s `agent` actor. Existing assertion rules and audit history apply. The change trigger watches Domain and the base name field, so enrichment field updates cause no additional lookup.
4. A no-match or a valid response with no usable values completes as a skip. Transient network errors, throttling, and provider 5xx use bounded job retries and honor `Retry-After` when present. Missing or rejected credentials produce a diagnostic for the deployment operator. The existing run list uses safe outcome codes to distinguish applied results, skips, and actionable failures. Keep provider responses and credentials out of job payloads, diagnostics, and logs.

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

## 7. More details and people (v2)

**Status** — Built in release 2.0.0. Sections 1 to 6 describe the first release; where they differ, this section wins.

### 7.1 Scope

- The same Exa company search returns more than v1 used, so it fills more company details at no extra cost.
- A second, optional destination, **People**, looks up individual contacts with Exa's `people` category and fills their details.
- `configure` lets the model choose the objects for both destinations as well as every field, as Tamloot's does (§7.4).
- Fill-only, the mapped write, confidence and the run list behave as in v1 and [extensions-model-calls.md](extensions-model-calls.md) §5 and §6.

### 7.2 Outputs

Company, from the company entity and its profile text:

| Output                | Type    | Source                                                   |
| --------------------- | ------- | -------------------------------------------------------- |
| `employee_count`      | number  | `workforce.total` (v1)                                   |
| `linkedin_url`        | links   | the profile's `LinkedIn:` line (v1)                      |
| `headquarters`        | address | `headquarters` city, postcode, country (v1)              |
| `description`         | text    | `description`, at most 2,000 characters                  |
| `industry`            | text    | the profile's `Industry:` line                           |
| `founded_year`        | number  | `foundedYear`                                            |
| `annual_revenue`      | money   | `financials.revenueAnnual`, USD                          |
| `total_funding`       | money   | `financials.fundingTotal`, USD                           |
| `last_funding_round`  | text    | `fundingLatestRound.name`, "Series a" read as "Series A" |
| `last_funding_date`   | date    | `fundingLatestRound.date`                                |
| `last_funding_amount` | money   | `fundingLatestRound.amount`, USD                         |
| `monthly_web_visits`  | number  | `webTraffic.visitsMonthly`                               |

Person, from the person entity and its profile text:

| Output         | Type  | Source                                                                 |
| -------------- | ----- | ---------------------------------------------------------------------- |
| `job_title`    | text  | the current role at the record's company, or the only current role     |
| `headline`     | text  | the line after the profile's name, unless it is the location           |
| `location`     | text  | `location`                                                             |
| `seniority`    | text  | `Level:` of that role in the profile's experience section              |
| `department`   | text  | `Department:` of that role; founders are often listed under Consulting |
| `linkedin_url` | links | the result's `linkedin.com/in/` address                                |

A malformed or out-of-range value is dropped rather than the whole result. Money is written as `amountMicros` in USD; an amount too large for an exact integer of micros (above about $9 billion) is skipped.

### 7.3 People lookup

The **People** destination binds `name` (required), and optionally `email`, `company` (a relation to the Companies object) and the output fields. Its change trigger watches name, email, company and LinkedIn URL.

1. **LinkedIn first.** When the record already has a `linkedin.com/in/` address in its bound LinkedIn field, the run reads that profile with `POST /contents` ($0.001) and fills from it at confidence 1 (`matched_linkedin`).
2. **Company signal.** Otherwise the run needs a name and a company: the linked company's name and website, read through the Companies destination, or else the domain of a work email. A personal mailbox (Gmail, Outlook, iCloud, Proton and similar) is not a company. With neither, the run ends `no_company` without calling Exa.
3. **Search.** `category: 'people'`, query `"<name> <company name> <company domain>"`, five results with text. The email address itself is never sent.
4. **Shortcut.** Exactly one candidate with the same name (first and last word, case and accents dropped) and a current role at a company whose name matches the record's company after `normalizeCompanyName`: confidence 1, no model call.
5. **Model pick.** Otherwise the model picks, as for companies. Guards: never `low`; the name must match. A current role at the company allows `high` or `medium` (confidence 1 or 0.7), and without one only `high`, so a person known only by an email domain needs a `high` pick.

The mapped write checks the person's primary email as its lookup value, so a run whose person changed email during the lookup writes nothing (`lookup_changed`).

### 7.4 Configure

One model call suggests both destinations, through the configure helper Tamloot shares (`binding-suggestions.ts`). It sees each binding, the candidate objects of the same class with their eligible fields, up to five sampled values per field from the 20 most recently updated records, and the current destinations on an upgrade or a request. Choices the schema can't take are dropped, so the server's default applies to them. People can be skipped. Without a usable answer, company details fall back to API name and type, and People is left to the server's default.

### 7.5 Consent, runs and setup

- The one consent setting, `shareLookups`, now covers people's names and companies. A consent setting must be required, so there is no separate switch for people: skipping the People destination sends no people to Exa.
- `enrichPerson` and `backfillPerson` mirror `enrich` and `backfill`. Setup keeps the mapped outputs of each destination in its own KV key and queues that destination's backfill when an upgrade maps a new output.
- A workspace migrated from before bindings keeps People skipped.

### 7.6 Coverage and cost

Measured on 2026-11-24 against 18 startups that announced a Series A in the previous months, through the release's own lookup code:

| Result                              | Companies (16 matched of 18) | People (16 founders or executives) |
| ----------------------------------- | ---------------------------- | ---------------------------------- |
| Matched without the model           | 14                           | 16                                 |
| Matched with a `high` model pick    | 2                            | not needed                         |
| Description, industry, LinkedIn, HQ | 16                           |                                    |
| Employees, web visits               | 16                           |                                    |
| Total funding / founded year        | 15 / 11                      |                                    |
| Annual revenue                      | 0                            |                                    |
| Title, location, LinkedIn           |                              | 16                                 |
| Headline, seniority, department     |                              | 15                                 |

The two unmatched companies had domains that did not belong to them. Annual revenue is mostly available for larger companies. The latest round often lags a fresh announcement: several companies that had just announced a Series A were still listed with their seed round.

A person search costs about $0.007 and a LinkedIn read $0.001, plus a model pick when the shortcut can't decide (about $0.001 at `claude-haiku-5-5` prices, a fortieth of the $0.04 it cost on `claude-opus-5-5`).
