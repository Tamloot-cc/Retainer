import type { Actor, SchemaChange as SchemaChangeView, SchemaOwner } from '@retainer/shared';
import { canApproveDestructive } from '../caller.js';
import type { ApiKeyScope, SchemaChangeStatus } from '../db/schema.js';
import { jsonValue, lockSchemaExclusive, type Tx } from '../db/tx.js';
import { AppError, forbidden, notFound } from '../errors.js';
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

function dedupe(issues: SchemaIssue[]): SchemaIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = issueKey(i);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  await lockSchemaExclusive(tx, workspaceId);
  const current = await loadSchemaState(tx, workspaceId);
  const { desired, ops } = planSchemaChange(
    current,
    request.operations,
    request.owner ?? ownerFor(actor),
    request.trusted,
  );

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
  };

  if (destructive && !request.trusted && !canApproveDestructive(actor, request.scopes)) {
    const change = await insertChange(tx, { ...row, status: 'proposed' });
    return { status: 'proposed', change, schemaVersion: await schemaVersion(tx, workspaceId) };
  }

  try {
    await checkExistingRecords(tx, workspaceId, current, desired, ops);
  } catch (error) {
    if (!(error instanceof SchemaCheckError)) throw error;
    const change = await insertChange(tx, {
      ...row,
      status: 'failed',
      error: error.message,
      decidedBy: actor,
    });
    return {
      status: 'failed',
      change,
      schemaVersion: await schemaVersion(tx, workspaceId),
      recordIds: error.recordIds,
    };
  }

  const version = await persistSchema(tx, workspaceId, current, desired, ops, actor);
  const change = await insertChange(tx, {
    ...row,
    status: 'applied',
    appliedVersion: version,
    decidedBy: actor,
  });
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
  },
): Promise<SchemaChangeResult> {
  const { workspaceId, changeId, actor } = input;
  if (!canApproveDestructive(actor, input.scopes)) {
    throw forbidden('only a user key with admin scope can decide schema changes');
  }
  await lockSchemaExclusive(tx, workspaceId);
  const [row] = await tx<ChangeRow[]>`
    select * from schema_changes where id = ${changeId} and workspace_id = ${workspaceId}
    for update`;
  if (!row) throw notFound('schema change');
  if (row.status !== 'proposed') {
    throw new AppError(409, 'already_decided', `this change is already ${row.status}`);
  }

  if (input.decision === 'reject') {
    const change = await updateChange(tx, changeId, { status: 'rejected', decidedBy: actor });
    return { status: 'rejected', change, schemaVersion: await schemaVersion(tx, workspaceId) };
  }

  const current = await loadSchemaState(tx, workspaceId);
  const operations = row.request as SchemaOperation[];
  let planned: ReturnType<typeof planSchemaChange>;
  try {
    planned = planSchemaChange(current, operations, ownerFor(row.requested_by));
    await checkExistingRecords(tx, workspaceId, current, planned.desired, planned.ops);
  } catch (error) {
    if (!(error instanceof SchemaValidationError || error instanceof SchemaCheckError)) throw error;
    const change = await updateChange(tx, changeId, {
      status: 'failed',
      decidedBy: actor,
      error: error.message,
    });
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
  const change = await updateChange(tx, changeId, {
    status: 'applied',
    decidedBy: actor,
    appliedVersion: version,
    operations: planned.ops,
  });
  return { status: 'applied', change, schemaVersion: version };
}

export async function getSchemaChange(
  tx: Tx,
  workspaceId: string,
  changeId: string,
): Promise<SchemaChangeView> {
  const [row] = await tx<ChangeRow[]>`
    select * from schema_changes where id = ${changeId} and workspace_id = ${workspaceId}`;
  if (!row) throw notFound('schema change');
  return toView(row);
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
  return rows.map(toView);
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
  decided_by: Actor | null;
  applied_version: number | null;
  error: string | null;
  created_at: Date;
  decided_at: Date | null;
};

function toView(row: ChangeRow): SchemaChangeView {
  return {
    id: row.id,
    status: row.status,
    operations: row.operations as DiffOp[],
    request: row.request as SchemaOperation[],
    isDestructive: row.is_destructive,
    reason: row.reason,
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
    decidedBy?: Actor;
    appliedVersion?: number;
    error?: string;
  },
): Promise<SchemaChangeView> {
  const decided = change.status !== 'proposed';
  const [row] = await tx<ChangeRow[]>`
    insert into schema_changes (workspace_id, status, request, operations, is_destructive, reason,
      requested_by, decided_by, applied_version, error, decided_at)
    values (${change.workspaceId}, ${change.status}, ${tx.json(change.request)},
      ${tx.json(jsonValue(change.operations))}, ${change.isDestructive}, ${change.reason},
      ${tx.json(change.requestedBy)}, ${change.decidedBy ? tx.json(change.decidedBy) : null},
      ${change.appliedVersion ?? null}, ${change.error ?? null},
      ${decided ? tx`now()` : null})
    returning *`;
  return toView(row as ChangeRow);
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
): Promise<SchemaChangeView> {
  const [row] = await tx<ChangeRow[]>`
    update schema_changes set status = ${update.status}, decided_by = ${tx.json(update.decidedBy)},
      decided_at = now(), applied_version = ${update.appliedVersion ?? null},
      error = ${update.error ?? null},
      operations = ${update.operations ? tx.json(jsonValue(update.operations)) : tx`operations`}
    where id = ${id}
    returning *`;
  return toView(row as ChangeRow);
}
