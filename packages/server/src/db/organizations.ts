import type { OrganizationRole } from '@retainer/shared';
import { AppError } from '../errors.js';
import type { Sql } from './client.js';
import { isUuid } from './ids.js';
import type { Tx } from './tx.js';

/** The organization existing workspaces move into, and the CLI's default (4.2). */
export const DEFAULT_ORGANIZATION = 'Default';

export type Organization = { id: string; name: string; createdAt: string };

export type OrganizationSummary = Organization & {
  workspaces: number;
  members: number;
  owners: number;
};

type OrganizationRow = { id: string; name: string; created_at: Date };

const toOrganization = (row: OrganizationRow): Organization => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
});

/**
 * An organization by ID or by its exact name. Names are not unique, so a
 * name two organizations share is refused; use the ID.
 */
export async function getOrganization(sql: Sql | Tx, idOrName: string): Promise<Organization> {
  const rows = await sql<OrganizationRow[]>`
    select id, name, created_at from organizations
    where ${isUuid(idOrName) ? sql`id = ${idOrName}` : sql`name = ${idOrName}`}
    order by created_at limit 2`;
  const [row] = rows;
  if (!row) throw new AppError(404, 'not_found', `organization "${idOrName}" not found`);
  if (rows.length > 1) {
    throw new AppError(
      409,
      'ambiguous',
      `more than one organization is named "${idOrName}"; use its ID (retainer-ops org list)`,
    );
  }
  return toOrganization(row);
}

export async function listOrganizations(sql: Sql): Promise<OrganizationSummary[]> {
  const rows = await sql<(OrganizationRow & Omit<OrganizationSummary, keyof Organization>)[]>`
    select o.id, o.name, o.created_at,
      (select count(*)::int from workspaces w where w.organization_id = o.id) as workspaces,
      (select count(*)::int from organization_members m where m.organization_id = o.id) as members,
      (select count(*)::int from organization_members m
        where m.organization_id = o.id and m.role = 'owner') as owners
    from organizations o order by o.created_at, o.id`;
  return rows.map((row) => ({
    ...toOrganization(row),
    workspaces: row.workspaces,
    members: row.members,
    owners: row.owners,
  }));
}

export type OrganizationMember = {
  userId: string;
  email: string;
  name: string;
  role: OrganizationRole;
};
