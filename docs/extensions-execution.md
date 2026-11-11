# First-party extension execution (development preview)

The default catalog is empty. The deterministic fixture exercises the execution
platform; it is not a provider integration. Authorized files and durable byte
erasure are implemented; see [file storage](files.md). Managed source identities,
immutable revisions, staged upload ownership and source erasure are implemented
as platform primitives. Commit-ordered change feeds and durable change triggers are also implemented.
Verified public webhooks, reviewed reconnect/grant changes and deterministic last-contact are implemented. The Granola adapter and typed sync progress are implemented locally; standalone OAuth remains in development. Do not enable an ingestion adapter before its
source/privacy prerequisites are implemented and tested. Hosted infrastructure
and deployment remain separate work in `retainer-cloud`.

## Local verification

Build the API, generate development-only fixture metadata, and build its runner:

```sh
pnpm install
pnpm build
node scripts/build-extension-artifacts.mjs --development
docker build -f docker/Dockerfile -t retainer:extensions-review .
digest=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/extensions/fixture/metadata.json')).releaseDigest")
docker build -f docker/Dockerfile.extension-runner \
  --build-arg RELEASE_DIGEST="$digest" --build-arg BUNDLE_ID=fixture \
  -t retainer:extension-runner-fixture .
pnpm test:extensions:compose
```

The Compose proof generates disposable keys and creates its own project,
Postgres database/volume and ports. It uses human admin approval over the public
API, runs setup in a fresh container, checkpoints its child atomically, observes
the child's CRM write and redacted run status, disables, and uninstalls. It removes
only its project and volume. It never modifies production data or prints keys.

`pnpm test:extensions:sandbox` separately uses an HTTP stub to inspect container
flags, resource limits, fresh internal networks, denied metadata/private IPs,
denied raw internet egress, absence of host mounts, and cleanup. That test expects
a runner built with release digest `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.
It does not establish CRM authentication; the Compose proof above does.

## Compose topology

`docker/compose.extensions.yml` is an optional overlay for `docker/compose.yml`.
The API verifies run credentials with an Ed25519 public key. The executor owns
the private signing key, claims fenced jobs, and calls the launcher on a private
control network. It has no Docker socket or provider secrets. The secret broker
uses a separate SQL role and external versioned encryption keys.

The launcher has host-level privilege through the Docker socket. Restrict access
to its service and bearer token to the executor. Only the launcher mounts the
socket. Every invocation receives a new non-root container, a read-only root
filesystem, bounded tmpfs, no capabilities, no host mounts, and CPU/memory/PID and
deadline limits. Container output is bounded and is not persisted as logs. The
run token arrives through stdin rather than environment or command arguments.

Each execution has a fresh internal bridge in isolated gateway mode: it has no
bridge-host address or route to other Docker networks. Only the API and egress
proxy join it. DNS results are checked and pinned at the proxy, including new
connections following redirects. The configured API authority and, when the files overlay is enabled, its exact byte-service authority are the only
private-network exceptions; loopback, metadata and link-local remain forbidden.
Only reviewed first-party bundles are supported; this is not a certification for
executing hostile third-party code.

The API uses role `api`; the separate executor process also runs the ordinary
background workers. Managed login URLs can separate migration, application,
executor-discovery and secret-broker privileges. Without login URLs, the existing
self-hosted owner-connection/`SET ROLE` mode is used. Use dedicated managed logins
when distributing those privileges between independently operated services.

## Release and key inputs

Only operator-provisioned configuration can add catalog or executable entries.
Workspace requests cannot upload code, choose an image/module, or choose an actor
ceiling. `scripts/build-extension-artifacts.mjs` writes reviewed manifest,
catalog, executable map and build metadata beneath ignored `artifacts/extensions`.
Production artifact generation requires clean `main`; development output is
explicitly marked. Runner mappings use immutable image IDs or digests, with
matching protocol/runtime/release/bundle labels verified before launch.

- `RETAINER_EXTENSION_CATALOG`: reviewed manifests and actor ceilings. The
  operator-owned `runtimeEnabled` flag is distinct from manifest data.
- `RETAINER_EXTENSION_EXECUTABLES`: exact registration/release/function mapping
  with handler/package digests and a launcher bundle target. Both API and worker
  validate it; an incomplete or mismatched map fails startup.
- `RETAINER_EXTENSION_RUN_PUBLIC_KEY`: public Ed25519 JWK. Private material in
  this setting is refused. API services receive only this key.
- `RETAINER_EXTENSION_RUN_PRIVATE_KEY`: private JWK, executor only. Startup proves
  the key pair matches. `RETAINER_EXTENSION_RUN_KEY_ID` identifies the version.
- `RETAINER_EXTENSION_ISSUER`: stable credential issuer, separate from
  `RETAINER_EXTENSION_API_ORIGIN`, which may use the internal API address.
- `RETAINER_EXTENSION_SECRET_KEYS`: `{currentVersion, keys:{version:base64}}`.
  Each decoded key is 32 bytes. Retain old key versions through rotation.
- `RETAINER_EXTENSION_LAUNCHER_ORIGIN` and `RETAINER_LAUNCHER_TOKEN`: executor's
  private launcher endpoint and independently generated bearer token.
- `RETAINER_EXTENSION_BUNDLES`: launcher's immutable bundle allowlist, separate
  from invocation payloads. `RETAINER_DOCKER_SOCKET` names the host socket.
- `RETAINER_EXECUTOR_DATABASE_URL` and
  `RETAINER_SECRET_BROKER_DATABASE_URL`: optional managed-login URLs.

Run credentials have a dedicated audience, last at most five minutes, contain no
personal-memory identity, and are checked against live lease/fence, generation,
release and installation grant in every admitted CRM transaction. They cannot
approve installations, change schema, or retry runs as an admin.

## Lifecycle and recovery

Human approval atomically applies additive schema/views, adopts staged encrypted
secrets, persists an installation receipt, and queues setup. Runtime-ready
releases start `installing` (or `upgrading`); other reviewed manifests remain
`disabled`. Unsupported trigger runtimes cannot be activated. Nothing is marked
active merely because schema application succeeded.

Setup may read its own connection and use runtime KV/checkpoints, but cannot read
or write CRM data before activation. Child jobs wait durably until every setup
handler succeeds. A server acknowledgement supplies the same lifecycle when no
hook is declared. Terminal initial setup failure becomes `setup_failed`; failed
upgrade becomes `disabled`, retaining the new schema and fenced old generation.
Run inspection returns safe codes, IDs and timestamps, never input or credentials.
An admin may retry a failed current-generation job. Explicit disable clears the
failure authorization and prevents a retry from undoing revocation.

Disable cancels runs and schedules after admitted operations drain. Enable
revalidates retained schema/settings/grants, advances generation and queues setup
again. Uninstall revokes access first, then enters `uninstalling` for bounded
cleanup. Cleanup may access only its retained connection and acknowledge; it
cannot use CRM, KV or enqueue children. Success removes credentials and completes
uninstall. After 24 hours, maintenance cancels outstanding cleanup, fences its
lease and deletes credentials even if a provider is unavailable. Imported CRM
records, schema, saved views and provenance remain available to the workspace.

Jobs retry transient failures with bounded backoff and retain terminal failures
for inspection. A successful retry clears degraded connection health only when
no unresolved failures remain in the current generation. Schedule maintenance
recovers missed ticks and initialization after a worker crash; disabled installs
accumulate none. An expired worker cannot acknowledge or write after replacement.

## Change feeds and retention recovery

`GET /v1/changes` (`list_changes`, SDK `changes`) returns minimal IDs, permanent
field keys, operation, cause and cursors; it never carries record bodies.
Persist `nextCursor` even when authorization filters a page to no visible rows.
For a full current-record rescan, first capture `headCursor` from a fresh page,
scan current records, then replay changes after that saved cursor. Writes during
the scan may be seen twice; recompute from current state. A cursor older than
30 days returns `410 cursor_expired` rather than silently skipping history.

The dispatcher atomically queues a matching job and advances its own durable
checkpoint. A job receives only `changePosition`; `get_change`/SDK `change`
returns its currently authorized minimal snapshot even after public-feed pruning.
Forget removes retained copies and fences live workers. Direct self-matches are
counted and skipped; repeated installations in a cause chain or depth beyond
eight are skipped with a visible `trigger_cycle_blocked` diagnostic.

Queue pressure leaves the checkpoint pending and reports degraded health. If an
internal cursor expires, dispatch stops with `cursor_expired`. A reviewed adapter
must offer a current-state catch-up path: disable it to fence old jobs, then
re-enable with setup that queues the catch-up scan before normal processing.
The platform does not claim that restarting an arbitrary handler repairs lost
history. Runtime readiness is granted only after the adapter's scan/replay and
delete/retraction behavior is verified. The default catalog is still empty.

The regular worker runs bounded dispatch/retention passes. The dedicated hosted
entry point accepts only `{"task":"dispatch-record-changes"}` and holds the shared
deployment lock. Its AWS schedule and IAM wiring belong in `retainer-cloud`.
Retention expires abandoned jobs with a visible `job_expired` result, removes
terminal diagnostics after 30 days and prunes only the expired feed prefix.
Source replay receipts and suppression tombstones have separate durable lifetimes.

## Isolated verifier protocol (ingress wiring in progress)

Verifier code has a separate envelope and launcher capability. It receives exact
raw bytes, selected headers and one candidate secret, and has neither a CRM token
nor a target workspace selector. Its fresh container uses `NetworkMode=none`,
no proxy environment and the ordinary non-root/read-only/resource limits. A
five-second host deadline terminates unresponsive code. Results are bounded to
16 KiB and cannot name another workspace. The Standard Webhooks fixture checks
HMAC-SHA256 over message ID, attempt timestamp and exact bytes, a five-minute
clock tolerance and a rotation signature list, following the
[published signature contract](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
This is one provider protocol, not a universal verifier for every webhook.

`RETAINER_VERIFIER_TOKEN` enables the launcher's `/verify` capability. It must be
at least 32 characters and differ from `RETAINER_LAUNCHER_TOKEN`; neither bearer
can invoke the other's endpoint. The ingress service will receive only the
verifier credential. `verifierFunctionIds` in the immutable bundle allowlist are
separate from ordinary `functionIds`, with duplicates rejected across both.

Development artifact generation also creates an inert `verifier-fixture` bundle.
It is not runtime-ready and includes an intentionally unresponsive test handler:

```sh
pnpm build
node scripts/build-extension-artifacts.mjs --development
verifier_digest=$(node -p "JSON.parse(require('fs').readFileSync('artifacts/extensions/verifier-fixture/metadata.json')).releaseDigest")
docker build -f docker/Dockerfile.extension-runner \
  --build-arg RELEASE_DIGEST="$verifier_digest" --build-arg BUNDLE_ID=verifier-fixture \
  -t retainer:extension-verifier-fixture .
pnpm test:extensions:verifier
```

The disposable real-Docker proof checks raw-byte signatures/tampering, no network
connection, no CRM/environment credential, separate function and bearer
capabilities, hard termination and cleanup. It does not prove public ingress,
account routing, rate limiting, durable receipt/job atomicity or provider setup;
those remain required before any webhook adapter can be activated.

## Provider-generated connection secrets

Optional secret settings can declare `generated: true`. These are hidden from
human configuration forms and cannot be supplied through pending-secret staging.
A live run may store a provider's signing/refresh material through SDK
`setExtensionSecret` (the run-only PUT secret endpoint), with an expected revision
or `null` for create-only. Competing writes produce one winner and a revision
conflict. The response contains only the revision. Ordinary human-provided API
keys remain read-only to runs.

The secret broker checks the installation generation and current lease/fence
inside its own transaction, holding revocation and lease locks through the
secret operation. API metadata validation finishes before requesting that broker
transaction; it does not hold one connection's locks while waiting on another.
Uninstall cleanup may read its retained connection but cannot write generated
secrets. This provides encrypted CAS storage, not a claim that arbitrary provider
refresh calls are exactly once: each adapter must handle provider-specific token
rotation, uncertain outcomes and reconnect behavior.

## Isolated transcript uploads with local file storage

When combining execution and private file storage, add the integration overlay
last, after configuring both services as described above and in [files](files.md):

```sh
docker compose -f docker/compose.yml -f docker/compose.extensions.yml \
  -f docker/compose.files.yml -f docker/compose.extensions-files.yml up -d
```

Only the trusted proxy joins `files-control`; its exact byte origin is added to
the private-authority allowlist. Runners keep their fresh isolated network and
receive a short-lived upload ticket through their own API credential. The byte
service receives no database or provider credential. Other private authorities,
metadata and loopback remain blocked.

`pnpm test:extensions:files` exercises a signed synthetic callback, isolated
source job, staged ownership, upload/finalization, immutable source import and
an authorized download with a real Compose byte volume and Postgres. Build the
API and generated webhook-fixture image first, as for the webhook verification
command. This proof uses no real provider account.

## Granola bundle

The artifact builder also emits `artifacts/extensions/granola/` with the reviewed
manifest, catalog, executable registry and immutable metadata. Build the Node 24
runner image with that directory's digest and `BUNDLE_ID=granola`, and explicitly
select its catalog and ordinary/verifier executables in the existing runtime
configuration. Emitting artifacts never enables the default empty catalog.
Use the files overlay for transcript uploads. A verifier service can stay on a
private deployment; receiving public Granola notifications is optional.

An admin supplies a Granola API key and explicitly approves sharing the accessible
summaries/transcripts. The default creates no people and imports 31 days of
history. `contacted_first` requires explicit owner/organizer evidence. Webhooks
are off by default; enabling them requires public HTTPS and a workspace API key.
Use reconnect for key rotation, and an explicit larger backfill for newly shared
old notes when polling alone cannot discover them. The Extensions page reports
last successful enumeration separately from pending/failed imports.

The Granola transport, mapping, verifier and lifecycle have deterministic provider
fixtures. API integration tests use real RLS Postgres, the secret broker and file
byte storage. They cover backfill, edits, availability recovery, reviewed key
rotation, uninstall and suppressed reimport after erasure. They do not call a
real Granola account. Hosted deployment and provider-account acceptance remain
separate launch evidence.

After building `retainer:extension-granola` with the emitted digest, run
`pnpm test:extensions:granola-bundle`. It checks the immutable labels and runs the
actual Node 24 verifier in non-root, read-only, no-network containers. Signed
payloads pass; raw-body tampering, mismatched signed event IDs and another
release digest are refused. The test uses only disposable synthetic signing
material and never reaches a provider account.

## Standalone app keys in key mode

A reviewed standalone installation becomes active immediately after the admin
approves its schema and read/write grant. Open **App credentials**, select access
and create a key. Copy it before closing; only a hash and prefix are stored.
Use it as a bearer credential for the REST API. Credential lists contain safe
metadata, and revocation waits for admitted writes to finish. Disable/re-enable,
settings changes and upgrades invalidate older generations; issue a new key after
re-enabling. The same app actor owns its uploads across keys. Standalone keys
access ordinary CRM operations, authorized files, the change feed and their own
installation metadata. Hosted execution state and provider-secret capabilities
remain lease-bound. Accounts-mode standalone apps connect through the separate
installation OAuth consent flow, which is still pending implementation.
