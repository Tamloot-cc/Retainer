# Hosted extensions on AWS Lambda

Status: proposal, 2026-11-12. Not implemented. Amends
[extensions.md](extensions.md) §9.1 and §13. The matching infrastructure change
is specified in the private `retainer-cloud` repo at
`docs/extensions-lambda.md` (it reworks retainer-cloud PR #11, not yet merged).

## 1. Decision

Hosted first-party extension code runs as **AWS Lambda function versions**, one
function per bundle, invoked synchronously by the trusted executor. This
replaces the dedicated EC2 Docker host that #79 prepared for and returns to the
hosted model the original spec chose ("separate immutable Lambda versions for
first-party bundles, outside the DB VPC"), which follows Twenty's Lambda logic
function driver.

Self-hosting is unchanged: Compose keeps the trusted launcher, a fresh runner
container per run and the egress proxy. Lambda is a second `ExecutionDriver`
and `VerificationDriver`, selected by configuration, never by a manifest or a
request.

Why:

- **No host to own.** The EC2 path needed an operator-hardened AMI, a
  hand-written iptables boundary and a root launcher holding the Docker socket,
  all still unaccepted. Lambda gives a per-function microVM, multi-AZ capacity
  and patching for free, at near-zero cost while the service has no users.
- **Releases stop being deployments.** A Lambda version is immutable and cheap
  to keep. Publishing one changes no host, IP or environment, so a catalog
  change no longer has to stop and drain every writer (see the cloud spec).
- **Webhook ingress loses its single point of failure.** Verifiers no longer
  share one machine with job execution.

## 2. What stays the same

The queue, leases, fencing, run tokens, lifecycle, availability resolver,
webhook routing, change feed, files, manifests, release digests and the
Compose launcher. `ExecutionDriver.invoke` and `VerificationDriver.verify`
(`packages/server/src/worker/extensions.ts`, `worker/verifier-driver.ts`) are
already the seam; `Executable.driverTarget` is already an opaque, registry-only
target. Protocol v1 invocations and results are unchanged.

## 3. Changes

### 3.1 Lambda drivers (server, AGPL)

Add `worker/lambda-driver.ts` with `LambdaDriver implements ExecutionDriver` and
`LambdaVerifier implements VerificationDriver`.

- `driverTarget` is a **qualified** function version ARN
  (`arn:aws:lambda:<region>:<account>:function:<name>:<version>`). The driver
  refuses an unqualified ARN, `$LATEST`, an alias, or a function name outside
  the configured prefix (`RETAINER_EXTENSION_LAMBDA_PREFIX`, for example
  `arn:aws:lambda:eu-central-1:123456789012:function:retainer-ext-`). IAM also
  limits what the caller can invoke; the prefix check makes a bad catalog fail
  loudly instead of relying on IAM alone. The existing `driverTarget` regex
  already admits ARNs.
- Invoke with `InvocationType: RequestResponse`. The payload is the protocol v1
  invocation JSON itself, without the launcher's `{bundleId, invocation}`
  envelope: the target is the ARN. Pass the caller's `AbortSignal`.
- Treat `FunctionError` (`Unhandled`), throttling (`TooManyRequestsException`),
  5xx and network errors as platform failures: throw, so the executor retries
  them as it retries "launcher unavailable" today. Parse a successful payload
  with `executionResultSchema` / `verificationResultSchema` and the existing
  64 KiB / 16 KiB caps.
- `LambdaVerifier` keeps `LauncherVerifier`'s checks: function and release must
  match the pinned executable, and the remaining deadline must be in (0, 5 s].
- Import `@aws-sdk/client-lambda` lazily, only when the Lambda driver is
  configured, as `file-storage/configuration.ts` already does for S3. Compose
  must never load it. Use the default credential chain; take no keys from
  configuration.

Configuration (`config.ts`, `extension-control/configuration.ts`):

- `RETAINER_EXTENSION_DRIVER=launcher|lambda`, default `launcher`.
- `lambda` requires `RETAINER_EXTENSION_LAMBDA_PREFIX` and does **not** require
  `RETAINER_EXTENSION_LAUNCHER_ORIGIN`, `RETAINER_LAUNCHER_TOKEN`,
  `RETAINER_EXTENSION_VERIFIER_ORIGIN` or `RETAINER_VERIFIER_TOKEN`. `launcher`
  keeps today's requirements exactly.
- Separation of duty is now IAM rather than two bearer tokens: the executor may
  invoke job functions, the ingress function only verifier functions. The
  configuration takes one prefix per role
  (`RETAINER_EXTENSION_LAMBDA_PREFIX` for jobs,
  `RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX` for verifiers) and refuses
  prefixes where one starts with the other, the way it refuses equal launcher
  and verifier tokens today.

### 3.2 Runner Lambda entry point (runner, MIT)

`packages/runner/src/index.ts` reads stdin and writes stdout. Split it:

- `runner/src/handle.ts`: `handle(text: string, mode)` containing today's
  `main()` logic (Node 24 check, size cap, decoding, release check, deadline,
  `settle`, `verifyWebhook`). Returns the result object.
- `runner/src/index.ts`: stdin/stdout wrapper around `handle`, unchanged
  behaviour for Compose.
- `runner/src/lambda.ts`: `export async function handler(event)`. A plain
  function: **no AWS packages** in the MIT runner. It serialises the event and
  calls `handle`. Lambda runs one invocation per execution environment at a
  time, so the per-invocation `AbortController` and timer stay correct.

Modes. A job function must not act as a verifier and the reverse. Both
functions ship the same code, so the mode comes from the function's
configuration: `RETAINER_RUNNER_MODE=job|verify`. `handle` rejects a
`kind: 'webhook'` invocation in `job` mode and a job invocation in `verify`
mode with `invalid_invocation`. Compose's stdin path accepts both, as today.

Release identity. The runner compares `invocation.releaseDigest` with
`RETAINER_BUNDLED_RELEASE_DIGEST`. In Lambda that value must travel with the
code, not with mutable function configuration, so the runner also reads it from
`release.json` beside `dist/` when the environment variable is absent. The
publisher writes that file into the zip (cloud spec). Environment wins when both
exist, so the Compose image is unchanged.

Health. Add a `{kind: 'health'}` invocation that returns
`{protocolVersion: 1, runtimeVersion: 'node24', releaseDigest, mode}` and does
nothing else. Deployment uses it to prove each pinned version holds the
expected release before restoring traffic, replacing the launcher `/health`
probe for hosted.

Warm reuse. Unlike a Compose container, a Lambda environment is reused for
later invocations, possibly for another installation. Required:

- No module-level state keyed by installation, workspace, connection or token.
  Audit `granola.ts`, `granola-provider.ts`, `last-contact.ts`, `webhooks.ts`
  and the SDK client for caches, memoised clients and singletons.
- No writes to `process.env`. No files under `/tmp` that outlive an invocation;
  delete anything written in a `finally`.
- Never log the invocation: it carries the run token and, for verifiers, the
  webhook secret. Lambda captures stdout/stderr into CloudWatch.
- Test: invoke `handler` twice in one process with different installations and
  run tokens against a recording HTTP server; assert the second run sees none of
  the first run's state or credentials, and `/tmp` is empty afterwards.

### 3.3 Executor coordinator for Lambda (server)

Today's hosted coordinator runs `executor.tick(4)` once a minute with
concurrency 1: at most four jobs per minute, while Compose's `run()` loop refills
slots continuously. With Lambda doing the work, the coordinator mostly waits on
network calls and can run more slots.

- Add `ExtensionExecutor.drain()`: stop claiming, let in-flight runs finish and
  acknowledge normally. `stop()` stays as is (it aborts and releases runs, which
  is right for shutdown, wrong for a planned hand-off).
- `lambda/executor.ts` becomes a bounded leader loop:
  1. Take a session advisory lock `EXECUTOR_LEADER` with `pg_try_advisory_lock`.
     If another invocation holds it, return `{skipped: true}` immediately.
  2. Hold the deploy pass lock shared, as now.
  3. Run `executor.run()` with `concurrency` from
     `RETAINER_EXECUTOR_CONCURRENCY` (default 8, max 32).
  4. Call `drain()` when either no work was due for 15 seconds, or the claim
     window ends: invocation deadline minus the longest handler timeout
     (300 s), minus the 15 s lease grace, minus a 30 s margin.
  5. Release the leader lock **when claiming stops**, before waiting for
     in-flight runs, so the next scheduled invocation can take over while this
     one drains.
- Per-installation, workspace and instance caps stay in the queue; the leader
  lock only prevents two coordinators claiming at once.
- Optional, later: after accepting a webhook delivery the ingress function may
  invoke the executor asynchronously to cut latency below the one-minute
  schedule. Not needed for v1.

### 3.4 Content-addressed release reuse (scripts)

`scripts/extension-release.mjs` versions every main commit as
`1.0.<rev-list --count HEAD>`, so every commit mints a new release digest for
every bundle, even when the bundle did not change. Keep the version scheme, and
let publication recognise unchanged content:

- `scripts/build-extension-artifacts.mjs` adds `contentDigest` to each bundle's
  `metadata.json`: SHA-256 of the stable JSON of the manifest **with `version`
  removed**. `packageDigest` already hashes the built `dist/` trees, package
  manifests and lockfile, and handler digests are in the manifest, so equal
  `contentDigest` means equal executable code, schema, server range and
  permissions.
- The cloud publisher reuses the newest retained release with the same
  `registrationId` and `contentDigest` instead of publishing a new one. The
  product needs no other change: installations keep their pinned release digest,
  and nothing asks them to upgrade.
- Test: build artifacts at two commits that differ only outside the runner
  inputs; `contentDigest` must match while `version` and `releaseDigest` differ.
  Change one runner source file; `contentDigest` must differ.

### 3.5 Operator status

`ops` `extension-runtime-status` probes the launcher origin. With the Lambda
driver it invokes `{kind: 'health'}` on every distinct `driverTarget` in the
packaged executables and returns `compatible: true` only if every response's
`releaseDigest` and `mode` match. It never takes a target from the payload. The
launcher form stays for Compose.

### 3.6 Documentation

- [extensions.md](extensions.md) §9.1: hosted runs on Lambda versions, verifiers
  in network-less Lambda, and the egress decision below. Keep the Compose
  description as is. §13: release changes no longer require a stopped rollout;
  migrations still do.
- `ARCHITECTURE.md`: the two execution drivers and how one is chosen.
- [extensions-implementation.md](extensions-implementation.md): record this
  change and what it supersedes.

## 4. Security model on Lambda

| Property | Compose launcher | Hosted Lambda |
| --- | --- | --- |
| Fresh process per run | Yes | No: one invocation at a time per environment, reused. Mitigated by §3.2. |
| Database reachable | No | No: job functions run outside the VPC; verifiers in isolated subnets with no egress. |
| Instance or host credentials | None | The function's own role credentials are in its environment. That role may write its own logs and nothing else. |
| Egress | Proxy, DNS/redirect validation, private ranges denied | Job functions: open internet, no VPC or metadata endpoint to reach. Verifiers: no network. |
| Resource limits | CPU/memory/PIDs/tmpfs per container | Memory, timeout and reserved concurrency per function. |

**Accepted relaxation: hosted egress.** The spec requires the egress boundary to
deny private and link-local destinations and validate DNS and redirects. Outside
a VPC a Lambda has no private network or metadata endpoint to reach, which
removes the main reason for that rule, but it can reach any public host. Hosted
execution runs only reviewed first-party code, so this is accepted for v1 and
must be revisited before any third-party code runs hosted. Keeping full parity
would need a VPC, NAT and a separately hosted proxy.

**Timeouts.** As in Twenty, aborting `Invoke` does not stop the function. The
cloud sets each job function's timeout to 310 s, the 300 s hard maximum plus a
margin, so Lambda kills it shortly after the lease ends. The run token already
expires at the run deadline, so a function still running after that cannot
write to Retainer; provider-side effects remain covered by provider idempotency.

## 5. Acceptance

- Unit: driver ARN validation (unqualified, `$LATEST`, alias, wrong prefix,
  wrong role prefix), error mapping, size caps, verifier deadline; runner mode
  rejection both ways; `release.json` fallback; health response; warm-reuse
  test from §3.2; `drain()` finishes runs without releasing them.
- Integration, real Postgres: two coordinator invocations race for the leader
  lock and only one claims; the leader hands off while draining and the next
  invocation claims immediately; a run that outlives the claim window still
  acknowledges.
- Compose: the existing launcher, isolation and webhook proofs pass unchanged,
  and the Compose build does not install or load `@aws-sdk/client-lambda`.
- Hosted acceptance is specified in the cloud spec (verifier has no network,
  job function cannot reach the VPC, cold-start budget for verifiers, role
  permissions, logs free of tokens).

## 6. Sequence

1. This PR: §3.1 to §3.6 with tests. Nothing hosted changes until the cloud PR
   configures `RETAINER_EXTENSION_DRIVER=lambda`.
2. retainer-cloud PR #11, reworked per its spec, deploys the merged main.
3. Hosted acceptance on staging, then enable.
