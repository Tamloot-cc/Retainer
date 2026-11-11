# Extensions implementation plan

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
