# Upgrading workspace definitions

Retainer upgrades the hidden internal types that source-free facts and
workspace and personal memory use. New workspaces seed the same definitions.
A workspace chooses its visible objects, event types and fields. A template
is a one-time copy. Its version in `workspaces.templates` records what was
copied.

The upgrade matches hidden elements by universal ID, including deprecated
rows. It adds missing internal definitions and sets their protection. A
renamed element keeps its identity. Core event title and summary fields retain
the protection they received at creation. An upgrade leaves existing
protection and field values in place.

Each workspace runs through the trusted schema engine as `system:retainer`
inside its exclusive schema lock. The engine computes and validates a diff
and records applied operations in `schema_changes`. Retainer stores a digest
of the internal definitions and protection rules in
`workspaces.definitions_digest`. The next upgrade skips a workspace with a
matching digest. A conflict or failure leaves the digest unchanged for retry.

The container and the Lambda migration command upgrade workspaces after
database migrations. The binding migration is separate from the workspace
upgrade. Before applying a release that introduces binding plans, an operator
can inspect each installation's proposed destinations, contact creation policy
changes and reason for removal with
`pnpm --filter @retainer/server migrate:bindings-report`. Use the rebuilt
extension catalog, including releases for installed apps that have no
bindings. Those installations receive an empty plan and keep their grants.
When the catalog omits a release and there is no record of a previous binding,
the report defers the installation without changing it. The report uses a
read-only transaction.
