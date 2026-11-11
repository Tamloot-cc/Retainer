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
