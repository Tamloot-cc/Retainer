import {
  effectiveWorkspaceRole,
  type OrganizationRole,
  type WorkspaceRole,
} from '@retainer/shared';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { requireWebHeader } from '../auth/session.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import { idParam, readBody } from '../http/request.js';
import { errorResponse, toAppError } from '../http/response.js';
import { type Auth, CLIENT_IP_HEADER } from './auth.js';
import * as connections from './connections.js';
import type { Person } from './people.js';
import * as people from './people.js';

/**
 * /account (accounts spec 4.5): Better Auth's routes, and the routes people
 * use to manage their account, organizations, workspaces, members and keys.
 * They take a session cookie only and are never reachable with an API key,
 * so an agent's key can never create a key, add a member or create a
 * workspace (ARCHITECTURE.md 7.1).
 */

export type { Person };

const named = z.object({ name: z.string().max(200) });
const role = z.object({ role: z.string() });
export type AccountsEnv = {
  Bindings: Record<string, unknown>;
  Variables: { person: Person };
};

export type AccountsDeps = {
  auth: Auth;
  /** A connection as the control role. */
  sql: Sql;
  publicOrigin: string;
  /** The client's address, from the connection, API Gateway or CloudFront, never a header the client set. */
  clientIp: (c: Context) => string | undefined;
};

export function createAccountsApp(deps: AccountsDeps) {
  const app = new Hono<AccountsEnv>();
  app.onError((error, c) => errorResponse(c, toAppError(error)));
  app.notFound((c) =>
    errorResponse(c, new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`)),
  );

  // Better Auth trusts only this header for the client's address, so a
  // value the client sent is replaced, never passed on.
  const forwarded = (c: Context) => {
    const headers = new Headers(c.req.raw.headers);
    headers.delete(CLIENT_IP_HEADER);
    const ip = deps.clientIp(c);
    if (ip) headers.set(CLIENT_IP_HEADER, ip);
    return headers;
  };

  app.on(['GET', 'POST'], '/account/auth/*', async (c) => {
    // Consent goes through /account/oauth/consent, which checks the
    // workspace the person picked; Retainer never uses the post-login step.
    if (CLOSED_AUTH_PATHS.has(c.req.path)) {
      throw new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`);
    }
    return deps.auth.handler(new Request(c.req.raw, { headers: forwarded(c) }));
  });

  // RFC 8414: OAuth clients find the authorization server's metadata at the
  // root, with the issuer's path appended (accounts spec 4.6).
  for (const path of [
    '/.well-known/oauth-authorization-server/account/auth',
    '/.well-known/oauth-authorization-server',
  ]) {
    app.get(path, (c) => deps.auth.authServerMetadata(c.req.raw));
  }

  // What the sign-in page offers, before anyone is signed in: Google,
  // Microsoft or both, as the server is set up (accounts spec 4.1, 5).
  app.get('/account/providers', (c) => c.json({ providers: deps.auth.providers }));

  const account = new Hono<AccountsEnv>();
  account.use('*', signedIn(deps));
  const { sql } = deps;
  account.get('/', async (c) =>
    c.json({ ...(await describeAccount(sql, c.get('person'))), providers: deps.auth.providers }),
  );

  // Workspaces
  account.post('/workspaces', async (c) => {
    const body = await readBody(
      c,
      named.extend({ template: z.string().optional(), organizationId: z.uuid().optional() }),
    );
    return c.json(await people.createWorkspaceFor(sql, c.get('person'), body), 201);
  });
  account.patch('/workspaces/:id', async (c) => {
    const { name } = await readBody(c, named);
    return c.json(await people.renameWorkspace(sql, c.get('person'), idParam(c), name));
  });
  account.delete('/workspaces/:id', async (c) => {
    const { name } = await readBody(c, named);
    return c.json(await people.deleteWorkspace(sql, c.get('person'), idParam(c), name));
  });
  account.get('/workspaces/:id/members', async (c) =>
    c.json(await people.listWorkspaceMembers(sql, c.get('person'), idParam(c))),
  );
  account.put('/workspaces/:id/members/:userId', async (c) => {
    const body = await readBody(c, role);
    const [id, userId] = [idParam(c), idParam(c, 'userId')];
    await people.setWorkspaceRole(sql, c.get('person'), id, userId, body.role);
    return c.body(null, 204);
  });
  account.delete('/workspaces/:id/members/:userId', async (c) => {
    const [id, userId] = [idParam(c), idParam(c, 'userId')];
    await people.removeFromWorkspace(sql, c.get('person'), id, userId);
    return c.body(null, 204);
  });
  account.get('/workspaces/:id/keys', async (c) =>
    c.json({ keys: await people.listWorkspaceKeys(sql, c.get('person'), idParam(c)) }),
  );
  account.post('/workspaces/:id/keys', async (c) => {
    const body = await readBody(
      c,
      named.extend({ access: z.string(), worksForMe: z.boolean().optional() }),
    );
    return c.json(await people.createWorkspaceKey(sql, c.get('person'), idParam(c), body), 201);
  });
  account.delete('/workspaces/:id/keys/:keyId', async (c) => {
    const [id, keyId] = [idParam(c), idParam(c, 'keyId')];
    await people.revokeWorkspaceKey(sql, c.get('person'), id, keyId);
    return c.body(null, 204);
  });

  // Organizations
  account.get('/organizations/:id', async (c) =>
    c.json(await people.describeOrganization(sql, c.get('person'), idParam(c))),
  );
  account.patch('/organizations/:id', async (c) => {
    const { name } = await readBody(c, named);
    await people.renameOrganization(sql, c.get('person'), idParam(c), name);
    return c.body(null, 204);
  });
  account.delete('/organizations/:id', async (c) => {
    await people.deleteOrganization(sql, c.get('person'), idParam(c));
    return c.body(null, 204);
  });
  account.patch('/organizations/:id/members/:userId', async (c) => {
    const body = await readBody(c, role);
    const [id, userId] = [idParam(c), idParam(c, 'userId')];
    await people.setOrganizationRole(sql, c.get('person'), id, userId, body.role);
    return c.body(null, 204);
  });
  account.delete('/organizations/:id/members/:userId', async (c) => {
    const [id, userId] = [idParam(c), idParam(c, 'userId')];
    await people.removeFromOrganization(sql, c.get('person'), id, userId);
    return c.body(null, 204);
  });

  // Invitations: the link is built here, so the web app only shows it.
  account.post('/organizations/:id/invitations', async (c) => {
    const body = await readBody(
      c,
      z.object({
        email: z.string().max(320),
        role: z.string(),
        workspaces: z
          .array(z.object({ workspaceId: z.uuid(), role: z.string() }))
          .max(100)
          .default([]),
      }),
    );
    const created = await people.createInvitation(sql, c.get('person'), idParam(c), body);
    const link = `${deps.publicOrigin}/app/invite/${created.token}`;
    return c.json({ id: created.id, link, expiresAt: created.expiresAt }, 201);
  });
  account.delete('/organizations/:id/invitations/:invitationId', async (c) => {
    const [id, invitationId] = [idParam(c), idParam(c, 'invitationId')];
    await people.revokeInvitation(sql, c.get('person'), id, invitationId);
    return c.body(null, 204);
  });
  account.get('/invitations/:token', async (c) =>
    c.json(await people.previewInvitation(sql, c.get('person'), c.req.param('token'))),
  );
  account.post('/invitations/:token/accept', async (c) =>
    c.json(await people.acceptInvitation(sql, c.get('person'), c.req.param('token'))),
  );

  // Connecting an app over OAuth (4.7): the consent page's requests.
  account.get('/oauth/client', async (c) => {
    const clientId = c.req.query('client_id') ?? '';
    const [client] = await sql<{ name: string | null; uri: string | null }[]>`
      select name, uri from oauth_clients where client_id = ${clientId} and disabled is not true`;
    if (!client)
      throw new AppError(404, 'not_found', 'This app is not known; start again from it.');
    return c.json({ clientId, name: client.name ?? clientId, uri: client.uri });
  });
  account.post('/oauth/consent', async (c) => {
    const body = await readBody(
      c,
      z.object({
        oauth_query: z.string().min(1).max(8192),
        accept: z.boolean(),
        workspaceId: z.uuid().optional(),
      }),
    );
    const { accept, workspaceId } = body;
    if (accept && !workspaceId) {
      throw new AppError(400, 'invalid_request', 'pick the workspace to connect');
    }
    const headers = forwarded(c);
    headers.set('content-type', 'application/json');
    headers.delete('content-length');
    const request = new Request(`${deps.publicOrigin}/account/auth/oauth2/consent`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ accept, oauth_query: body.oauth_query }),
    });
    if (!accept || !workspaceId) return deps.auth.handler(request);
    return connections.recordConsent(sql, c.get('person'), workspaceId, () =>
      deps.auth.consent(request, workspaceId),
    );
  });

  // Connected apps (5.1)
  account.get('/connections', async (c) =>
    c.json({ connections: await connections.listMyConnections(sql, c.get('person')) }),
  );
  account.delete('/connections/:connectionId', async (c) => {
    await connections.disconnect(sql, c.get('person'), idParam(c, 'connectionId'));
    return c.body(null, 204);
  });
  account.get('/workspaces/:id/connections', async (c) =>
    c.json(await connections.listWorkspaceConnections(sql, c.get('person'), idParam(c))),
  );
  account.delete('/workspaces/:id/connections/:connectionId', async (c) => {
    const [id, connectionId] = [idParam(c), idParam(c, 'connectionId')];
    await connections.disconnect(sql, c.get('person'), connectionId, id);
    return c.body(null, 204);
  });

  app.route('/account', account);
  return app;
}

/**
 * Better Auth routes Retainer does not expose. Consent goes through
 * /account/oauth/consent. A second provider joins a person only at sign-in,
 * under the verified-address rule (auth.ts), so the routes that link and
 * unlink provider accounts by hand stay closed.
 */
const CLOSED_AUTH_PATHS = new Set([
  '/account/auth/oauth2/consent',
  '/account/auth/oauth2/continue',
  '/account/auth/link-social',
  '/account/auth/unlink-account',
]);

/**
 * Requires a signed-in person who is not disabled, and the web app's CSRF
 * header on anything that changes data. An API key is refused outright.
 */
function signedIn(deps: AccountsDeps) {
  return createMiddleware<AccountsEnv>(async (c, next) => {
    if (c.req.header('authorization') !== undefined) {
      throw new AppError(
        403,
        'forbidden',
        'account routes take a signed-in person, not an API key or token',
      );
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireWebHeader(c, deps.publicOrigin);
    const found = await deps.auth.getSession(c.req.raw.headers);
    if (!found || found.user.disabledAt) throw new AppError(401, 'unauthorized', 'sign in first');
    c.set('person', { id: found.user.id, name: found.user.name, email: found.user.email });
    c.header('Cache-Control', 'no-store');
    await next();
  });
}

export type AccountWorkspace = {
  id: string;
  slug: string;
  name: string;
  role: WorkspaceRole;
};

export type AccountOrganization = {
  id: string;
  name: string;
  role: OrganizationRole;
  workspaces: AccountWorkspace[];
};

export type AccountDescription = {
  user: Person;
  organizations: AccountOrganization[];
  /** Invitations sent to the person's address that they have not accepted. */
  invitations: Awaited<ReturnType<typeof people.invitationsFor>>;
};

/**
 * The person, their organizations and the workspaces they can reach in each,
 * with their effective role (4.3). A workspace being deleted is left out.
 */
export async function describeAccount(sql: Sql, person: Person): Promise<AccountDescription> {
  const [rows, invitations] = await Promise.all([
    sql<
      {
        organization_id: string;
        organization_name: string;
        organization_role: OrganizationRole;
        workspace_id: string | null;
        slug: string | null;
        workspace_name: string | null;
        workspace_role: WorkspaceRole | null;
      }[]
    >`
    select o.id as organization_id, o.name as organization_name,
      om.role as organization_role,
      w.id as workspace_id, w.slug, w.name as workspace_name,
      wm.role as workspace_role
    from organization_members om
    join organizations o on o.id = om.organization_id
    left join workspaces w
      on w.organization_id = o.id and w.deletion_scheduled_at is null
    left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = om.user_id
    where om.user_id = ${person.id}
    order by o.created_at, o.id, w.name, w.id`,
    people.invitationsFor(sql, person),
  ]);
  const organizations = new Map<string, AccountOrganization>();
  for (const row of rows) {
    let organization = organizations.get(row.organization_id);
    if (!organization) {
      organization = {
        id: row.organization_id,
        name: row.organization_name,
        role: row.organization_role,
        workspaces: [],
      };
      organizations.set(row.organization_id, organization);
    }
    const role = effectiveWorkspaceRole(row.organization_role, row.workspace_role);
    if (row.workspace_id && row.slug && row.workspace_name && role) {
      organization.workspaces.push({
        id: row.workspace_id,
        slug: row.slug,
        name: row.workspace_name,
        role,
      });
    }
  }
  return {
    user: person,
    organizations: [...organizations.values()],
    invitations,
  };
}
