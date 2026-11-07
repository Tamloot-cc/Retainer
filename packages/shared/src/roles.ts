import type { Scope } from './api.js';

/**
 * Roles for people in accounts mode (docs/specs/accounts-and-access.md 4.3).
 * A workspace role is a named bundle of the existing scopes, so routes keep
 * checking scopes. The server and the web app read this one definition.
 */

export const WORKSPACE_ROLES = ['viewer', 'editor', 'admin'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const WORKSPACE_ROLE_SCOPES: Record<WorkspaceRole, readonly Scope[]> = {
  viewer: ['read'],
  editor: ['read', 'write'],
  admin: ['read', 'write', 'schema:write', 'admin'],
};

/** Plain words for each role, shown wherever a role is (5.1). */
export const WORKSPACE_ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  viewer: 'Can see everything in this workspace',
  editor: 'Can also add and change records, comment and review',
  admin:
    "Can also change the workspace's structure, erase personal data, and manage people and agents",
};

export const ORGANIZATION_ROLE_DESCRIPTIONS: Record<OrganizationRole, string> = {
  owner: 'Admin in every workspace, and manages the organization and its owners',
  admin: 'Admin in every workspace, creates workspaces and invites people',
  member: 'Only the workspaces they are added to, with the role set there',
};

/** Owners and admins manage the organization, and are admin in all its workspaces. */
export const isOrganizationManager = (role: OrganizationRole) =>
  role === 'owner' || role === 'admin';

/**
 * A person's role in a workspace: admin for organization owners and admins,
 * otherwise their role in the workspace, otherwise none.
 */
export function effectiveWorkspaceRole(
  organizationRole: OrganizationRole | null,
  workspaceRole: WorkspaceRole | null,
): WorkspaceRole | null {
  if (organizationRole && isOrganizationManager(organizationRole)) return 'admin';
  if (organizationRole === null) return null;
  return workspaceRole;
}

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly unknown[]).includes(value);
}

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return (ORGANIZATION_ROLES as readonly unknown[]).includes(value);
}

/**
 * What an API key created in the web app can do (5.1). Never `admin`: the
 * human-only decisions stay with people.
 */
export const KEY_ACCESS = {
  read: ['read'],
  write: ['read', 'write'],
  schema: ['read', 'write', 'schema:write'],
} as const satisfies Record<string, readonly Scope[]>;
export type KeyAccess = keyof typeof KEY_ACCESS;

export function isKeyAccess(value: unknown): value is KeyAccess {
  return typeof value === 'string' && Object.hasOwn(KEY_ACCESS, value);
}

/**
 * What an app connected over OAuth may ask for (accounts spec 4.7): the
 * scopes an agent's key can have, never `admin`.
 */
export const OAUTH_SCOPES = KEY_ACCESS.schema;

/**
 * The scopes an app gets in a workspace: what its token asked for, capped by
 * the person's role now. The server applies it on every request and the
 * consent page shows it.
 */
export function cappedScopes(asked: readonly string[], role: WorkspaceRole): Scope[] {
  const allowed = WORKSPACE_ROLE_SCOPES[role];
  return OAUTH_SCOPES.filter((scope) => asked.includes(scope) && allowed.includes(scope));
}

/** The access a key's scopes amount to, for showing it in plain words. */
export function keyAccessOf(scopes: readonly Scope[]): KeyAccess {
  if (scopes.includes('schema:write') || scopes.includes('admin')) return 'schema';
  return scopes.includes('write') ? 'write' : 'read';
}
