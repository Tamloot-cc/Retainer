# @retainer/extension

MIT build-time helpers for reviewed Retainer packages. `defineExtension`,
`defineFunction` and `defineView` validate JSON; they never register or execute
code in the server. Workspace callers cannot upload manifests or executables.

This initial contract supports additive objects/fields and table views. All
schema identities are UUIDs, field data remains keyed by permanent field keys,
and installation ownership is separate from schema `owner`.

The initial catalog accepts exact supported server versions, Node 24 and
protocol v1. Cron uses five UTC fields with lists, ranges, steps and month/weekday names. Settings are typed
scalar values; executable defaults, remote schemas/code and unknown kinds fail
validation. Nested input schemas require closed objects and bounded arrays.

The server supports reviewed installation approval, lifecycle, isolated hosted
jobs, source revisions, files, webhooks and change triggers. Table views are
created through the existing view service and retained across uninstall/reinstall.
The default catalog is empty; operators explicitly bundle reviewed releases and
configure their execution prerequisites before activation.

## Retries

Retry is opt-in. A hosted handler retries only when it returns
`{status: 'retry'}` or throws `RetryLater`:

```ts
import { RetryLater } from '@retainer/extension';

if (response.status === 429 || response.status >= 500)
  throw new RetryLater({ code: 'provider_unavailable', retryAfterSeconds: 60 });
```

Any other exception fails the run for good, including raw network errors from
your own `fetch` calls: catch them and throw `RetryLater` if they are transient.
Runs that hit the function's timeout retry as `execution_timeout`, with backoff.

Standalone manifests use `execution: 'standalone'` and may pin the registered
`oauthClientId` used for accounts-mode REST consent. Client identity is part of
the release digest and cannot change across releases of one registration.
Key-mode admins instead issue installation keys. Both identify the approved
workspace app and have no personal-memory access. Hosted queue/KV/secrets and
managed-source attestation continue to require a leased hosted invocation.
See [standalone app connections](../../docs/standalone-apps.md) for registration,
consent, SDK usage, credential rotation and source-write boundaries.

See `docs/specs/extensions.md` for the full acceptance specification and
`docs/specs/extensions-implementation.md` for outstanding delivery phases.

## Configure before turn-on

A hosted release may declare one `{ kind: 'configure' }` function with explicit
`scopes: ['read']` and a mapping or non-secret settings to suggest. A human first
approves read access and declared secrets. Retainer queues configure while the
installation is `configuring`; the final human approval applies schema, mapping
and write access and queues install.

Configure receives server-defined input:
`{ reason: 'install' | 'upgrade' | 'requested', previousVersion, newOutputs }`.
Use `RetainerClient.saveExtensionSuggestions(installationId, { mapping, settings })`
to save a partial suggestion. Mapping choices use current API field names and may
include a short `reason`. Suggestions are visible only after success, are checked
against the current schema, and never apply without human review. Each retry
starts with empty suggestions. Configure may read KV, but cannot write it, enqueue
children, write records, attest sources, register webhooks or write secrets.
Provider calls must not create durable resources; setup belongs to install.

Reviewed upgrades run target code with a separate release-pinned access approval;
the installed release keeps its code, grant and credentials until final approval.
See [the lifecycle contract](../../docs/specs/extensions-configure.md).
