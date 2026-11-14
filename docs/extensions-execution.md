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

## Model calls

A function that declares `uses: ['model']`, on an installation whose admin
approved model use, calls a model through Retainer's model proxy
([extensions-model-calls.md](specs/extensions-model-calls.md)). Its run gets a
second token next to the run token, good for model calls only, and the proxy's
base URL; the bundle builds its client with `modelClient(invocation)`. The proxy
checks the token and the request, swaps in Retainer's Anthropic key, streams
the response back and records token counts in `ai_usage`, never content.

- `RETAINER_MODEL_API_KEY`: the Anthropic key, set on the API service that
  serves `/v1/extensions/runtime/model`. Without it the proxy answers
  `503 model_unavailable`, and each extension decides what to do without a
  model.
- `RETAINER_MODEL_ORIGIN`: the proxy's base URL that runs receive, executor
  only. Defaults to the execution API origin plus
  `/v1/extensions/runtime/model`, which the egress proxy already allows.
- `RETAINER_MODEL_UPSTREAM_ORIGIN`: where the proxy forwards requests.
  Defaults to `https://api.anthropic.com/`.
- `RETAINER_MODEL_USAGE_SECRET`: hosted service only, set on the `model` and
  `extensions` functions. It mounts the internal usage route the `model`
  function reports to; self-hosting writes usage directly.

The proxy forwards only Messages, token counting and the models list, and only
listed body fields and beta flags, so no request reaches anything stored in the
Anthropic account. `retainer model usage [--days <n>]` prints the tokens used
per day across workspaces; each extension's Overview tab shows its month.

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
An admin may retry a failed current-generation job, including reserved built-in lifecycle jobs. Explicit disable clears the
failure authorization and prevents a retry from undoing revocation.

Disable cancels runs and schedules after admitted operations drain. Enable
revalidates retained schema/settings/grants, advances generation and queues setup
again. Uninstall revokes access first, then enters `uninstalling` for bounded
cleanup. Cleanup may access only its retained connection and acknowledge; it
cannot use CRM, KV or enqueue children. Success removes credentials and completes
uninstall. After 24 hours, maintenance cancels outstanding cleanup, fences its
lease and deletes credentials even if a provider is unavailable. Imported CRM
records, schema, saved views and provenance remain available to the workspace.

Jobs retry with bounded backoff only when the handler asks (it throws `RetryLater`
from `@retainer/extension` or returns `retry`), when it times out
(`execution_timeout`, recorded within a 15-second lease grace), or when the
platform fails to run it. Any other handler exception is a terminal
`handler_failed`, including raw network errors the handler did not turn into
`RetryLater`. Stopping the executor returns running jobs to the queue; the first
three such releases of a job consume no attempt. Hosted coordinator timeouts must
cover the longest handler timeout plus the 15-second grace. The executor refills each of its slots as soon as a run
finishes, so a long run never holds back other installations. Terminal failures
are retained for inspection. A successful retry clears degraded connection health only when
no unresolved failures remain in the current generation. Schedule maintenance
recovers missed ticks and initialization after a worker crash; disabled installs
accumulate none. An expired worker cannot acknowledge or write after replacement.

## Automatic upgrades

First-party release versions count commits on main, so most new versions change
code but nothing an admin approves. The executor checks about once a minute
(and on every hosted pass) for active installations behind the newest release
of their registration, when this server can run that release. It plans the
upgrade as the system actor, under the same locks as a reviewed upgrade, and
applies it only when the new manifest equals the installed one apart from its
version and its package and handler digests, and the plan finds no schema, view
or mapping work. Any other manifest change (access, settings, schema, views,
mapping, triggers, source) needs an admin. The upgrade keeps settings, secrets,
mapping and grants, advances the generation and re-runs setup, like a reviewed
one.

Anything else is held: the installation keeps running its release, records the
held release digest (`upgrade_held_digest`) so it is not planned again, and its
card in the web app offers **Upgrade to …** for an admin to review. A newer
release is checked afresh. Disabled, failed and uninstalled installations are
never upgraded automatically, and a newest release that is not deployed yet is
waited for rather than replaced by an older one. Each upgrade or hold logs one
line with the extension, the versions and the workspace.

## Unavailable releases and server upgrades

A missing or incompatible pinned release pauses its pending work in that runtime. It
does not change provider connection health, discard jobs, consume attempts or advance
change/schedule cursors. `GET /v1/extensions` and installation inspection report
`runtimeAvailability`, computed on read from the answering process's catalog and its
deployed executables (a hosted release without one is `incompatible_runtime`, matching
`runtimeReady`); the failure code is a safe operator diagnostic. The web app explains when the server cannot
run an extension.

Nothing about availability is stored. Each worker passes the `(registration, release
digest)` pairs it can run now (they resolve in its catalog, fit the server range, are
`runtimeEnabled`, and have a deployed executable when it knows them) to the job,
maintenance and change discovery functions, which return only work pinned to one of
them. Like Twenty skipping a stopped app, unavailable work simply is not seen: it stays
queued at the same attempt, never fills a small discovery window, and a worker with a
newer catalog runs it at once. Restoring a release needs nothing beyond a worker that
can run it; there is no upgrade or generation change. Claim re-checks the pin and leaves
the job queued if it cannot resolve it. An admin can still uninstall when the release
cannot load: local access is revoked, callbacks/secrets are retired, and unavailable
cleanup code is skipped. Expired jobs, uninstall cleanup deadlines and erasure are never
filtered and keep running.

Where a process knows its deployed executables (it loads
`RETAINER_EXTENSION_EXECUTABLES` with run keys), its change dispatcher and webhook
ingress use them too: a hosted release without one gets no change jobs (the cursor
waits) and its callbacks get 503 before the verifier runs. A process without that
registry judges by its catalog alone and can still enqueue such jobs; they wait for an
executor and expire with the job lifetime (24 hours) if none appears.

Accepted trade-offs. When maintenance queues cleanup for an uninstalling installation
whose release this worker cannot run, it uninstalls directly (`cleanup_unavailable`)
rather than waiting for another worker. That is safe because the deploy lock keeps one
server version live, so no newer worker is expected to run it. Work paused by
`runtimeEnabled: false` for longer than the job lifetime expires like any job: an
install job then fails setup (`setup_failed`, or `disabled` for an upgrade), which the
admin can retry.

First-party compatibility is reviewed in `scripts/extension-release.mjs` as a bounded
server semver range (`REVIEWED_SERVER_RANGE`, now `>=0.1.0 <0.2.0`), like Twenty's
`engines.twenty`. Artifact generation refuses a package version outside it, and the
manifest contract refuses a range without an upper bound in every alternative, so a
release never claims servers nobody reviewed. A server patch inside the range needs
no new extension release: installed releases keep their digests and stay available.
Only a move to a new server line needs a bridge: widen the range to cover both lines
(for example `>=0.1.0 <0.3.0`) after testing on both, publish and upgrade every
referenced installation while the old server runs, then deploy the new server.
Disabled installations and live cleanup also count as references. Releases built
with the earlier exact `serverVersions` list stay valid as an exact set, so their
digests do not change; they still need a bridge release for any version outside
their list. Prerelease server builds (for example `0.2.0-rc.1`) match no release
range or list, so their extension catalog is empty by design. Retaining old bytes does not establish compatibility, and an
incompatible adapter requires an explicit migration/removal plan. Hosted preflight
keeps refusing a server rollout with unsupported pins.

Migration `0095_record_change_schema_operation` (schema-level changes) adds
two CHECK constraints to `record_changes` and validates them over existing
rows while holding `ACCESS EXCLUSIVE` on the table, so feed reads and every
record write wait for it. Retention bounds the table to 30 days of changes,
so this is an accepted one-time cost; deploy it outside peak write hours.

## Change feeds and retention recovery

`GET /v1/changes` (`list_changes`, SDK `changes`) returns minimal IDs, permanent
field keys, operation, cause and cursors; it never carries record bodies.
Persist `nextCursor` even when authorization filters a page to no visible rows.
For a full current-record rescan, first capture `headCursor` from a fresh page,
scan current records, then replay changes after that saved cursor. Writes during
the scan may be seen twice; recompute from current state. A cursor older than
30 days returns `410 cursor_expired` rather than silently skipping history.
Deleting a field or object type, or changing an object's label field, appends
one `schema` change per affected object type instead of one per record:
`recordId` is null and `changedKeys` lists the hidden field keys. A handler
that receives one rescans that type's current records.

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
five-second host deadline terminates unresponsive code. Verifiers have their own
launcher slots: one launcher runs up to 32 runs and 8 verifiers at once.
Launches reuse a passing engine health check for 30 seconds, so busy runs do not
make webhook ingress fail. Results are bounded to 16 KiB and cannot name another workspace. The Standard Webhooks fixture checks
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

## Company enrichment bundle

The artifact builder also emits `artifacts/extensions/enrichment/`. Build the
Node 24 runner image with that directory's digest and `BUNDLE_ID=enrichment`,
and select its catalog and executables as for Granola. It has no webhook
verifier. Runs need outbound HTTPS to `api.exa.ai` only.

An admin supplies an Exa API key, approves sending company domains to Exa, and
maps each output (employee count, LinkedIn URL, headquarters) to an existing
company field, a suggested new field, or nothing. An agent can propose that
mapping with `preview_extension`; only an admin approves it. When a company is
created or its domain changes, the extension looks the domain up in Exa company
search and fills only mapped fields that have no value and were not cleared.
Values people or other agents set are never replaced, and existing companies are
not backfilled. **Edit mapping** on the installation reviews a new mapping; it
applies to later changes only. Each lookup is one Exa search (about $0.008).

The adapter's Exa transport, matching and lifecycle have deterministic fixtures,
and the API integration tests use real RLS Postgres and the secret broker. They
do not call a real Exa account: staging acceptance with a real key remains
launch evidence (see `docs/specs/extensions-company-enrichment-implementation.md`
§4.3).

## Standalone app keys in key mode

A reviewed standalone installation becomes active immediately after the admin
approves its schema and read/write grant. Open **App credentials**, select access
and create a key. Copy it before closing; only a hash and prefix are stored.
Use it as a bearer credential for the REST API. Credential lists contain safe
metadata, and revocation waits for admitted writes to finish. Keys bind to the
installation's grant: upgrades that keep the same actor and scopes, and ordinary
settings changes, keep them working. Disable, uninstall, an actor or scope change
and reconnect revoke them; issue a new key afterward. The same app actor owns its uploads across keys. Standalone keys
access ordinary CRM operations, authorized files, the change feed and their own
installation metadata. Hosted execution state and provider-secret capabilities
remain lease-bound. Accounts-mode standalone apps connect through the separate
installation OAuth consent flow, which is still pending implementation.
