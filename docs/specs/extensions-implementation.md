# Extensions implementation plan

Current status: controls, isolated execution/lifecycle, files/erasure, managed
sources/revisions, commit-ordered feeds, durable triggers, isolated verification,
public webhook ingress and deterministic last-contact are implemented and tested.
The default catalog is empty. Granola, typed sync progress and standalone keys are
implemented locally, together with standalone OAuth. Hosted launch remains outstanding. Reviewed reconnect and grant changes are also implemented.

The contract in extensions.md remains the acceptance specification. Implement in
these dependency-ordered slices; never advertise a trigger before its safety
prerequisites ship. No production deployment is authorized by this plan.

1. Contracts and inert control: strict MIT manifest/build helpers, reviewed
   release catalog, workspace RLS installations, preview digests, atomic additive
   schema/contribution application, durable install receipts, human approval.
2. Complete control: saved-view contributions, settings/secret broker and rotation,
   grants, reconnect/upgrade conflicts, SDK/MCP and generated settings UI.
3. Execution: Postgres leases/fences, transactional checkpoint/KV, quotas, fair
   scheduling, signed installation/run credentials, dedicated control entry,
   deterministic fixture, raw-body verifier/receipt queue, lifecycle sagas.
4. Isolation: immutable reviewed executable registry, launcher/fresh Compose
   containers, network/resource limits, dedicated hosted roles and packaging.
5. Ingestion: files type/intents/adapters, immutable source revisions and derived
   evidence retraction, participant policy, source HMAC suppression, durable
   erasure across payloads/files/KV and purge integration.
6. Reactive: commit-ordered transactional feed, visible tombstones, cursors,
   dispatch checkpoints and cause chains, deterministic last-contact adapter.
7. Launch: Granola provider contract/backfill/edit/reconnect tests, standalone
   installation OAuth REST audience, Tamloot contract, full extensions UI,
   Compose and hosted staging/rollback/maintenance evidence and runbooks.

Verification per slice: unit + fresh real-Postgres database + REST/MCP scenario;
concurrency tests at every serialization boundary. Fresh build precedes browser
tests. Preserve ordinary logEvent semantics and personal-memory isolation.

## Integration decisions

- Existing record writers take schema then privacy locks. Before introducing
  runtime source writes, migrate all lock paths together to the spec's privacy
  then schema order and prove forget/import/revocation races. The inert control
  slice only takes schema and installation locks and does not acquire privacy.
- The initial control slice persists disabled installations and grants no runtime
  credentials. Activation returns an explicit unavailable error until execution,
  source safety and revocation are implemented; no successful setup is implied.
- Registration is release-owned code, injected into the API by the entry point.
  Workspace input never supplies manifests, executables or actor ceilings.

## Implemented slice

Contracts and inert control are implemented on `feat/extensions`:

- MIT `@retainer/extension` strict JSON helpers, bounded schemas and policies.
- Immutable, release-owned catalog, server/runtime checks and actor ceiling.
- Drizzle-generated installation/contribution/receipt tables and indexes;
  workspace RLS, tenant composite installation foreign keys and runtime grants.
- Read-only previews bind workspace/schema/generation/release/settings; human
  admin commit atomically applies additive schema through `runSchemaChange`,
  creates table views through the existing view service, records ownership and
  writes a permanent receipt. Concurrent retries serialize.
- Disable/uninstall retain all CRM/schema/view data; reinstall preserves labels,
  edited views and deprecated fields; stale-generation receipt replay fails.
- REST, SDK and read-only MCP list/get/preview interfaces. MCP cannot approve.
- Real-Postgres/API/MCP tests cover isolation, actor escalation, stale previews,
  concurrent retries, persistence failure rollback and reinstall retention.

The catalog shipped by default is empty. No integration is advertised. The spec
is **not complete**: remaining control work includes upgrades/mappings, encrypted
secrets and connection broker, grants, settings updates and generated UI. All
execution, ingestion, feed, privacy and hosted launch work in steps 3–7 remains.
The current `disabled` state is a deliberate rollout gate, not completed setup.
Do not deploy or describe this slice as an operational extension platform.

## Verification of this slice

- `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm release:check` pass.
  Lint reports existing warnings in the avatar research HTML and Microsoft
  sign-in test; there are no lint errors.
- Full `pnpm test` passes: 1,247 tests, including 973 server tests against a
  fresh PostgreSQL 18 template and isolated per-file databases.
- `docker build -f docker/Dockerfile` passes with the extension package built
  before its dependents. The resulting image applies migrations and starts;
  `/health` reports database OK and unauthenticated catalog requests return 401.
- No UI, hosted staging, provider calls or deployment were tested in this slice.

## Control and execution foundation continuation

The next implementation commit adds:

- Additive upgrade planning against recorded contribution ownership, preserved
  local renames/deprecation, explicit structural/view conflicts, grant increases
  refused, and durable upgrade receipts. Settings updates use revision CAS and
  fence prior runs; account settings require reconnect.
- Workspace RLS jobs, attempts, KV, schedules and write budgets. Claims use
  leases, monotonic fences, attempt deadlines and short transactions. Checkpoint
  and child enqueue commit together, including queue/KV quota enforcement.
- One run per installation, four per workspace and 32 per instance, with one
  candidate per installation in discovery. A separate coordinator role discovers
  due IDs; it cannot select job payloads directly.
- Ed25519 run credentials with a dedicated audience and at most five minutes of
  validity. CRM writes/reads and view operations recheck lease/generation inside
  their transactions. Revocation waits for admitted writes. Run idempotency is
  installation/generation scoped, and CRM writes consume an installation budget.
- Encrypted pending secrets bound to workspace/installation/registration/name,
  opaque approval references, broker-only ciphertext permissions, key versions,
  rotation CAS, run-only retrieval and uninstall deletion deadlines. There is no
  plaintext provider credential in settings, plans or install receipts.
- Paginated redacted run diagnostics, durable human-admin retry, read-only MCP
  run listing, and SDK methods for upgrades/settings/runs.
- UTC schedule coalescing and a trusted executor protocol that pins artifact,
  handler and release digests. Tests use an explicitly in-process fixture driver;
  this is not production isolation evidence.

The write lock order is now privacy then schema, followed by installation and
run admission, replacing the prerequisite noted above. Existing data/privacy
regression tests pass with that order.

Current production gates remain: catalog empty, installs disabled, enable
refused. Signers, brokers, registries and drivers currently require trusted
injection. Entry-point/configuration wiring, isolated drivers, lifecycle setup
and cleanup, reconnect/provider OAuth, files/source revisions/erasure/feed,
Granola, standalone grants and UI remain to be completed. The capability tables
and test fixture activation do not mean those delivery phases are finished.

Verification: full suite passes with 998 server tests; a subsequent focused run
also passes the new competing-workspace-capacity case. Typecheck/build/lint and
layer checks pass. No deployment or provider calls have been performed.

## Isolated execution, lifecycle and UI continuation

The next milestone adds the MIT Node 24 runner; immutable artifact/image maps;
a dedicated Docker launcher; fresh internal isolated-gateway execution networks;
DNS-pinned egress validation; configuration and dedicated runtime API entry;
Compose API/executor/launcher/proxy separation; public install/enable/uninstall
sagas; restricted setup/cleanup credentials; bounded cleanup reaping; automatic
schedule maintenance; safe failure health and admin retry; and a generated
extension management UI with human approval previews and run inspection.

The default catalog is still empty. Only the deterministic fixture is marked
runtime-ready in development artifacts. Provider ingestion is not advertised.
The runtime refuses readiness for trigger kinds whose ingress/dispatcher is not
implemented. See [execution and verification runbook](../extensions-execution.md).

Evidence: real Compose/Postgres/public API approval -> isolated setup -> atomic
child checkpoint -> isolated child -> attributed CRM write -> redacted inspection
-> disable -> bounded uninstall. A separate live Docker test checks CPU/memory/PID,
read-only/non-root/no-mount execution, denied metadata/private/raw internet access
and ephemeral resource cleanup. Browser tests verify preview-before-approval,
settings CAS, run inspection, uninstall/reinstall retention and reader permissions.
Full unit/integration rerun passes 1,293 tests, including 1,011 server tests
against isolated real-Postgres databases. An earlier large fan-out timeout under
concurrent Docker activity passed on its focused rerun and in the subsequent
full run. Typecheck, build, lint and release checks pass; the two new browser
scenarios pass against freshly built assets.

Outstanding acceptance remains substantial: provider connection verification and
refresh/reconnect, explicit grant changes, standalone installation REST/OAuth,
files/storage/erasure, immutable managed source revisions/participant policy,
webhook verifier and receipt queue, commit-ordered feed/change dispatch, Granola,
and private hosted infrastructure/staging/rollback/maintenance proof. Earlier
'inert-only' descriptions above document the previous checkpoints, not current
runtime-ready fixture behavior. No merge or deployment has been performed.

## Authorized files and durable erasure

The files milestone adds the shared field type, immutable assertion references,
REST/MCP and SDK transfers, browser upload/download, and the permanent base
conversation transcript field. Intent reservations serialize quota checks;
finalization checks checksum, length, media type and credential ownership.
Historical references survive current-value clearing and record merges.

Compose runs a dedicated byte service and volume with no database credentials.
API revocation precedes durable erasure. Fenced workers retry storage failures,
retain obligations after workspace deletion, expose pending status, and prevent
previously signed uploads from recreating erased content. Local storage and the
private S3 adapter use immutable conditional uploads and zero-byte erasure
barriers; S3 erasure removes content-bearing retained versions. The dedicated
Lambda maintenance entry point holds the existing deployment lock, but hosted
IAM, scheduling and live S3 verification remain outstanding.

Evidence: all 64 browser scenarios pass against freshly built assets. The final
API image passes the real Compose/Postgres/storage-volume proof: upload,
finalize, assertion attachment, authorized download, immediate revocation,
scheduled physical erasure and rejection of a late signed upload. Competing
quota, attachment/collection and worker claims run against real Postgres.
The full unit/integration suite passes 1,307 tests, including 1,025 server tests.
Typecheck, build, lint and release checks pass. S3 policy tests do not constitute
live AWS verification. Managed source-bound uploads and erasure across source
revisions, queued provider work, KV and feeds belong to the next phase; this
checkpoint does not advertise provider ingestion. No merge or deployment has
been performed.

## Managed source identities, revisions and erasure

The source milestone adds release-pinned identity/ordering/verifier contracts;
setup-only account attestations and activation checks; stable identities retained
across reinstall; item-bound ingestion jobs; staged participant ownership before
uploads; immutable evidence revisions; permanent replay receipts; optimistic
revision checks and explicit stale outcomes; server-enforced participant creation
policy; verified keep/retract deletion handling; and matching REST, MCP and SDK
operations. Provider I/O remains in isolated first-party handlers. The primitives
do not by themselves verify a provider's connection contract.

Edited evidence retracts prior derived assertions and hides facts with no current
source. Current activity/search/context uses one revision; explicit citations and
historical reads remain available. Managed fields, participants and event-type
moves are immutable. The UI explains current/superseded evidence and links prior
revisions. Metadata is joined into the existing event hydration query, preserving
the bounded-query regression contract.

Source erasure expands every affected revision and staged participant, including
pending files before any event exists. It clears provider identity/digests,
receipts, staged ownership and installation KV, retains keyed suppression through
reinstall/key rotation, and fences in-memory fetches through a generation change.
Affected jobs are redacted/cancelled; unrelated durable jobs are retained and can
resume under the new generation. Backfill date bounds must therefore live in
durable operational job input rather than resettable cursor KV.

Evidence includes real-Postgres competing revisions, duplicate delivery, erasure
versus import, pending uploads, scope/item isolation, participant policies,
provider deletion policy, reinstall/key rotation, missing-key fail-closed behavior,
workspace purge and MCP parity. Browser coverage now includes the immutable
source-history flow; all 65 scenarios pass against freshly built assets.
The final unit/integration suite passes 1,326 tests, including 1,042 server tests.
Typecheck, build, lint, layer and release checks pass; lint retains existing
repository warnings only.

Remaining delivery: provider-specific connection/sharing verification and
refresh/reconnect UI, explicit grant changes, standalone installation REST/OAuth,
raw-byte isolated webhook verification and receipts, commit-ordered feed/change
dispatch and last-contact, Granola/backfill/gap recovery, and private hosted
infrastructure/staging/rollback/maintenance proof. The shipped default catalog
remains empty. No real provider calls, merge or deployment have been performed.

## Commit-ordered changes and durable triggers

The reactive foundation adds the minimal workspace feed, REST/MCP/SDK cursors,
permanent UUID/key watches, durable dispatcher checkpoints, minimal retained
trigger metadata, server-propagated cause chains and a depth limit. Record writes,
schema-driven value/visibility changes, merges, review, event links/retraction,
event-type moves (old-type tombstone plus new-type creation),
source supersession and forget publish at the terminal transaction boundary.
A workspace counter is held until commit; no record lock follows publication.
Personal memory is excluded, and reads authorize current minimal references.

`headCursor` supports a scan followed by replay without a race window. Expired
history returns 410. An expired internal dispatcher stops and reports degraded
health rather than dropping history; an adapter catch-up is required before
restarting. A direct self-write is skipped and counted quietly; a cross-app
cycle/depth breach reports `trigger_cycle_blocked`. Queue capacity rolls back
both jobs and the dispatcher checkpoint.

Forget fences every running installation, clears operational KV, scrubs queued
and historical references (including retained trigger copies), and restarts
unrelated durable work under a new fence. Source-bound installations additionally
advance their identity generation. Maintenance expires abandoned jobs visibly,
prunes terminal runs and only the expired feed prefix, and exposes identifiers
only to the narrow cross-workspace discovery role. Worker and dedicated Lambda
entry points share the same maintenance implementation; hosted scheduling remains
an infrastructure task.

Evidence: the full unit/integration suite passes 1,348 tests, including 1,063
server tests against isolated real-Postgres databases. All 65 browser scenarios
pass against freshly built assets. Targeted cases cover commit ordering,
rollback, effective-value filtering, schema deletion/type moves, private-record
exclusion, concurrent dispatch, queue pressure, UUID watches, causation, retention
and erasure. Account workspace creation uses the same terminal publication stage
while retaining its existing atomic control transaction. Typecheck, build,
release and layer checks pass; lint retains existing repository warnings only.
The current API image passes both disposable Compose proofs: isolated lifecycle
execution and upload/authorization/revocation/durable physical erasure.
Last-contact, isolated webhook verification, provider delivery, standalone grants
and hosted launch work remain. The default catalog remains empty.

## Separate isolated webhook verifier

The next boundary implements a strict raw-byte verifier envelope and bounded
result, an MIT Standard Webhooks fixture, a separate launcher bearer/function
capability, a no-network fresh container mode and a five-second host deadline.
No CRM credential, workspace selector, API origin or executable target is part
of that envelope. The transport refuses oversized or open-ended results and
propagates cancellation. Ordinary execution retains its existing API/proxy
network isolation. A development-only inert verifier bundle includes a hung
handler for live deadline testing; it cannot be activated as a provider adapter.

Targeted tests pass for exact-byte tampering, signature rotation, timestamp/ID/
key changes, replay windows, size limits, forged workspace fields, timeout,
closed result shape and transport limits. The live Docker proof passes for no
network, non-root/read-only limits, no credential environment, separate bearer
and function capabilities, forced timeout and ephemeral cleanup. The full suite
passes 1,354 tests (1,064 server tests against real Postgres). Ordinary isolated
execution also passes the live sandbox/network proof and the current-image
Compose lifecycle/public-API proof after the shared launcher refactor.
Typecheck, build, release and layer checks pass; lint retains existing warnings.
Public ingress, candidate/account binding, pre-verification rate limits,
receipt/job atomicity, generated connection secrets and provider delivery are
still outstanding; no webhook adapter is advertised.

## Generated connection secrets and broker-local admission

The connection foundation now declares optional generated secrets, omits them
from human settings forms, refuses human staging of those values, and allows
live runs to write only that declared material through revision CAS. SDK and
REST responses return revisions; ordinary credentials remain read-only to runs.
Broker admission independently checks live generation/lease/fence and keeps its
revocation/lease locks through the secret read/write. API metadata validation
releases its locks first, preventing nested-connection revocation deadlocks and
writes authorized only by a separate API connection's liveness.

Targeted real-Postgres tests pass for competing refresh writes, encryption and
read redaction, expired/fenced runs, concurrent revocation and broker-only
execution grants. A real lease takeover also refuses the old broker fence while
the replacement can read the current secret. Full regression passes 1,357 tests
(1,066 server tests against real Postgres); all 65 browser scenarios pass against
fresh assets, including hidden generated settings during installation/editing.
Typecheck, build, lint/layer and release checks pass. The current image applies
the broker capability migration and passes the disposable Compose lifecycle proof. Public webhook bindings, routing, rate limits and atomic receipt/
job acceptance remain the next task. Provider refresh/reconnect sagas are still
adapter-specific outstanding work; generated storage alone does not implement
them.

## Verified webhook acceptance

Release-pinned callback descriptors select a bounded verifier, a managed-source
sync job, one signing secret and a header allowlist. Opaque callbacks and verified
account-header locators select exactly one candidate; hints never authenticate.
Setup-only reservation creates a retry-stable pending callback before provider
registration returns its signing key and identity proof. It grants no source
access. Setup-only binding then requires an already attested source account and
keeps that reserved URL. Activation requires all declared callbacks and live
signing material. Explicit
disconnect/uninstall permanently retires old callback addresses, and a reconnect
gets a fresh identity. Account-locator changes require a new public route.

Ingress preserves exact raw bytes, excludes browser/Retainer credentials, limits
body/header sizes, counts requests in Postgres before verification, and enforces
the verifier deadline outside a database transaction. Broker admission reads one
candidate secret. Receipt, local source reservation and job enqueue then commit
in one privacy/schema/installation/queue transaction, rechecking live generation.
Duplicates create no extra job; conflicting authenticated bodies are refused.
Failure to persist returns 503. Forgotten source receipts are erased, in-flight
verifications are fenced, and permanent source suppression refuses replays.

Source sync jobs receive only a local item ID. A dedicated extension-service
configuration owns the verifier bearer; metadata-only services need no such
credential. The Compose API can reach only the launcher's separately authenticated
verifier capability. The ordinary worker prunes seven-day receipt dedupe and
retired callback metadata, even with an empty executable catalog.

The controlled verifier seam injects rejection, hangs and invalid outputs. Real
Postgres cases exercise concurrent duplicates, atomic rollback on injected receipt
failure, capacity/rate limits, raw-byte preservation, setup challenges, signing
rotation, source erasure, revocation, reconnect and retention. The real Compose
proof sends signed public callbacks through a no-network verifier and a fresh
isolated source runner: tampering is rejected, two concurrent deliveries produce
one receipt/job/event, integration provenance is preserved, and disable/uninstall
revoke ingress. It uses a synthetic provider, not Granola credentials.

Validation: all 1,377 tests pass across the server (1,083, with two workers) and
MIT/web packages (294). Typecheck, build, lint and release/layer checks pass.
The existing large rollup fan-out test timed out under default parallel load;
its unchanged isolated case and full server run with two workers pass. Rebuilt
images pass the live public-webhook Compose proof, ordinary lifecycle Compose
proof, sandbox resource/network checks and separate verifier proof. The sandbox
inspection uses the generated container name because Docker can transiently key
connecting endpoints by an endpoint ID. The previous UI checkpoint had 65 passing
browser tests; this slice changes no UI components. No provider is
advertised, and the default catalog remains empty.

## Deterministic last contact

A reviewed first-party bundle contributes person/company last-contact date-time
fields. Its pinned capability delegates value/source selection to the server;
normal assertions preserve human precedence. Atomic recomputation can lower a
value after unlink or withdraw it when no current conversation remains. It
respects current source revision visibility and existing rollup configuration.

Normalized assertion-support edges let privacy delete rolled-up claims when the
intermediate record is forgotten while the event survives. The erasure transaction
recomputes affected fields before support FK cascades. Scans use fixed upper IDs,
20-record pages, operational-only erasable KV and empty durable child inputs.
Change handlers repair affected contacts immediately; a coalesced schedule resumes
or restarts scans for recovery and other relation paths. Old failed jobs remain
visible. No models or provider calls are involved.

The 59 targeted real-Postgres checks across derivation, erasure, managed sources
and SQL privileges pass. Five runner tests cover pinned capability validation,
setup retry, cursor privacy, fixed bounds, minimal change batching and rescan
fallback. All 1,388 tests pass across the server (1,089 with two workers) and other
packages (299), plus 65 fresh-build browser tests. Typecheck, build, lint,
release/layer checks pass. The actual isolated adapter Compose proof installs and
backfills, consumes a later conversation through durable change dispatch, lowers
the rolled-up company date after unlinking, and verifies disable/uninstall. The
default catalog remains empty; packaging an artifact is distinct from enabling it
on a hosted deployment.

## Reviewed reconnect and grant changes

Same-release reconnect plans accept newly staged credential references and
connection settings, then require explicit human approval. They atomically adopt
secrets, cancel prior runs and advance generation before setup. The existing
verified source account is retained by default; explicit account replacement
retires source bindings and old callbacks while keeping imported evidence.
Lifecycle code can read its own safe settings/metadata, never CRM data.

Grant-increase plans explicitly show prior/new scopes and actor, bind them into
the approval digest and replace the approved grant atomically. Catalog actor
ceilings remain immutable maxima. A lower agent grant under an integration
ceiling can be raised only through this approval path; agent-only ceilings cannot
be raised. Terminal provider authentication errors mark connection health as
needing reconnect. Settings, reconnect and increased-access approval have distinct
management UI controls.

Real-Postgres tests cover concurrent reconnect/adoption receipts, non-human
refusal, stale approvals, unchanged-account verification, explicit replacement,
old callback fencing, scope/actor increases and terminal authentication health.
UI tests prove that credential entry/review does not commit before approval and
that only opaque secret references enter approval requests. All 1,394 tests pass across the server (1,093 with two workers) and other
packages (301). Typecheck/build/lint and release/layer checks pass. The 66
fresh-build browser tests include reconnect review: account settings and
generation remain unchanged until human approval, then the reviewed replacement
commits. No live provider credentials were used.

## Provider-page and transcript prerequisites

Managed source runs can read their current binding and batch-reserve up to 30
provider identities with ordered, explicit erased/deleted outcomes. Competing
pages use sorted locks, while privacy fences the whole operation. Source-event
fields accept stable universal UUIDs as well as permanent keys, reject alias
collisions, and canonicalize both to the same stored identity. Replaying current
immutable evidence can recover transient source availability; historical receipts
cannot claim that a different current revision is available.

Non-secret form defaults, bounded string choices and required affirmative consent
let a provider expose safe contact-creation defaults and explicit workspace
sharing. Optional callbacks allow polling without an active subscription; pending
configured callbacks still prevent false activation. Setup can revoke its own
local route after provider-side cleanup.

The extensions/files Compose overlay connects only the trusted proxy to the
private byte service, with exact API and byte-origin exceptions. The isolated
runner still receives no raw private-network route, storage signing key or DB
credential. The rebuilt-image signed synthetic callback proof passes
prepare/upload/finalize, immutable source import and authorized download with a
real volume, Postgres and fresh isolated runner. It also verifies tamper refusal,
one durable duplicate receipt, credential redaction and lifecycle revocation.

All 1,401 tests pass (1,097 server tests with two workers, 304 other-package
tests), plus 66 fresh-build browser tests. Typecheck, build, lint, release and
layer checks pass. A browser keyboard test now waits for its review card: its
trace showed the keypress preceding the pending-review response, so readiness
is awaited without changing assertions. Docker dependency layers now depend on
manifests rather than source, and the runner installs only its MIT dependency
graph. Both optimized images build and run the live proof. Host disk exhaustion
briefly stopped Docker; unused package/old build cache was reclaimed and Docker
restarted without deleting containers or database volumes. No provider account
has been used and the default catalog remains empty.

## Typed enumeration progress

Managed providers can pin scan functions, begin/resume fixed-bound enumerations,
and atomically complete them in the final children/KV checkpoint. The new RLS
state contains operation clocks and bounds only; provider cursors and content
stay in erasable KV. Same-ID bounds changes, competing active scans, unrelated
functions, old leases and other installations cannot advance success. Reconnect,
account replacement, disconnect and settings changes reset the watermark;
ordinary disable/enable preserves it. Settings changes now cancel queued/running
jobs as well as fencing them.

The API, SDK and Extensions UI expose last successful enumeration separately from
pending imports and failed imports. Real-Postgres tests cover competing starts,
rollback on invalid children, atomic final-page enqueue, forged completion,
credential boundaries, failed item counts and disconnect reset. All 38 targeted
source/control/queue integration tests and six extension UI tests pass, as does
workspace typechecking. Provider implementation is the next step; no real provider
account or hosted deployment has been exercised.

## Reviewed Granola adapter

The MIT runner now bundles Granola setup, fixed-bound daily/incremental scans,
local-ID ingestion, optional signed webhooks and owned-endpoint cleanup. The
contract distinguishes verified credential access and human sharing consent from
organization ownership. It pins provider URLs, normalizes resource identity,
excludes private notes/photos, preserves full transcript files with pagination,
and rejects a revision that changes mid-fetch. API errors are static/redacted;
404 is unavailable and explicit provider deletion is separate. Lost webhook
signing secrets recover by recreating only exact own unredacted callback URLs.

Unit provider fixtures cover complete paginated transcripts, mid-fetch edits,
wrong identity, pagination stalls, signed event/body identity, participant contact
evidence, empty pages, incremental old-note edits, workspace-scope proof and
owned-only cleanup. Real-Postgres API fixtures exercise the actual adapter,
credential broker, reviewed installation, durable scan/import checkpoints,
private byte upload/download, immutable edits, availability recovery, reconnect,
uninstall and erasure suppression across re-enumeration. Runner subpath exports
support these integration tests; the server imports no runner code in production.
Production artifact generation emits an opt-in Granola bundle; the default catalog
remains empty. No live Granola account or AWS deployment has been used.

Webhook reuse is bound to the same provider-credential and signing-secret
revisions in erasable operational KV. A rotated API key proves workspace scope
again by creating the endpoint; listing an old workspace endpoint as a personal
admin is not proof that the new key is workspace-scoped.

Validation: 1,422 tests pass across the server (1,102 with two workers) and other
packages (320, including the latest 28 runner tests). All 66 fresh-build browser
tests pass, as do typecheck/build/lint, layer and release checks. The first full
server run hit the previously observed large-fan-out seed timeout; the unchanged
11-test rollup file passed alone in eight seconds and a fresh full server run
passed in 74 seconds. No timeout, fixture size or assertions were relaxed.

The immutable Granola Node 24 image also builds and passes the separate
no-network, non-root raw-signature proof, including body tampering, signed
payload/header ID mismatch and release-digest fencing. This verifies the packaged
verifier, not live Granola access or AWS isolation. Standalone authorization and
private hosted implementation are the next delivery slices.

## Standalone installation keys

A reviewed standalone approval becomes active without hosted jobs. Human admins
issue hash-stored, shown-once REST installation keys for approved read/write
scopes, list only safe metadata and revoke them. The new credential table binds
workspace, installation and generation; the same binding supports the forthcoming
OAuth grant without fabricating a hosted lease. Key-mode keys are refused by MCP,
web cookies and accounts-mode REST. Actor class comes from the approved grant;
keys have no person/installer impersonation. Key creation is capped and serialized.

Credential admission now runs inside record, view, file and metadata transactions
before idempotency/file authorization. Revoke and disable drain in-flight writes;
old captured callers cannot replay a write, and re-enable needs a fresh key.
Installation file ownership, causation identity and a shared write budget apply
across keys. The UI allows scope selection, displays the returned secret once,
discards it on closing and exposes explicit prefix-based revocation. Hosted
KV/queue/secrets/source-verification capabilities stay lease-bound.

Real-Postgres checks cover integration/agent rank, read-only credentials, personal
memory refusal, cross-installation/workspace boundaries, key-mode resource/mode
checks, competing key quota and write budgets, revocation races, idempotent replay,
private upload ownership and authorized shared downloads. Browser tests exercise
review, shown-once issuance, scope enforcement, revoke and disable/re-enable.

Validation: all 1,432 tests pass (1,110 server, 322 other-package), together with
67 fresh-build browser tests, typechecking, build, lint and release/layer checks.
The reviewed privileged-function inventory now explicitly includes minimal
installation-key lookup and client liveness; both use `pg_catalog, pg_temp` with
fully qualified tables and runtime-role-only execution. No hosted deployment or
real external app account has been used. Accounts-mode installation OAuth and
private hosted implementation remain.

## Standalone workspace OAuth

Reviewed standalone manifests pin the registered client ID into their release
digest. Accounts-mode clients explicitly register the REST resource; MCP keeps
its existing resource default and person consent. The consent page offers active
matching installations only to workspace admins, shows their approved actor and
scope, and binds approval to the current generation. Extensions manages OAuth
revocation alongside key-mode credentials without offering key issuance in
accounts mode, including on the dedicated extension-control surface.

The staged reference migrations preserve existing person consent/token UUIDs,
bootstrap references for concurrent/new workspaces and give workspace grants a
credential reference with tenant-safe FKs. App RLS exposes only installation
references in the current workspace; privileged claim lookup is control-only.
An indexed library reference supports bounded grant deletion. Pending consent
credentials remain unusable until the library validates the signed request and
the controller rechecks admin/release/generation under its exclusive grant lock.
Invalid or stale approval leaves a working grant intact. Interrupted handshakes
are bounded and eventually collected without ever granting access.

REST JWT verification requires the exact single audience and binds issuer,
client, subject, workspace, installation, credential and generation. Runtime
admission drains writes on revoke and checks fences before replay or file
authorization. Refresh cannot cross disable/enable. Removing the approving admin
leaves the app's workspace grant active, without any personal-memory identity;
explicit admin disconnect removes library references/refresh tokens too.

Real-Postgres tests exercise authorization code/state/PKCE/redirects, refresh,
read-only access, concurrent approvals, invalid-query recovery, generation races,
installer departure, revocation, signed mismatched-claim JWTs, resource/client
boundaries and the dedicated control API. A standalone SDK contract imports a
complete Tamloot transcript as an immutable file/event, preserves ordinary
event payload-conflict rules, and deduplicates concurrent form-submission retries.
The new standalone-app guide documents external provider/state ownership and the
leased hosted-source boundary. Browser tests cover approval and disconnect;
the existing personal MCP flows pass unchanged.

Validation: all 1,448 tests pass (1,122 server with two workers and 326 other
packages), plus all 68 fresh-build browser tests. Typecheck, build, lint, layer
and release checks pass. The first full server run found a missing FK deletion
index, fixed with a generated migration; the full rerun passed. No assertions,
timeouts or fixture sizes were relaxed. All work remains local; no PR, merge,
live provider account or hosted AWS acceptance has been performed.

## Hosted runtime preparation

Operator-owned catalog and executable JSON can be bundled as bounded immutable
files, avoiding large manifests in constrained environment blocks. Inline/file
ambiguity, oversized/non-file sources and unreadable paths fail with redacted
configuration errors. The launcher supports a remote HTTPS API through its
existing trusted proxy, without a local API container or new raw network route.
The scheduled Lambda coordinator discovers at most four jobs per pass and uses
the deployment lock; the general executor keeps its existing default batch size.

Twenty targeted configuration, launcher, real-Postgres executor and Lambda tests
pass, as do server typechecking and lint/layer checks. The private cloud worktree
has separate function IAM roles with the legacy API role preserved, verified by
all 17 existing Terraform tests. Storage provisioning and deployment recovery
are being implemented separately; hosted execution and acceptance remain pending.

## Immutable first-party release versions

Artifact generation now verifies clean main ancestry rather than a branch name,
supporting CI's detached SHA checkout. Production patch versions derive from the
append-only main history count, so later code cannot mutate a fixed `1.0.0`
release. Development bundles remain marked and retain fixture versions. The
catalog UI offers the newest numeric version once per registration, preserving
the exact installed metadata needed for settings and explicit upgrade review.

A real temporary-Git test covers detached builds, advancing main, an unreviewed
feature commit and dirty worktrees. It runs with the root test command. All 28
runner tests, ten extension UI tests, development artifact generation and five
fresh-build extension browser scenarios pass. Production publishing, retained
image/config aggregation and hosted staging acceptance remain separate work.

## Deployment compatibility preflight

Catalog/executable configuration can pin expected SHA-256 hashes; missing or
changed bytes fail before a runtime initializes. Migration status now verifies
every applied journal timestamp/hash and advertises that proof explicitly.
Unknown newer migrations or modified historical files refuse direct migration
before DDL and report an incompatible rollback to deployment. Breaking forward
migrations still use the stopped path.

Twenty-six configuration, migration-status and existing-reference upgrade tests
pass, alongside server typechecking and lint/layer checks. The private deployment
suite passes all nine failure/recovery cases, including legacy status without
history proof, unknown migrations and a missing maintenance responder. These
failures leave existing traffic and worker state untouched. Hosted provisioning
and live acceptance remain outstanding.
