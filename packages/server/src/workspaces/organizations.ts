import {
  isOrganizationRole,
  isWorkspaceRole,
  type OrganizationRole,
  type WorkspaceRole,
} from '@retainer/shared';
import type { Sql } from '../db/client.js';
import { DEFAULT_ORGANIZATION, getOrganization, type Organization } from '../db/organizations.js';
import type { OrganizationLimits } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { getWorkspace } from '../db/workspaces.js';
import { AppError } from '../errors.js';
import { endLostMemberships, membersOf } from './leaving.js';

/**
 * Organizations and their members (accounts spec 4.2, 4.5). Operator
 * operations: `sql` connects as the migration role or the control role.
 */

/** Serializes creating the default organization, so there is only one. */
const DEFAULT_ORGANIZATION_LOCK = 0x52544e05;

export async function createOrganization(
  sql: Sql | Tx,
  input: { name: string },
): Promise<Organization> {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid_request', 'an organization needs a name');
  const [row] = await sql<{ id: string }[]>`
    insert into organizations (name) values (${name}) returning id`;
  if (!row) throw new Error('insert returned no row');
  return getOrganization(sql, row.id);
}

/**
 * The organization a new workspace goes into: the one named, or the default
 * organization, created on first use. Runs inside the workspace's
 * transaction.
 */
export async function organizationForNewWorkspace(
  tx: Tx,
  idOrName: string = DEFAULT_ORGANIZATION,
): Promise<Organization> {
  if (idOrName !== DEFAULT_ORGANIZATION) return getOrganization(tx, idOrName);
  await tx`select pg_advisory_xact_lock(${DEFAULT_ORGANIZATION_LOCK})`;
  const [existing] = await tx<{ id: string }[]>`
    select id from organizations where name = ${DEFAULT_ORGANIZATION}
    order by created_at limit 1`;
  if (existing) return getOrganization(tx, existing.id);
  return createOrganization(tx, { name: DEFAULT_ORGANIZATION });
}

async function userByEmail(tx: Tx, email: string): Promise<{ id: string; email: string }> {
  const [user] = await tx<{ id: string; email: string }[]>`
    select id, email from users where lower(email) = ${email.trim().toLowerCase()}`;
  if (!user) {
    throw new AppError(
      404,
      'not_found',
      `nobody with the email "${email}" has signed in yet; ask them to sign in once first`,
    );
  }
  return user;
}

/**
 * Locks the organization's row, so concurrent membership changes see each
 * other: two owners demoting each other cannot leave none (4.5).
 */
export async function lockOrganization(tx: Tx, organizationId: string): Promise<void> {
  await tx`select 1 from organizations where id = ${organizationId} for update`;
}

/**
 * Locks the organization a workspace is in and returns its ID, or null when
 * there is no such workspace. Each read is a new statement, so a move that
 * commits while this waits is seen, and the lock follows the workspace to
 * where it went. Every move takes this lock on the organization it leaves,
 * so once the read and the lock agree, the workspace stays put until the
 * transaction ends.
 */
export async function lockWorkspaceOrganization(
  tx: Tx,
  workspaceId: string,
): Promise<string | null> {
  let locked: string | null = null;
  for (;;) {
    const [row] = await tx<{ organization_id: string }[]>`
      select organization_id from workspaces where id = ${workspaceId}`;
    if (!row) return null;
    if (row.organization_id === locked) return locked;
    await lockOrganization(tx, row.organization_id);
    locked = row.organization_id;
  }
}

/**
 * Refuses a change that would leave an organization that has an owner with
 * none. `Default` may start without one (4.2); once it has one, it keeps one.
 */
export async function assertKeepsAnOwner(tx: Tx, organizationId: string, userId: string) {
  const [{ others } = { others: 0 }] = await tx<{ others: number }[]>`
    select count(*)::int as others from organization_members
    where organization_id = ${organizationId} and role = 'owner' and user_id <> ${userId}`;
  if (others === 0) {
    throw new AppError(
      409,
      'last_owner',
      'An organization always keeps an owner; make someone else an owner first.',
    );
  }
}

const QUOTA_WORDS: Record<keyof OrganizationLimits, string> = {
  workspaces: 'workspaces',
  members: 'people',
};

/**
 * Refuses to go past an organization's quota (accounts spec 4.8, 4.10): its
 * workspaces, not counting those being deleted, or its people. A null limit
 * means none, which is every organization unless an operator sets one. Call
 * it holding the organization's lock, so two creations racing for the last
 * place see each other.
 */
export async function assertWithinLimit(
  tx: Tx,
  organizationId: string,
  kind: keyof OrganizationLimits,
): Promise<void> {
  const [row] = await tx<{ limit: number | null; used: number }[]>`
    select (o.limits ->> ${kind})::int as limit,
      ${
        kind === 'workspaces'
          ? tx`(select count(*)::int from workspaces w
              where w.organization_id = o.id and w.deletion_scheduled_at is null)`
          : tx`(select count(*)::int from organization_members m where m.organization_id = o.id)`
      } as used
    from organizations o where o.id = ${organizationId}`;
  if (row?.limit != null && row.used >= row.limit) {
    throw new AppError(
      409,
      'limit_reached',
      `This organization can have at most ${row.limit} ${QUOTA_WORDS[kind]}.`,
      { limit: row.limit, kind },
    );
  }
}

/** The largest quota: `assertWithinLimit` reads limits as a Postgres `int`. */
const MAX_LIMIT = 2_147_483_647;

/**
 * Sets an organization's quotas (4.10): a number, or null for none. Fields
 * left out keep their value. The billing seam: whatever decides plans writes
 * here, and Retainer only enforces it.
 */
export async function setOrganizationLimits(
  sql: Sql,
  input: { organization: string; limits: { [K in keyof OrganizationLimits]?: number | null } },
): Promise<{ organization: Organization; limits: OrganizationLimits }> {
  for (const [kind, value] of Object.entries(input.limits)) {
    if (
      value !== null &&
      value !== undefined &&
      !(Number.isInteger(value) && value >= 0 && value <= MAX_LIMIT)
    ) {
      throw new AppError(
        400,
        'invalid_request',
        `the ${kind} limit must be a whole number up to ${MAX_LIMIT}, or none`,
      );
    }
  }
  return sql.begin(async (tx) => {
    const organization = await getOrganization(tx, input.organization);
    await lockOrganization(tx, organization.id);
    const [row] = await tx<{ limits: OrganizationLimits | null }[]>`
      select limits from organizations where id = ${organization.id}`;
    const limits: OrganizationLimits = { ...(row?.limits ?? {}) };
    for (const kind of ['workspaces', 'members'] as const) {
      const value = input.limits[kind];
      if (value === null) delete limits[kind];
      else if (value !== undefined) limits[kind] = value;
    }
    const stored = Object.keys(limits).length > 0 ? limits : null;
    await tx`update organizations set limits = ${stored ? tx.json(stored) : null}
      where id = ${organization.id}`;
    return { organization, limits };
  });
}

/** Adds a person who has signed in to an organization, or changes their role. */
export async function setOrganizationMember(
  sql: Sql,
  input: { organization: string; email: string; role: string },
): Promise<{ organization: Organization; userId: string; role: OrganizationRole }> {
  const { role } = input;
  if (!isOrganizationRole(role)) {
    throw new AppError(400, 'invalid_request', 'role must be owner, admin or member');
  }
  return sql.begin(async (tx) => {
    const organization = await getOrganization(tx, input.organization);
    await lockOrganization(tx, organization.id);
    const user = await userByEmail(tx, input.email);
    const [current] = await tx<{ role: OrganizationRole }[]>`
      select role from organization_members
      where organization_id = ${organization.id} and user_id = ${user.id}`;
    if (current?.role === 'owner' && role !== 'owner') {
      await assertKeepsAnOwner(tx, organization.id, user.id);
    }
    const workspaces = await tx<{ id: string }[]>`
      select id from workspaces where organization_id = ${organization.id}`;
    const before = (
      await membersOf(
        tx,
        workspaces.map((w) => w.id),
      )
    ).filter((m) => m.userId === user.id);
    await tx`
      insert into organization_members (organization_id, user_id, role)
      values (${organization.id}, ${user.id}, ${role})
      on conflict (organization_id, user_id) do update set role = excluded.role`;
    // A lower role can end their access to workspaces, and with it their
    // personal memory there (personal memory spec 4.6).
    await endLostMemberships(tx, before, OPERATOR_ACTOR);
    return { organization, userId: user.id, role };
  });
}

/** Gives a member of the workspace's organization a role in the workspace. */
export async function setWorkspaceMember(
  sql: Sql,
  input: { workspace: string; email: string; role: string },
): Promise<{ workspaceId: string; userId: string; role: WorkspaceRole }> {
  const { role } = input;
  if (!isWorkspaceRole(role)) {
    throw new AppError(400, 'invalid_request', 'workspace role must be viewer, editor or admin');
  }
  return sql.begin(async (tx) => {
    const { id } = await getWorkspace(tx, input.workspace);
    // The organization is read under its lock, so a move that lands first is seen.
    const organizationId = await lockWorkspaceOrganization(tx, id);
    if (!organizationId) {
      throw new AppError(404, 'not_found', `workspace "${input.workspace}" not found`);
    }
    const user = await userByEmail(tx, input.email);
    const [member] = await tx`
      select 1 from organization_members
      where organization_id = ${organizationId} and user_id = ${user.id}`;
    if (!member) {
      throw new AppError(
        409,
        'not_a_member',
        `${user.email} is not in this workspace's organization; add them to it first`,
      );
    }
    await tx`
      insert into workspace_members (organization_id, workspace_id, user_id, role)
      values (${organizationId}, ${id}, ${user.id}, ${role})
      on conflict (workspace_id, user_id) do update set role = excluded.role`;
    return { workspaceId: id, userId: user.id, role };
  });
}

/**
 * Moves a workspace to another organization. Its members' roles there are
 * removed, since they belong to the old organization; its data, keys and
 * agents are unchanged.
 */
export async function moveWorkspace(
  sql: Sql,
  input: { workspace: string; organization: string },
): Promise<{ organization: Organization; removedMembers: number }> {
  return sql.begin(async (tx) => {
    const workspace = await getWorkspace(tx, input.workspace);
    const organization = await getOrganization(tx, input.organization);
    const from = await lockWorkspaceOrganization(tx, workspace.id);
    if (!from) throw new AppError(404, 'not_found', `workspace "${input.workspace}" not found`);
    if (organization.id === from) return { organization, removedMembers: 0 };
    const before = await membersOf(tx, [workspace.id]);
    const removed = await tx`
      delete from workspace_members where workspace_id = ${workspace.id} returning 1`;
    // Who may use it changes, so apps connected to it must be connected again.
    await endGrants(tx, tx`oc.reference_id = ${workspace.id}`);
    await tx`
      update workspaces set organization_id = ${organization.id} where id = ${workspace.id}`;
    // People who lose it lose their personal memory in it (personal memory 4.6).
    await endLostMemberships(tx, before, OPERATOR_ACTOR);
    return { organization, removedMembers: removed.length };
  });
}

/**
 * Ends apps' access to a workspace (accounts spec 4.7): deletes the consents
 * `where` matches (on `oauth_consents oc`) and revokes their refresh tokens,
 * so the apps lose access at their next request and cannot regain it
 * without the person consenting again. Returns how many were ended.
 */
export async function endGrants(tx: Tx, where: ReturnType<Sql>): Promise<number> {
  const [row] = await tx<{ ended: number }[]>`
    with ended as (
      delete from oauth_consents oc where ${where}
      returning oc.client_id, oc.user_id, oc.reference_id
    ), revoked as (
      update oauth_refresh_tokens r set revoked = now()
      from ended e
      where r.client_id = e.client_id and r.user_id = e.user_id
        and r.reference_id = e.reference_id and r.revoked is null
    )
    select count(*)::int as ended from ended`;
  return row?.ended ?? 0;
}

/** Who the operator's membership changes are recorded as. */
const OPERATOR_ACTOR = { type: 'system' as const, id: 'operator' };
