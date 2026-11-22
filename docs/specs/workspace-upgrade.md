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
can inspect each installation's proposed destination or reason for removal
with `pnpm --filter @retainer/server migrate:bindings-report`. The report
requires the rebuilt extension catalog and connects with a read-only
transaction.
