import { AppError } from '../errors.js';
import type { Sql } from './client.js';
import { isUuid } from './ids.js';
import type { Tx } from './tx.js';

export type Workspace = {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  schemaVersion: number;
  templates: { name: string; version: number; appliedAt: string }[];
  initializedAt: string | null;
  /** Set when someone deleted it; it is removed for good after a grace period. */
  deletionScheduledAt: string | null;
  createdAt: string;
};

type WorkspaceRow = {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  schema_version: number;
  templates: Workspace['templates'];
  initialized_at: Date | null;
  deletion_scheduled_at: Date | null;
  created_at: Date;
};

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    name: row.name,
    schemaVersion: row.schema_version,
    templates: row.templates,
    initializedAt: row.initialized_at?.toISOString() ?? null,
    deletionScheduledAt: row.deletion_scheduled_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getWorkspace(sql: Sql | Tx, idOrSlug: string): Promise<Workspace> {
  const [row] = await sql<WorkspaceRow[]>`
    select * from workspaces where ${isUuid(idOrSlug) ? sql`id = ${idOrSlug}` : sql`slug = ${idOrSlug}`}`;
  if (!row) throw new AppError(404, 'not_found', `workspace "${idOrSlug}" not found`);
  return toWorkspace(row);
}

/** The workspace of a workspace transaction (RLS shows only that one). */
export async function readWorkspace(tx: Tx, id: string): Promise<Workspace> {
  const [row] = await tx<WorkspaceRow[]>`select * from workspaces where id = ${id}`;
  if (!row) throw new AppError(404, 'not_found', `workspace "${id}" not found`);
  return toWorkspace(row);
}

export async function listWorkspaces(sql: Sql): Promise<Workspace[]> {
  const rows = await sql<WorkspaceRow[]>`select * from workspaces order by created_at, id`;
  return rows.map(toWorkspace);
}
