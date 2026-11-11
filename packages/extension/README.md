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

The current server provides inert installation control only. Installations stay
disabled; releases needing secrets are refused until the broker is implemented.
There are no runtime credentials, provider calls, jobs, active integrations or
standalone installation OAuth grants in this slice. Table views are created
through the existing view service and retained across uninstall/reinstall.

See `docs/specs/extensions.md` for the full acceptance specification and
`docs/specs/extensions-implementation.md` for outstanding delivery phases.
