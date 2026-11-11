import { RetainerApiError } from '@retainer/sdk';
import type {
  KeyAccess,
  OrganizationRole,
  Scope,
  SignInProvider,
  WorkspaceRole,
} from '@retainer/shared';
import { updatingFetch } from './maintenance.js';

/**
 * /account (accounts spec 4.5): the signed-in person, their organizations,
 * workspaces, members, invitations and keys. Only in accounts mode; in key
 * mode the server answers 404 and the app keeps its key sign-in.
 */

export type AccountWorkspace = { id: string; slug: string; name: string; role: WorkspaceRole };
export type AccountOrganization = {
  id: string;
  name: string;
  role: OrganizationRole;
  workspaces: AccountWorkspace[];
};
export type PendingForYou = {
  id: string;
  organization: string;
  invitedBy: string | null;
  expiresAt: string;
};
export type Account = {
  user: { id: string; name: string; email: string };
  organizations: AccountOrganization[];
  invitations: PendingForYou[];
  /** The providers this server signs people in with. */
  providers: SignInProvider[];
};

export type Workspace = { id: string; slug: string; name: string; organizationId: string };

export type InvitedWorkspace = { workspaceId: string; role: WorkspaceRole };
export type PendingInvitation = {
  id: string;
  email: string;
  role: OrganizationRole;
  workspaces: InvitedWorkspace[];
  invitedBy: string | null;
  expiresAt: string;
};

export type WorkspaceMember = {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  organizationRole: OrganizationRole;
  joinedAt: string;
};

export type WorkspaceKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdAt: string;
  revokedAt: string | null;
  createdBy: { id: string; name: string } | null;
  /** The person this agent works for: it reads and writes their personal memory. */
  worksFor: { id: string; name: string } | null;
};

export type OrganizationDetails = {
  id: string;
  name: string;
  role: OrganizationRole;
  members: {
    userId: string;
    name: string;
    email: string;
    role: OrganizationRole;
    workspaces: { id: string; name: string; role: WorkspaceRole }[];
  }[];
  workspaces: { id: string; slug: string; name: string; members: number }[];
  invitations: PendingInvitation[];
};

/** An app connected over sign-in, such as Claude (accounts spec 4.7, 5.1). */
export type Connection = {
  id: string;
  app: { name: string; uri: string | null };
  workspace: { id: string; slug: string; name: string };
  person: { id: string; name: string; email: string };
  scopes: Scope[];
  connectedAt: string;
};

export type OAuthInstallation = {
  id: string;
  name: string;
  version: string;
  actor: 'agent' | 'integration';
  scopes: ('read' | 'write')[];
  generation: number;
};

export type InvitationPreview = {
  id: string;
  organization: { id: string; name: string };
  role: OrganizationRole;
  invitedBy: string | null;
  email: string;
  workspaces: { id: string; name: string; role: WorkspaceRole }[];
  forYou: boolean;
};

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await updatingFetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      'X-Retainer-Client': 'web',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new RetainerApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? `The request failed (${response.status}).`,
    );
  }
  return body as T;
}

const ws = (id: string) => `/account/workspaces/${encodeURIComponent(id)}`;
const org = (id: string) => `/account/organizations/${encodeURIComponent(id)}`;

export const account = {
  /** The person; 401 when signed out, 404 in key mode. */
  me: () => call<Account>('/account'),
  /** The providers this server signs people in with; needs no session. */
  providers: () => call<{ providers: SignInProvider[] }>('/account/providers'),
  createWorkspace: (input: { name: string; template?: string; organizationId?: string }) =>
    call<Workspace>('/account/workspaces', { method: 'POST', body: input }),
  renameWorkspace: (id: string, name: string) =>
    call<Workspace>(ws(id), { method: 'PATCH', body: { name } }),
  /** Gone at once; removed for good after 7 days, during which an operator can undo it. */
  deleteWorkspace: (id: string, name: string) =>
    call<{ id: string; deletionScheduledAt: string; purgeAfter: string }>(ws(id), {
      method: 'DELETE',
      body: { name },
    }),
  members: (id: string) =>
    call<{
      role: WorkspaceRole;
      members: WorkspaceMember[];
      invitations: PendingInvitation[];
      candidates: { userId: string; name: string; email: string }[];
    }>(`${ws(id)}/members`),
  setMemberRole: (id: string, userId: string, role: WorkspaceRole) =>
    call<void>(`${ws(id)}/members/${userId}`, { method: 'PUT', body: { role } }),
  removeMember: (id: string, userId: string) =>
    call<void>(`${ws(id)}/members/${userId}`, { method: 'DELETE' }),
  keys: (id: string) => call<{ keys: WorkspaceKey[] }>(`${ws(id)}/keys`),
  createKey: (id: string, input: { name: string; access: KeyAccess; worksForMe?: boolean }) =>
    call<WorkspaceKey & { key: string }>(`${ws(id)}/keys`, { method: 'POST', body: input }),
  revokeKey: (id: string, keyId: string) =>
    call<void>(`${ws(id)}/keys/${keyId}`, { method: 'DELETE' }),
  organization: (id: string) => call<OrganizationDetails>(org(id)),
  renameOrganization: (id: string, name: string) =>
    call<void>(org(id), { method: 'PATCH', body: { name } }),
  deleteOrganization: (id: string) => call<void>(org(id), { method: 'DELETE' }),
  setOrganizationRole: (id: string, userId: string, role: OrganizationRole) =>
    call<void>(`${org(id)}/members/${userId}`, { method: 'PATCH', body: { role } }),
  removeFromOrganization: (id: string, userId: string) =>
    call<void>(`${org(id)}/members/${userId}`, { method: 'DELETE' }),
  invite: (
    id: string,
    input: { email: string; role: OrganizationRole; workspaces: InvitedWorkspace[] },
  ) =>
    call<{ id: string; link: string; expiresAt: string }>(`${org(id)}/invitations`, {
      method: 'POST',
      body: input,
    }),
  revokeInvitation: (id: string, invitationId: string) =>
    call<void>(`${org(id)}/invitations/${invitationId}`, { method: 'DELETE' }),
  connections: () => call<{ connections: Connection[] }>('/account/connections'),
  workspaceConnections: (id: string) =>
    call<{ connections: Connection[] }>(`${ws(id)}/connections`),
  disconnect: (connectionId: string) =>
    call<void>(`/account/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }),
  /** The app asking to connect, for the consent page. */
  oauthClient: (clientId: string) =>
    call<{ clientId: string; name: string; uri: string | null }>(
      `/account/oauth/client?client_id=${encodeURIComponent(clientId)}`,
    ),
  /** Allows or refuses an app; returns where to send the browser next. */
  oauthInstallations: (clientId: string, workspaceId: string) =>
    call<{ installations: OAuthInstallation[] }>(
      `/account/oauth/installations?${new URLSearchParams({ client_id: clientId, workspaceId })}`,
    ),
  oauthConsent: (input: {
    oauthQuery: string;
    accept: boolean;
    workspaceId?: string;
    installationId?: string;
    expectedGeneration?: number;
  }) =>
    call<{ url: string }>('/account/oauth/consent', {
      method: 'POST',
      body: {
        oauth_query: input.oauthQuery,
        accept: input.accept,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.installationId ? { installationId: input.installationId } : {}),
        ...(input.expectedGeneration ? { expectedGeneration: input.expectedGeneration } : {}),
      },
    }),
  invitation: (tokenOrId: string) =>
    call<InvitationPreview>(`/account/invitations/${encodeURIComponent(tokenOrId)}`),
  acceptInvitation: (tokenOrId: string) =>
    call<{ organizationId: string }>(
      `/account/invitations/${encodeURIComponent(tokenOrId)}/accept`,
      { method: 'POST' },
    ),
};

/**
 * Extends the session while the person uses the app. Better Auth writes
 * session refreshes only on this POST (`deferSessionRefresh`), so reads stay
 * free of writes (accounts spec 4.4); without it a session ends 30 days after
 * sign-in however active the person is.
 */
export async function refreshSession(): Promise<void> {
  await updatingFetch('/account/auth/get-session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

/** Better Auth's browser client, loaded only in accounts mode. */
export const authClient = () => import('./auth-client.js').then((m) => m.authClient);

/**
 * Ends this session, then starts the app again at the sign-in screen, which
 * comes back to `then` after signing in. Throws when the server did not end
 * it: the session still works, so going on would land the person back inside.
 */
export async function signOutOfAccount(then = '/app/'): Promise<void> {
  const { error } = await (await authClient()).signOut();
  if (error) throw new Error('You are still signed in: signing out failed. Try again.');
  window.location.assign(then);
}

/** Where the app opens a workspace: a full page load, so nothing cached crosses over. */
export const workspaceHref = (slug: string, path = '/') => `/app/w/${slug}${path}`;
