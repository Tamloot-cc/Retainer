# First-party extension execution (development preview)

The default catalog is empty. The deterministic fixture exercises the execution
platform; it is not a provider integration. Files, managed source revisions,
erasure across extension stores, webhooks, change triggers, standalone OAuth and
Granola are still in development. Do not enable an ingestion adapter before its
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
connections following redirects. The configured API authority is the sole
private-network exception; loopback, metadata and link-local remain forbidden.
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
