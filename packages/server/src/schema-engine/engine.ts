import {
  type Actor,
  HIDDEN_TYPE_IDS,
  type SchemaChange as SchemaChangeView,
  type SchemaOwner,
} from '@retainer/shared';
import { canApproveDestructive } from '../caller.js';
import { type CliDecision, recheckElevation } from '../db/cli.js';
import type { ApiKeyScope, AppliedTemplate, SchemaChangeStatus } from '../db/schema.js';
import { jsonValue, lockPrivacyShared, lockSchemaExclusive, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { type StoredBindingPlan, validateBindingPlan } from '../extension-runtime/bindings.js';
import { getSchema } from '../schema/compiled.js';
import { loadSchemaState } from '../schema/load.js';
import {
  type DiffOp,
  type SchemaIssue,
  type SchemaState,
  SchemaValidationError,
} from '../schema/types.js';
import { applyOperations } from './apply.js';
import { diffSchemas, isDestructive } from './diff.js';
import type { SchemaOperation } from './operations.js';
import { checkExistingRecords, persistSchema, SchemaCheckError } from './persist.js';
import { presentDiff } from './present.js';
import { applyProtection } from './protection.js';
import { issueKey, validateSchema } from './validate.js';

/** The server's own actor, for seeding and upgrades. */
export const SYSTEM_ACTOR: Actor = { type: 'system', id: 'retainer' };

export type SchemaChangeRequest = {
  workspaceId: string;
  actor: Actor;
  scopes: readonly ApiKeyScope[];
  operations: SchemaOperation[];
  reason?: string;
  replacingBindingPlan?: string;
  template?: Pick<AppliedTemplate, 'name' | 'version'>;
  /** Owner of what the change creates; defaults from the actor's type. */
  owner?: SchemaOwner;
  /**
   * Code-defined schema applied by the server itself (workspace seeding and
   * upgrades). Never set from a request: scope alone is not human approval.
   */
  trusted?: boolean;
};

export type { SchemaChange as SchemaChangeView } from '@retainer/shared';

export type SchemaChangeResult = {
  /** `unchanged` when the schema already matches the request. */
  status: SchemaChangeStatus | 'unchanged';
  change: SchemaChangeView | null;
  schemaVersion: number;
  /** For a failed change: records that conflict with it. */
  recordIds?: string[];
};

export function ownerFor(actor: Actor): SchemaOwner {
  if (actor.type === 'system') return 'system';
  if (actor.type === 'agent') return 'agent';
  return 'workspace';
}

/**
 * Steps 2–5: apply in memory, validate, diff. Throws SchemaValidationError.
 * On the trusted path, the engine also protects the elements server code
 * depends on, which older workspaces may not have protected yet.
 */
export function planSchemaChange(
  current: SchemaState,
  operations: SchemaOperation[],
  owner: SchemaOwner,
  trusted = false,
) {
  const { state: desired, issues } = applyOperations(current, operations, { owner });
  if (trusted) applyProtection(desired);
  // Reference issues first; validation of a half-applied state can repeat them.
  let all = [...issues, ...validateSchema(desired)];
  if (trusted) {
    // Code-defined schema must not be blocked by an issue the workspace
    // already has, such as a name a later release reserved: only issues
    // the change itself introduces count.
    const existing = new Set(validateSchema(current).map(issueKey));
    all = all.filter((i) => !existing.has(issueKey(i)));
  }
  if (all.length > 0) throw new SchemaValidationError(dedupe(all));
  return { desired, ops: diffSchemas(current, desired) };
}

/**
 * An installed extension's contributed objects and fields can't be deleted:
 * its plans, views and triggers bind to them, and deletion is permanent.
 * Like Twenty's app-owned metadata, only labels and names are workspace-local.
 * Uninstalling the extension releases them. Runs inside the schema lock.
 */
async function refuseContributedDeletes(tx: Tx, current: SchemaState, desired: SchemaState) {
  const deleted = new Map<string, string>();
  for (const object of desired.objects) {
    const before = current.objects.find((o) => o.universalId === object.universalId);
    if (!before) continue;
    if (object.status === 'deprecated' && before.status === 'active' && before.id)
      deleted.set(before.id, object.nameSingular);
    for (const field of object.fields) {
      const prior = before.fields.find((f) => f.universalId === field.universalId);
      if (field.status === 'deprecated' && prior?.status === 'active' && prior.id)
        deleted.set(prior.id, `${object.nameSingular}.${field.name}`);
    }
  }
  if (deleted.size === 0) return;
  const managed = await tx<
    { element_id: string; installation_id: string; registration_id: string }[]
  >`
    select c.element_id, c.installation_id, i.registration_id from extension_contributions c
    join extension_installations i on i.id = c.installation_id
    where c.kind in ('object', 'field') and i.state <> 'uninstalled'
      and c.element_id = any(${[...deleted.keys()]}::uuid[])
    order by c.element_id`;
  if (managed.length === 0) return;
  throw new SchemaValidationError(
    managed.map((row) => ({
      path: deleted.get(row.element_id) ?? row.element_id,
      message:
        `belongs to extension installation ${row.installation_id} ` +
        `(registration ${row.registration_id}), so it cannot be deleted; ` +
        'rename or relabel it instead, or uninstall that extension first',
    })),
  );
}

/** Runs under the same exclusive lock as installation approvals. */
async function validateInstalledBindings(
  tx: Tx,
  workspaceId: string,
  state: SchemaState,
  replacing?: string,
) {
  const installations = await tx<{ id: string; bindings: StoredBindingPlan }[]>`
    select id, bindings from extension_installations
    where workspace_id = ${workspaceId} and state <> 'uninstalled' and jsonb_typeof(bindings->'declarations') = 'array'
      ${replacing ? tx`and id <> ${replacing}` : tx``}
    order by id`;
  const issues = installations.flatMap(({ id, bindings }) =>
    validateBindingPlan(state, bindings).map((issue) => ({
      path: [issue.binding, issue.field].filter(Boolean).join('.'),
      message: `${bindings.extension} needs this binding. Change ${bindings.extension}'s setup first. ${issue.message} (Installation ${id}.)`,
    })),
  );
  if (issues.length) throw new SchemaValidationError(issues);
}

function dedupe(issues: SchemaIssue[]): SchemaIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = issueKey(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function requireTemplateDestination(
  tx: Tx,
  current: SchemaState,
  workspaceId: string,
  operations: readonly SchemaOperation[],
) {
  const [row] = await tx<{ templates: AppliedTemplate[] }[]>`
    select templates from workspaces where id = ${workspaceId}`;
  if (!row) throw notFound('workspace');
  if (
    row.templates.length ||
    current.objects.some((o) => o.status === 'active' && !HIDDEN_TYPE_IDS.has(o.universalId))
  ) {
    throw new AppError(
      409,
      'workspace_not_empty',
      'A template can only be copied into an empty workspace. Propose individual schema changes instead.',
    );
  }
  const retired = new Set(
    current.objects
      .filter((object) => object.status === 'deprecated')
      .map((object) => object.universalId),
  );
  const clash = operations.find(
    (operation) =>
      operation.op === 'create_object' &&
      operation.object.universalId &&
      retired.has(operation.object.universalId),
  );
  if (clash?.op === 'create_object')
    throw new AppError(
      409,
      'template_retained_identity',
      `A deleted object still holds the template identity for ${clash.object.labelSingular}. Propose individual schema changes instead.`,
    );
}

async function recordTemplate(
  tx: Tx,
  workspaceId: string,
  template: NonNullable<SchemaChangeRequest['template']>,
) {
  const applied: AppliedTemplate = { ...template, appliedAt: new Date().toISOString() };
  await tx`
    update workspaces set templates = templates || ${tx.json([applied])}
    where id = ${workspaceId}`;
}

/**
 * The one entry point for schema changes (ARCHITECTURE.md 3). Runs in the
 * caller's workspace transaction, holding the workspace's exclusive schema
 * lock until it commits.
 */
export async function runSchemaChange(
  tx: Tx,
  request: SchemaChangeRequest,
): Promise<SchemaChangeResult> {
  const { workspaceId, actor } = request;
  await lockPrivacyShared(tx, workspaceId);
  await lockSchemaExclusive(tx, workspaceId);
  const current = await loadSchemaState(tx, workspaceId);
  if (request.template)
    await requireTemplateDestination(tx, current, workspaceId, request.operations);
  const { desired, ops } = planSchemaChange(
    current,
    request.operations,
    request.owner ?? ownerFor(actor),
    request.trusted,
  );

  await validateInstalledBindings(tx, workspaceId, desired, request.replacingBindingPlan);
  await refuseContributedDeletes(tx, current, desired);

  if (ops.length === 0) {
    return {
      status: 'unchanged',
      change: null,
      schemaVersion: await schemaVersion(tx, workspaceId),
    };
  }

  const destructive = isDestructive(ops);
  const row = {
    workspaceId,
    request: request.operations,
    operations: ops,
    isDestructive: destructive,
    reason: request.reason ?? null,
    requestedBy: actor,
    template: request.template,
  };

  if (
    !request.trusted &&
    (request.template || (destructive && !canApproveDestructive(actor, request.scopes)))
  ) {
    const change = await insertChange(tx, { ...row, status: 'proposed' }, current);
    return { status: 'proposed', change, schemaVersion: await schemaVersion(tx, workspaceId) };
  }

  try {
    await checkExistingRecords(tx, workspaceId, current, desired, ops);
  } catch (error) {
    if (!(error instanceof SchemaCheckError)) throw error;
    const change = await insertChange(
      tx,
      { ...row, status: 'failed', error: error.message, decidedBy: actor },
      current,
    );
    return {
      status: 'failed',
      change,
      schemaVersion: await schemaVersion(tx, workspaceId),
      recordIds: error.recordIds,
    };
  }

  const version = await persistSchema(tx, workspaceId, current, desired, ops, actor);
  if (request.template) await recordTemplate(tx, workspaceId, request.template);
  const change = await insertChange(
    tx,
    { ...row, status: 'applied', appliedVersion: version, decidedBy: actor },
    current,
  );
  return { status: 'applied', change, schemaVersion: version };
}

/**
 * Approves or rejects a proposed change. Approval re-runs the engine on the
 * requested operations against the schema as it is now; if they no longer
 * validate, the change is marked failed with the error.
 */
export async function decideSchemaChange(
  tx: Tx,
  input: {
    workspaceId: string;
    changeId: string;
    actor: Actor;
    scopes: readonly ApiKeyScope[];
    decision: 'approve' | 'reject';
    cli?: CliDecision;
  },
): Promise<SchemaChangeResult> {
  const { workspaceId, changeId, actor } = input;
  if (!canApproveDestructive(actor, input.scopes)) {
    throw forbidden('only a user key with admin scope can decide schema changes');
  }
  await lockPrivacyShared(tx, workspaceId);
  await lockSchemaExclusive(tx, workspaceId);
  const [row] = await tx<ChangeRow[]>`
    select * from schema_changes where id = ${changeId} and workspace_id = ${workspaceId}
    for update`;
  await recheckElevation(tx, input.cli, 'admin');
  if (!row) throw notFound('schema change');
  if (row.status !== 'proposed') {
    throw new AppError(409, 'already_decided', `this change is already ${row.status}`);
  }

  const current = await loadSchemaState(tx, workspaceId);
  if (input.decision === 'reject') {
    const change = await updateChange(
      tx,
      changeId,
      { status: 'rejected', decidedBy: actor },
      current,
    );
    return { status: 'rejected', change, schemaVersion: await schemaVersion(tx, workspaceId) };
  }

  const operations = row.request as SchemaOperation[];
  if (row.template) await requireTemplateDestination(tx, current, workspaceId, operations);
  let planned: ReturnType<typeof planSchemaChange>;
  try {
    planned = planSchemaChange(
      current,
      operations,
      row.template ? 'workspace' : ownerFor(row.requested_by),
    );
    await validateInstalledBindings(tx, workspaceId, planned.desired);
    await refuseContributedDeletes(tx, current, planned.desired);
    await checkExistingRecords(tx, workspaceId, current, planned.desired, planned.ops);
  } catch (error) {
    if (!(error instanceof SchemaValidationError || error instanceof SchemaCheckError)) throw error;
    const change = await updateChange(
      tx,
      changeId,
      { status: 'failed', decidedBy: actor, error: error.message },
      current,
    );
    return {
      status: 'failed',
      change,
      schemaVersion: await schemaVersion(tx, workspaceId),
      ...(error instanceof SchemaCheckError ? { recordIds: error.recordIds } : {}),
    };
  }

  const version =
    planned.ops.length > 0
      ? await persistSchema(tx, workspaceId, current, planned.desired, planned.ops, actor)
      : await schemaVersion(tx, workspaceId);
  if (row.template) await recordTemplate(tx, workspaceId, row.template);
  const change = await updateChange(
    tx,
    changeId,
    { status: 'applied', decidedBy: actor, appliedVersion: version, operations: planned.ops },
    current,
  );
  return { status: 'applied', change, schemaVersion: version };
}

export async function getSchemaChange(
  tx: Tx,
  workspaceId: string,
  changeId: string,
): Promise<SchemaChangeView> {
  const [change] = await getSchemaChanges(tx, workspaceId, [changeId]);
  if (!change) throw notFound('schema change');
  return change;
}

/** Several changes in the order given, read against one load of the schema; unknown IDs are left out. */
export async function getSchemaChanges(
  tx: Tx,
  workspaceId: string,
  changeIds: readonly string[],
): Promise<SchemaChangeView[]> {
  if (!changeIds.length) return [];
  const rows = await tx<ChangeRow[]>`
    select * from schema_changes
    where workspace_id = ${workspaceId} and id = any(${changeIds as string[]}::uuid[])`;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const { state } = await getSchema(tx, workspaceId);
  return changeIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toView(row, state)] : [];
  });
}

export async function listSchemaChanges(
  tx: Tx,
  workspaceId: string,
  status: SchemaChangeStatus | undefined,
  limit: number,
): Promise<SchemaChangeView[]> {
  const rows = await tx<ChangeRow[]>`
    select * from schema_changes
    where workspace_id = ${workspaceId} ${status ? tx`and status = ${status}` : tx``}
    order by created_at desc, id desc limit ${limit}`;
  const { state } = await getSchema(tx, workspaceId);
  return rows.map((row) => toView(row, state));
}

async function schemaVersion(tx: Tx, workspaceId: string): Promise<number> {
  const [row] = await tx<{ schema_version: number }[]>`
    select schema_version from workspaces where id = ${workspaceId}`;
  return row?.schema_version ?? 0;
}

type ChangeRow = {
  id: string;
  status: SchemaChangeStatus;
  request: unknown[];
  operations: unknown[];
  is_destructive: boolean;
  reason: string | null;
  requested_by: Actor;
  template: SchemaChangeRequest['template'] | null;
  decided_by: Actor | null;
  applied_version: number | null;
  error: string | null;
  created_at: Date;
  decided_at: Date | null;
};

/**
 * What a change does, against `state`. A proposal is planned again, since
 * approving re-runs the engine against the schema as it is then: it may now
 * change nothing. One that no longer applies keeps the diff it was proposed
 * with, so the reviewer sees what was asked.
 */
function changeDiff(row: ChangeRow, state: SchemaState): DiffOp[] {
  const stored = row.operations as DiffOp[];
  if (row.status !== 'proposed') return stored;
  try {
    const { ops } = planSchemaChange(
      state,
      row.request as SchemaOperation[],
      row.template ? 'workspace' : ownerFor(row.requested_by),
    );
    return ops;
  } catch (error) {
    if (error instanceof SchemaValidationError) return stored;
    throw error;
  }
}

/** A stored change as the API shows it, its diff by name against `state`. */
function toView(row: ChangeRow, state: SchemaState): SchemaChangeView {
  const ops = changeDiff(row, state);
  return {
    id: row.id,
    status: row.status,
    operations: presentDiff(ops, state),
    request: row.request as SchemaOperation[],
    // A re-planned proposal is destructive only if what approving would do now is.
    isDestructive: ops === row.operations ? row.is_destructive : isDestructive(ops),
    reason: row.reason,
    ...(row.template ? { template: row.template.name } : {}),
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    appliedVersion: row.applied_version,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

async function insertChange(
  tx: Tx,
  change: {
    workspaceId: string;
    status: SchemaChangeStatus;
    request: SchemaOperation[];
    operations: DiffOp[];
    isDestructive: boolean;
    reason: string | null;
    requestedBy: Actor;
    template?: SchemaChangeRequest['template'];
    decidedBy?: Actor;
    appliedVersion?: number;
    error?: string;
  },
  state: SchemaState,
): Promise<SchemaChangeView> {
  const decided = change.status !== 'proposed';
  const [row] = await tx<ChangeRow[]>`
    insert into schema_changes (workspace_id, status, request, operations, is_destructive, reason,
      requested_by, decided_by, applied_version, error, decided_at, template)
    values (${change.workspaceId}, ${change.status}, ${tx.json(change.request)},
      ${tx.json(jsonValue(change.operations))}, ${change.isDestructive}, ${change.reason},
      ${tx.json(change.requestedBy)}, ${change.decidedBy ? tx.json(change.decidedBy) : null},
      ${change.appliedVersion ?? null}, ${change.error ?? null},
      ${decided ? tx`now()` : null}, ${change.template ? tx.json(change.template) : null})
    returning *`;
  return toView(row as ChangeRow, state);
}

async function updateChange(
  tx: Tx,
  id: string,
  update: {
    status: SchemaChangeStatus;
    decidedBy: Actor;
    appliedVersion?: number;
    error?: string;
    operations?: DiffOp[];
  },
  state: SchemaState,
): Promise<SchemaChangeView> {
  const [row] = await tx<ChangeRow[]>`
    update schema_changes set status = ${update.status}, decided_by = ${tx.json(update.decidedBy)},
      decided_at = now(), applied_version = ${update.appliedVersion ?? null},
      error = ${update.error ?? null},
      operations = ${update.operations ? tx.json(jsonValue(update.operations)) : tx`operations`}
    where id = ${id}
    returning *`;
  return toView(row as ChangeRow, state);
}
