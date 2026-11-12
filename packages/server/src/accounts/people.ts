import { createHash, randomBytes } from 'node:crypto';
import {
  effectiveWorkspaceRole,
  isKeyAccess,
  isOrganizationManager,
  isOrganizationRole,
  isWorkspaceRole,
  KEY_ACCESS,
  type OrganizationRole,
  type WorkspaceRole,
} from '@retainer/shared';
import { type ApiKeyListing, type CreatedApiKey, createApiKey } from '../auth/keys.js';
import type { Sql } from '../db/client.js';
import { RUNTIME_ROLE } from '../db/client.js';
import { isUuid } from '../db/ids.js';
import type { InvitedWorkspace } from '../db/schema.js';
import { inWorkspaceTransaction, type Tx } from '../db/tx.js';
import { getWorkspace, type Workspace } from '../db/workspaces.js';
import { AppError, forbidden, notFound } from '../errors.js';
import type { RuntimeCatalog } from '../extension-runtime/availability.js';
import { SYSTEM_ACTOR } from '../schema-engine/engine.js';
import { applyTemplate, seedBaseObjects } from '../templates/apply.js';
import { DELETION_GRACE_DAYS, purgeAfter, uninstallExtensions } from '../workspaces/deletion.js';
import { endLostMemberships, organizationMemberships } from '../workspaces/leaving.js';
import {
  assertKeepsAnOwner,
  assertWithinLimit,
  createOrganization,
  endGrants,
  lockOrganization,
  lockWorkspaceOrganization,
} from '../workspaces/organizations.js';
import { slugify } from '../workspaces/workspaces.js';

/**
 * What people do to their own organizations and workspaces from the web app
 * (accounts spec 4.5): every function takes the signed-in person and checks
 * what they may do. `sql` connects as the control role. Routes check that
 * IDs are UUIDs before calling these.
 */

export type Person = { id: string; name: string; email: string };

/** Organization owners and admins are admin there already; it is changed on the organization. */
const organizationAdminConflict = () =>
  new AppError(
    409,
    'organization_admin',
    "They're admin in every workspace through the organization; change it there.",
  );

async function organizationRole(
  tx: Tx | Sql,
  organizationId: string,
  userId: string,
): Promise<OrganizationRole | null> {
  const [row] = await tx<{ role: OrganizationRole }[]>`
    select role from organization_members
    where organization_id = ${organizationId} and user_id = ${userId}`;
  return row?.role ?? null;
}

type WorkspaceAccess = {
  workspace: { id: string; organizationId: string };
  role: WorkspaceRole;
};

/**
 * The person's access to a workspace, in one query. No role is a 404, the
 * same answer as a workspace that does not exist (4.4).
 */
export async function workspaceAccess(
  tx: Tx | Sql,
  person: Person,
  id: string,
): Promise<WorkspaceAccess> {
  const [row] = await tx<
    {
      organization_id: string;
      organization_role: OrganizationRole | null;
      workspace_role: WorkspaceRole | null;
    }[]
  >`
    select w.organization_id, om.role as organization_role, wm.role as workspace_role
    from workspaces w
    left join organization_members om
      on om.organization_id = w.organization_id and om.user_id = ${person.id}
    left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = ${person.id}
    where w.id = ${id} and w.deletion_scheduled_at is null`;
  const role = row ? effectiveWorkspaceRole(row.organization_role, row.workspace_role) : null;
  if (!row || !role) throw notFound('workspace');
  return { workspace: { id, organizationId: row.organization_id }, role };
}

async function requireWorkspaceAdmin(tx: Tx | Sql, person: Person, id: string) {
  const access = await workspaceAccess(tx, person, id);
  if (access.role !== 'admin') throw forbidden('Only a workspace admin can do this.');
  return access;
}

/**
 * Runs a workspace admin's change in one transaction that holds the lock on
 * the workspace's organization, the lock `moveWorkspace` and role changes
 * also take. The admin check comes after the lock, so a concurrent move or
 * role change lands before the check, never between the check and the write.
 */
async function asWorkspaceAdmin<T>(
  sql: Sql,
  person: Person,
  workspaceId: string,
  write: (tx: Tx, workspace: WorkspaceAccess['workspace']) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await lockWorkspaceOrganization(tx, workspaceId);
    const { workspace } = await requireWorkspaceAdmin(tx, person, workspaceId);
    return write(tx, workspace);
  })) as T;
}

async function requireOrganizationManager(
  tx: Tx | Sql,
  person: Person,
  organizationId: string,
): Promise<OrganizationRole> {
  const role = await organizationRole(tx, organizationId, person.id);
  if (!role) throw notFound('organization');
  if (!isOrganizationManager(role)) {
    throw forbidden('Only an owner or admin of the organization can do this.');
  }
  return role;
}

/**
 * Runs an organization owner's or admin's change in one transaction that
 * holds the organization's lock, the one every membership change takes. The
 * role is read after the lock, so a concurrent demotion or removal lands
 * before the check, never between the check and the write.
 */
async function asOrganizationManager<T>(
  sql: Sql,
  person: Person,
  organizationId: string,
  write: (tx: Tx, role: OrganizationRole) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await lockOrganization(tx, organizationId);
    return write(tx, await requireOrganizationManager(tx, person, organizationId));
  })) as T;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** Serializes a person's workspace creation, so two first ones make one organization. */
const FIRST_WORKSPACE_LOCK = 0x52544e06;

/** `sales-x7k2`: slugs are unique across customers, so a plain one would reveal names (4.5). */
function suffixedSlug(name: string): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const suffix = Array.from(randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `${slugify(name) || 'workspace'}-${suffix}`;
}

/**
 * Creates a workspace in one transaction (4.5). Without an organization, a
 * person who belongs to none gets their own, as its owner: their first
 * workspace. Otherwise it goes into the organization named, or the first one
 * they manage. The account rows are written as the control role, then the
 * transaction switches to the runtime role to seed under RLS.
 */
export async function createWorkspaceFor(
  sql: Sql,
  person: Person,
  input: { name: string; template?: string; organizationId?: string },
): Promise<Workspace> {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid_request', 'a workspace needs a name');
  const id = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${FIRST_WORKSPACE_LOCK}, hashtext(${person.id}))`;
    const organizationId = input.organizationId ?? (await organizationForPerson(tx, person));
    // The lock, then the checks, as in asOrganizationManager.
    await lockOrganization(tx, organizationId);
    await requireOrganizationManager(tx, person, organizationId);
    await assertWithinLimit(tx, organizationId, 'workspaces');

    let workspaceId: string | undefined;
    for (let attempt = 0; !workspaceId && attempt < 5; attempt++) {
      const [row] = await tx<{ id: string }[]>`
        insert into workspaces (organization_id, slug, name)
        values (${organizationId}, ${suffixedSlug(name)}, ${name})
        on conflict (slug) do nothing returning id`;
      workspaceId = row?.id;
    }
    if (!workspaceId) throw new Error('could not find a free workspace slug');

    await tx.unsafe(`set local role ${RUNTIME_ROLE}`);
    return inWorkspaceTransaction(tx, workspaceId, async (scoped) => {
      await seedBaseObjects(scoped, workspaceId);
      if (input.template) {
        await applyTemplate(scoped, {
          workspaceId,
          actor: SYSTEM_ACTOR,
          scopes: ['schema:write'],
          name: input.template,
        });
      }
      return workspaceId;
    });
  });
  return getWorkspace(sql, id);
}

async function organizationForPerson(tx: Tx, person: Person): Promise<string> {
  const memberships = await tx<{ organization_id: string; role: OrganizationRole }[]>`
    select organization_id, role from organization_members
    where user_id = ${person.id} order by created_at`;
  const managed = memberships.find((m) => isOrganizationManager(m.role));
  if (managed) return managed.organization_id;
  if (memberships.length > 0) {
    throw forbidden('Ask an owner or admin of your organization to create workspaces.');
  }
  const organization = await createOrganization(tx, {
    name: `${person.name || person.email}'s organization`,
  });
  await tx`
    insert into organization_members (organization_id, user_id, role)
    values (${organization.id}, ${person.id}, 'owner')`;
  return organization.id;
}

export async function renameWorkspace(
  sql: Sql,
  person: Person,
  workspaceId: string,
  name: string,
): Promise<Workspace> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError(400, 'invalid_request', 'a workspace needs a name');
  return asWorkspaceAdmin(sql, person, workspaceId, async (tx, workspace) => {
    // The slug stays, so links and agents keep working (5.1).
    await tx`update workspaces set name = ${trimmed}, updated_at = now() where id = ${workspace.id}`;
    return getWorkspace(tx, workspace.id);
  });
}

/**
 * Deletes a workspace (4.5): an organization owner's or admin's decision,
 * confirmed by typing its name. It is gone at once for every lookup and
 * removed for good after the grace period. The organization's lock comes
 * first, then the role check, then the write, so a demotion or a move
 * running at the same time lands before the check. Its extensions are
 * uninstalled in the same transaction (extensions spec 7): hosted ones queue
 * their provider cleanup, which runs during the grace period.
 */
export async function deleteWorkspace(
  sql: Sql,
  person: Person,
  workspaceId: string,
  confirmName: string,
  extensionCatalog?: RuntimeCatalog,
): Promise<{ id: string; deletionScheduledAt: string; purgeAfter: string }> {
  return (await sql.begin(async (tx) => {
    const organizationId = await lockWorkspaceOrganization(tx, workspaceId);
    // Someone who cannot see the workspace learns nothing about it.
    const { workspace } = await workspaceAccess(tx, person, workspaceId);
    if (!organizationId || organizationId !== workspace.organizationId) throw notFound('workspace');
    const role = await organizationRole(tx, organizationId, person.id);
    if (!role || !isOrganizationManager(role)) {
      throw forbidden('Only an owner or admin of the organization can delete a workspace.');
    }
    const [current] = await tx<{ name: string }[]>`
      select name from workspaces where id = ${workspaceId}`;
    if (confirmName.trim() !== current?.name.trim()) {
      throw new AppError(400, 'invalid_request', "type the workspace's name to delete it");
    }
    const [row] = await tx<{ deletion_scheduled_at: Date }[]>`
      update workspaces set deletion_scheduled_at = now(), updated_at = now()
      where id = ${workspaceId} and deletion_scheduled_at is null
      returning deletion_scheduled_at`;
    if (!row) throw notFound('workspace');
    // Last, because it leaves the transaction in the runtime role.
    await uninstallExtensions(tx, workspaceId, { sql, catalog: extensionCatalog });
    return {
      id: workspaceId,
      deletionScheduledAt: row.deletion_scheduled_at.toISOString(),
      purgeAfter: purgeAfter(row.deletion_scheduled_at).toISOString(),
    };
  })) as { id: string; deletionScheduledAt: string; purgeAfter: string };
}

// ---------------------------------------------------------------------------
// Members of a workspace
// ---------------------------------------------------------------------------

export type WorkspaceMember = {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  /** Organization owners and admins are admin everywhere; set on the organization. */
  organizationRole: OrganizationRole;
  joinedAt: string;
};

export type PendingInvitation = {
  id: string;
  email: string;
  role: OrganizationRole;
  workspaces: InvitedWorkspace[];
  invitedBy: string | null;
  expiresAt: string;
};

/** Everyone with access to a workspace, and invitations to it (5.1). */
export async function listWorkspaceMembers(
  sql: Sql,
  person: Person,
  workspaceId: string,
): Promise<{
  role: WorkspaceRole;
  members: WorkspaceMember[];
  invitations: PendingInvitation[];
  /** For a workspace admin: people in the organization who can be added here. */
  candidates: { userId: string; name: string; email: string }[];
}> {
  const access = await workspaceAccess(sql, person, workspaceId);
  const { id, organizationId } = access.workspace;
  const [rows, invitations, candidates] = await Promise.all([
    sql<
      {
        user_id: string;
        name: string;
        email: string;
        organization_role: OrganizationRole;
        workspace_role: WorkspaceRole | null;
        joined_at: Date;
      }[]
    >`
    select u.id as user_id, u.name, u.email, om.role as organization_role,
      wm.role as workspace_role, coalesce(wm.created_at, om.created_at) as joined_at
    from organization_members om
    join users u on u.id = om.user_id
    left join workspace_members wm on wm.workspace_id = ${id} and wm.user_id = u.id
    where om.organization_id = ${organizationId}
      and (om.role in ('owner', 'admin') or wm.role is not null)
    order by u.name, u.email`,
    pendingInvitations(sql, organizationId, id),
    access.role === 'admin'
      ? sql<{ userId: string; name: string; email: string }[]>`
          select u.id as "userId", u.name, u.email
          from organization_members om join users u on u.id = om.user_id
          where om.organization_id = ${organizationId} and om.role = 'member'
            and not exists (select 1 from workspace_members wm
              where wm.workspace_id = ${id} and wm.user_id = om.user_id)
          order by u.name, u.email`
      : [],
  ]);
  const members = rows.flatMap((row) => {
    const role = effectiveWorkspaceRole(row.organization_role, row.workspace_role);
    return role
      ? [
          {
            userId: row.user_id,
            name: row.name,
            email: row.email,
            role,
            organizationRole: row.organization_role,
            joinedAt: row.joined_at.toISOString(),
          },
        ]
      : [];
  });
  return { role: access.role, members, invitations, candidates: [...candidates] };
}

/** Gives someone in the organization a role in the workspace. */
export async function setWorkspaceRole(
  sql: Sql,
  person: Person,
  workspaceId: string,
  userId: string,
  role: string,
): Promise<void> {
  if (!isWorkspaceRole(role)) {
    throw new AppError(400, 'invalid_request', 'role must be viewer, editor or admin');
  }
  await asWorkspaceAdmin(sql, person, workspaceId, async (tx, workspace) => {
    const target = await organizationRole(tx, workspace.organizationId, userId);
    if (!target) {
      throw new AppError(409, 'not_a_member', 'invite them to the organization first');
    }
    if (isOrganizationManager(target)) throw organizationAdminConflict();
    await tx`
      insert into workspace_members (organization_id, workspace_id, user_id, role)
      values (${workspace.organizationId}, ${workspace.id}, ${userId}, ${role})
      on conflict (workspace_id, user_id) do update set role = excluded.role`;
  });
}

/**
 * Takes someone's role in the workspace away. They lose access at their next
 * request; agent keys they created keep working (4.5).
 */
export async function removeFromWorkspace(
  sql: Sql,
  person: Person,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await asWorkspaceAdmin(sql, person, workspaceId, async (tx, workspace) => {
    const target = await organizationRole(tx, workspace.organizationId, userId);
    if (target && isOrganizationManager(target)) throw organizationAdminConflict();
    await tx`delete from workspace_members where workspace_id = ${workspace.id} and user_id = ${userId}`;
    // Apps they connected here stop working too, and stay disconnected if
    // they are added back (4.5).
    await endGrants(tx, tx`oc.user_id = ${userId} and oc.reference_id = ${workspace.id}`);
    // Their personal memory here goes with them (personal memory spec 4.6).
    await endLostMemberships(tx, [{ workspaceId: workspace.id, userId }], personActor(person));
  });
}

// ---------------------------------------------------------------------------
// API keys in the web app (4.5): for agents and integrations only
// ---------------------------------------------------------------------------

export type WorkspaceKey = ApiKeyListing & {
  createdBy: { id: string; name: string } | null;
  /** The person this agent works for, whose personal memory it reaches (personal memory 4.3). */
  worksFor: { id: string; name: string } | null;
};

export async function createWorkspaceKey(
  sql: Sql,
  person: Person,
  workspaceId: string,
  input: { name: string; access: string; worksForMe?: boolean | undefined },
): Promise<CreatedApiKey> {
  const name = input.name.trim();
  if (!name) throw new AppError(400, 'invalid_request', 'a key needs a name');
  if (!isKeyAccess(input.access)) {
    throw new AppError(400, 'invalid_request', 'access must be read, write or schema');
  }
  const scopes = [...KEY_ACCESS[input.access]];
  return asWorkspaceAdmin(sql, person, workspaceId, (tx, workspace) =>
    createApiKey(tx, {
      workspace: workspace.id,
      name,
      // Always an agent: a key from the web app never speaks for a person.
      actor: { type: 'agent', id: slugify(name) || 'agent', name },
      scopes,
      createdByUser: person.id,
      // "This agent works for me" (personal memory spec 4.3): only ever the
      // person creating the key, so nobody can mint a key into another's memory.
      ...(input.worksForMe ? { actsForUser: person.id } : {}),
    }),
  );
}

export async function listWorkspaceKeys(
  sql: Sql,
  person: Person,
  workspaceId: string,
): Promise<WorkspaceKey[]> {
  const { workspace } = await requireWorkspaceAdmin(sql, person, workspaceId);
  const rows = await sql<
    (Omit<ApiKeyListing, 'createdAt' | 'revokedAt' | 'workspaceId'> & {
      createdAt: Date;
      revokedAt: Date | null;
      createdById: string | null;
      createdByName: string | null;
      worksForId: string | null;
      worksForName: string | null;
    })[]
  >`
    select k.id, k.name, k.prefix, k.scopes, k.actor, k.created_at as "createdAt",
      k.revoked_at as "revokedAt", u.id as "createdById", u.name as "createdByName",
      f.id as "worksForId", f.name as "worksForName"
    from api_keys k
    left join users u on u.id = k.created_by_user
    left join users f on f.id = k.acts_for_user
    where k.workspace_id = ${workspace.id}
    order by k.revoked_at nulls first, k.created_at desc`;
  return rows.map(({ createdById, createdByName, worksForId, worksForName, ...row }) => ({
    ...row,
    workspaceId: workspace.id,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdBy: createdById ? { id: createdById, name: createdByName ?? '' } : null,
    worksFor: worksForId ? { id: worksForId, name: worksForName ?? '' } : null,
  }));
}

export async function revokeWorkspaceKey(
  sql: Sql,
  person: Person,
  workspaceId: string,
  keyId: string,
): Promise<void> {
  await asWorkspaceAdmin(sql, person, workspaceId, async (tx, workspace) => {
    const rows = await tx`
      update api_keys set revoked_at = coalesce(revoked_at, now())
      where id = ${keyId} and workspace_id = ${workspace.id} returning 1`;
    if (rows.length === 0) throw notFound('key');
  });
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export type OrganizationMemberListing = {
  userId: string;
  name: string;
  email: string;
  role: OrganizationRole;
  workspaces: { id: string; name: string; role: WorkspaceRole }[];
};

export async function describeOrganization(
  sql: Sql,
  person: Person,
  organizationId: string,
): Promise<{
  id: string;
  name: string;
  role: OrganizationRole;
  members: OrganizationMemberListing[];
  workspaces: { id: string; slug: string; name: string; members: number }[];
  invitations: PendingInvitation[];
}> {
  const role = await requireOrganizationManager(sql, person, organizationId);
  const [[organization], workspaces, people, roles, invitations] = await Promise.all([
    sql<{ name: string }[]>`select name from organizations where id = ${organizationId}`,
    sql<{ id: string; slug: string; name: string; members: number }[]>`
    select w.id, w.slug, w.name,
      (select count(*)::int from workspace_members wm where wm.workspace_id = w.id) as members
    from workspaces w
    where w.organization_id = ${organizationId} and w.deletion_scheduled_at is null
    order by w.name, w.id`,
    sql<{ user_id: string; name: string; email: string; role: OrganizationRole }[]>`
    select u.id as user_id, u.name, u.email, om.role
    from organization_members om join users u on u.id = om.user_id
    where om.organization_id = ${organizationId}
    order by case om.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.name`,
    sql<{ user_id: string; workspace_id: string; role: WorkspaceRole }[]>`
      select user_id, workspace_id, role from workspace_members
      where workspace_id in (select id from workspaces where organization_id = ${organizationId})`,
    pendingInvitations(sql, organizationId),
  ]);
  const direct = new Map(roles.map((r) => [`${r.user_id}:${r.workspace_id}`, r.role]));
  const members = people.map((p) => ({
    userId: p.user_id,
    name: p.name,
    email: p.email,
    role: p.role,
    workspaces: workspaces.flatMap((w) => {
      const effective = effectiveWorkspaceRole(p.role, direct.get(`${p.user_id}:${w.id}`) ?? null);
      return effective ? [{ id: w.id, name: w.name, role: effective }] : [];
    }),
  }));
  return {
    id: organizationId,
    name: organization?.name ?? '',
    role,
    members,
    workspaces,
    invitations,
  };
}

export async function renameOrganization(
  sql: Sql,
  person: Person,
  organizationId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError(400, 'invalid_request', 'an organization needs a name');
  await asOrganizationManager(sql, person, organizationId, async (tx, role) => {
    if (role !== 'owner') throw forbidden('Only an owner can rename the organization.');
    await tx`update organizations set name = ${trimmed} where id = ${organizationId}`;
  });
}

/** Deletes an organization once it has no workspaces (4.5). */
export async function deleteOrganization(
  sql: Sql,
  person: Person,
  organizationId: string,
): Promise<void> {
  await asOrganizationManager(sql, person, organizationId, async (tx, role) => {
    if (role !== 'owner') throw forbidden('Only an owner can delete the organization.');
    const [{ count } = { count: 0 }] = await tx<{ count: number }[]>`
      select count(*)::int as count from workspaces where organization_id = ${organizationId}`;
    if (count > 0) {
      throw new AppError(
        409,
        'has_workspaces',
        `Delete its workspaces first. A deleted workspace is removed for good ${DELETION_GRACE_DAYS} days later.`,
      );
    }
    await tx`delete from organizations where id = ${organizationId}`;
  });
}

/**
 * Changes someone's role in the organization. Owners manage owners; owners
 * and admins manage everyone else. An organization keeps an owner (4.5).
 */
export async function setOrganizationRole(
  sql: Sql,
  person: Person,
  organizationId: string,
  userId: string,
  role: string,
): Promise<void> {
  if (!isOrganizationRole(role)) {
    throw new AppError(400, 'invalid_request', 'role must be owner, admin or member');
  }
  await asOrganizationManager(sql, person, organizationId, async (tx, mine) => {
    const current = await organizationRole(tx, organizationId, userId);
    if (!current) throw notFound('member');
    if ((current === 'owner' || role === 'owner') && mine !== 'owner') {
      throw forbidden('Only an owner can make or change owners.');
    }
    if (current === 'owner' && role !== 'owner')
      await assertKeepsAnOwner(tx, organizationId, userId);
    const before = await organizationMemberships(tx, organizationId, userId);
    await tx`
      update organization_members set role = ${role}
      where organization_id = ${organizationId} and user_id = ${userId}`;
    // A member keeps only the workspaces they have a role in: their personal
    // memory in the others goes (personal memory spec 4.6).
    await endLostMemberships(tx, before, personActor(person));
  });
}

/** Removes someone from the organization, ending every workspace role they had there. */
export async function removeFromOrganization(
  sql: Sql,
  person: Person,
  organizationId: string,
  userId: string,
): Promise<void> {
  await asOrganizationManager(sql, person, organizationId, async (tx, mine) => {
    const current = await organizationRole(tx, organizationId, userId);
    if (!current) throw notFound('member');
    if (current === 'owner' && mine !== 'owner') {
      throw forbidden('Only an owner can remove an owner.');
    }
    if (current === 'owner') await assertKeepsAnOwner(tx, organizationId, userId);
    const before = await organizationMemberships(tx, organizationId, userId);
    await tx`
      delete from organization_members
      where organization_id = ${organizationId} and user_id = ${userId}`;
    await endGrants(
      tx,
      tx`oc.user_id = ${userId} and oc.reference_id in
        (select id from workspaces where organization_id = ${organizationId})`,
    );
    // Their personal memory in every workspace of it goes (personal memory 4.6).
    await endLostMemberships(tx, before, personActor(person));
  });
}

const personActor = (person: Person) => ({ type: 'user' as const, id: person.id });

// ---------------------------------------------------------------------------
// Invitations (4.5): a link to copy; Retainer sends no email
// ---------------------------------------------------------------------------

const INVITATION_DAYS = 7;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Pending invitations to an organization, or only those that include one workspace. */
async function pendingInvitations(
  sql: Sql,
  organizationId: string,
  workspaceId?: string,
): Promise<PendingInvitation[]> {
  const rows = await sql<
    {
      id: string;
      email: string;
      role: OrganizationRole;
      workspaces: InvitedWorkspace[];
      invited_by: string | null;
      expires_at: Date;
    }[]
  >`
    select i.id, i.email, i.role, i.workspaces, u.name as invited_by, i.expires_at
    from invitations i left join users u on u.id = i.invited_by
    where i.organization_id = ${organizationId} and i.accepted_at is null
      and i.revoked_at is null and i.expires_at > now()
      ${workspaceId ? sql`and i.workspaces @> ${sql.json([{ workspaceId }])}` : sql``}
    order by i.created_at desc`;
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    workspaces: row.workspaces,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at.toISOString(),
  }));
}

/** Invites an email address; returns the token for the link, shown once. */
export async function createInvitation(
  sql: Sql,
  person: Person,
  organizationId: string,
  input: { email: string; role: string; workspaces: { workspaceId: string; role: string }[] },
): Promise<{ id: string; token: string; expiresAt: string }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new AppError(400, 'invalid_request', 'enter an email address');
  }
  if (!isOrganizationRole(input.role)) {
    throw new AppError(400, 'invalid_request', 'role must be owner, admin or member');
  }
  const role = input.role;
  const workspaces: InvitedWorkspace[] = input.workspaces.map((w) => {
    if (!isWorkspaceRole(w.role)) {
      throw new AppError(400, 'invalid_request', 'workspace role must be viewer, editor or admin');
    }
    return { workspaceId: w.workspaceId, role: w.role };
  });
  const ids = [...new Set(workspaces.map((w) => w.workspaceId))];
  if (ids.length !== workspaces.length) {
    throw new AppError(400, 'invalid_request', 'list each workspace once');
  }
  return asOrganizationManager(sql, person, organizationId, async (tx, mine) => {
    if (role === 'owner' && mine !== 'owner') {
      throw forbidden('Only an owner can invite an owner.');
    }
    // Accepting checks again; this only spares sending a link that cannot work.
    // Someone already in the organization takes no new place.
    const [member] = await tx`
      select 1 from organization_members m join users u on u.id = m.user_id
      where m.organization_id = ${organizationId} and u.email = ${email}`;
    if (!member) await assertWithinLimit(tx, organizationId, 'members');
    if (ids.length) {
      const found = await tx`
        select 1 from workspaces where id = any(${ids}::uuid[]) and organization_id = ${organizationId}
          and deletion_scheduled_at is null`;
      if (found.length !== ids.length) throw notFound('workspace');
    }
    const token = randomBytes(32).toString('base64url');
    const [row] = await tx<{ id: string; expires_at: Date }[]>`
      insert into invitations (organization_id, email, role, workspaces, token_hash, invited_by, expires_at)
      values (${organizationId}, ${email}, ${role}, ${tx.json(workspaces)},
        ${hashToken(token)}, ${person.id}, now() + make_interval(days => ${INVITATION_DAYS}))
      returning id, expires_at`;
    if (!row) throw new Error('insert returned no row');
    return { id: row.id, token, expiresAt: row.expires_at.toISOString() };
  });
}

export async function revokeInvitation(
  sql: Sql,
  person: Person,
  organizationId: string,
  invitationId: string,
): Promise<void> {
  await asOrganizationManager(sql, person, organizationId, async (tx) => {
    const rows = await tx`
      update invitations set revoked_at = now()
      where id = ${invitationId} and organization_id = ${organizationId}
        and accepted_at is null and revoked_at is null
      returning 1`;
    if (rows.length === 0) throw notFound('invitation');
  });
}

export type InvitationPreview = {
  id: string;
  organization: { id: string; name: string };
  role: OrganizationRole;
  invitedBy: string | null;
  email: string;
  workspaces: { id: string; name: string; role: WorkspaceRole }[];
  /** Whether the signed-in person's verified address is the invited one. */
  forYou: boolean;
};

/** An invitation by its link token, or by its ID for the person it was sent to. */
async function findInvitation(sql: Sql | Tx, person: Person, tokenOrId: string) {
  const byId = isUuid(tokenOrId);
  const [row] = await sql<
    {
      id: string;
      organization_id: string;
      organization_name: string;
      email: string;
      role: OrganizationRole;
      workspaces: InvitedWorkspace[];
      invited_by: string | null;
      expires_at: Date;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }[]
  >`
    select i.id, i.organization_id, o.name as organization_name, i.email, i.role, i.workspaces,
      u.name as invited_by, i.expires_at, i.accepted_at, i.revoked_at
    from invitations i
    join organizations o on o.id = i.organization_id
    left join users u on u.id = i.invited_by
    where ${byId ? sql`i.id = ${tokenOrId} and i.email = ${person.email.toLowerCase()}` : sql`i.token_hash = ${hashToken(tokenOrId)}`}`;
  // Accepted or not, a link stops working after its seven days (accounts spec 4.5).
  if (!row || row.revoked_at || row.expires_at <= new Date()) {
    throw new AppError(404, 'not_found', 'This invitation has expired or was withdrawn.');
  }
  return row;
}

export async function previewInvitation(
  sql: Sql,
  person: Person,
  tokenOrId: string,
): Promise<InvitationPreview> {
  const row = await findInvitation(sql, person, tokenOrId);
  // Only what accepting grants: a workspace moved to another organization is left out.
  const names = await sql<{ id: string; name: string }[]>`
    select id, name from workspaces
    where id = any(${row.workspaces.map((w) => w.workspaceId)}::uuid[])
      and organization_id = ${row.organization_id} and deletion_scheduled_at is null`;
  return {
    id: row.id,
    organization: { id: row.organization_id, name: row.organization_name },
    role: row.role,
    invitedBy: row.invited_by,
    email: row.email,
    workspaces: row.workspaces.flatMap((w) => {
      const workspace = names.find((n) => n.id === w.workspaceId);
      return workspace ? [{ id: workspace.id, name: workspace.name, role: w.role }] : [];
    }),
    forYou: await isVerifiedEmail(sql, person, row.email),
  };
}

async function isVerifiedEmail(sql: Sql | Tx, person: Person, email: string): Promise<boolean> {
  const [user] = await sql<{ ok: boolean }[]>`
    select email_verified and lower(email) = ${email} as ok from users where id = ${person.id}`;
  return user?.ok ?? false;
}

/**
 * Accepts an invitation. The person's verified address must be the invited
 * one, so a forwarded link is useless to anyone else. Every provider account
 * linked to the person verified that address (auth.ts), whichever one they
 * signed in with this time. Accepting
 * twice is a no-op, and an existing membership keeps its role.
 */
export async function acceptInvitation(
  sql: Sql,
  person: Person,
  tokenOrId: string,
): Promise<{ organizationId: string }> {
  return sql.begin(async (tx) => {
    const found = await findInvitation(tx, person, tokenOrId);
    await lockOrganization(tx, found.organization_id);
    const row = await findInvitation(tx, person, tokenOrId);
    if (!(await isVerifiedEmail(tx, person, row.email))) {
      throw forbidden(
        `This invitation is for ${row.email}. Sign in with the account for that address to accept it.`,
      );
    }
    if (row.accepted_at) return { organizationId: row.organization_id };
    // Claim the invitation before granting anything. A withdrawal running at
    // the same time either wins (nothing claimed) or waits and finds it accepted.
    const claimed = await tx`
      update invitations set accepted_at = now()
      where id = ${row.id} and accepted_at is null and revoked_at is null and expires_at > now()
      returning 1`;
    if (claimed.length === 0) {
      // Withdrawn or expired since the read: this throws 404. Otherwise it was just accepted.
      await findInvitation(tx, person, tokenOrId);
      return { organizationId: row.organization_id };
    }
    // Under the organization's lock, so two accepts racing for the last place
    // see each other. Refusing rolls the claim back.
    if (!(await organizationRole(tx, row.organization_id, person.id))) {
      await assertWithinLimit(tx, row.organization_id, 'members');
    }
    await tx`
      insert into organization_members (organization_id, user_id, role)
      values (${row.organization_id}, ${person.id}, ${row.role})
      on conflict (organization_id, user_id) do nothing`;
    // Workspaces moved or deleted since the invitation are skipped.
    await tx`
      insert into workspace_members (organization_id, workspace_id, user_id, role)
      select w.organization_id, w.id, ${person.id}, invited.role
      from jsonb_to_recordset(${tx.json(row.workspaces)}) as invited("workspaceId" uuid, role text)
      join workspaces w on w.id = invited."workspaceId" and w.organization_id = ${row.organization_id}
        and w.deletion_scheduled_at is null
      on conflict (workspace_id, user_id) do nothing`;
    return { organizationId: row.organization_id };
  });
}

/** Invitations sent to the person's address, for the first-run screen (4.5). */
export async function invitationsFor(sql: Sql, person: Person) {
  const rows = await sql<
    { id: string; organization_name: string; invited_by: string | null; expires_at: Date }[]
  >`
    select i.id, o.name as organization_name, u.name as invited_by, i.expires_at
    from invitations i
    join organizations o on o.id = i.organization_id
    join users me on me.id = ${person.id} and me.email_verified and lower(me.email) = i.email
    left join users u on u.id = i.invited_by
    where i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
      and not exists (select 1 from organization_members om
        where om.organization_id = i.organization_id and om.user_id = ${person.id})
    order by i.created_at desc`;
  return rows.map((row) => ({
    id: row.id,
    organization: row.organization_name,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// OAuth grants (4.7)
// ---------------------------------------------------------------------------
