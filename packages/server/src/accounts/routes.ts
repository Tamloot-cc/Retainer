import {
  effectiveWorkspaceRole,
  type OrganizationRole,
  pinnedWorkspaceOfResources,
  type WorkspaceRole,
} from '@retainer/shared';
import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { WORKSPACE_HEADER } from '../auth/account-session.js';
import { allowsCliAccountRoute } from '../auth/cli-routes.js';
import { bearerToken } from '../auth/middleware.js';
import {
  cliOAuthSettings,
  tokenNamesAudience,
  verifyAccountCliToken,
} from '../auth/oauth-token.js';
import { requireWebHeader } from '../auth/session.js';
import { CLI_CLIENT_ID } from '../db/cli.js';
import type { Sql } from '../db/client.js';
import { isUuid } from '../db/ids.js';
import { AppError, forbidden, notFound } from '../errors.js';
import { ExtensionCatalog } from '../extensions/catalog.js';
import { maintenanceResponse, readOnlyViolation } from '../http/maintenance.js';
import { idParam, readBody, zodError } from '../http/request.js';
import { errorResponse, toAppError } from '../http/response.js';
import { listTemplates } from '../templates/catalog.js';
import { lockOrganization, lockWorkspaceOrganization } from '../workspaces/organizations.js';
import { type AccountSession, type Auth, CLIENT_IP_HEADER } from './auth.js';
import {
  approvalForBrowser,
  approvalStatus,
  decideApproval,
  endElevation,
  openElevations,
  startElevation,
} from './cli-approvals.js';
import { cliConsent, ensureCliClient, recordCliLogin, revokeCliLogin } from './cli-logins.js';
import * as connections from './connections.js';
import {
  AGENT_OAUTH_SCOPES,
  appSignInRequest,
  appSignInTarget,
  consentInstallation,
  IDENTITY_SCOPES,
  installationOptions,
  installationRequest,
  recordAppSignIn,
} from './extensions.js';
import {
  assertionSchema,
  passkeyChange,
  passkeyChangeOptions,
  proofSchema,
  removePasskey,
} from './passkey-changes.js';
import type { Person } from './people.js';
import * as people from './people.js';
import { linkPinnedResource, pinnedRequest } from './pinned.js';

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
  Variables: { person: Person; session?: AccountSession };
};

export type AccountsDeps = {
  auth: Auth;
  hostedOnboarding?: boolean;
  restricted?: boolean;
  extensionCatalog?: ExtensionCatalog;
  /** A connection as the control role. */
  sql: Sql;
  publicOrigin: string;
  /** The client's address, from the connection, API Gateway or CloudFront, never a header the client set. */
  clientIp: (c: Context) => string | undefined;
};

export function createAccountsApp(deps: AccountsDeps) {
  const app = new Hono<AccountsEnv>();
  const { sql } = deps;
  const cliResource = cliOAuthSettings(deps.publicOrigin).resource;
  const catalog = deps.extensionCatalog ?? new ExtensionCatalog();
  app.onError((error, c) =>
    deps.restricted && readOnlyViolation(error)
      ? maintenanceResponse(false, 'reads')
      : errorResponse(c, toAppError(error)),
  );
  if (deps.restricted)
    app.use('*', async (c, next) => {
      const { method, path } = c.req;
      const read = method === 'GET' || method === 'HEAD';
      if (read && ['/account', '/account/'].includes(path)) return next();
      if (method === 'POST' && path === '/account/auth/get-session')
        return maintenanceResponse(true, 'session-refresh');
      return maintenanceResponse(true, read ? 'reads' : 'writes');
    });
  app.notFound((c) =>
    errorResponse(c, new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`)),
  );

  app.use('*', async (c, next) => {
    const bearer = bearerToken(c.req.header('authorization'));
    if (
      bearer &&
      tokenNamesAudience(bearer, cliResource) &&
      !allowsCliAccountRoute(c.req.method, c.req.path)
    )
      throw forbidden('The Retainer CLI cannot call this route.');
    await next();
  });

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
    let request = new Request(c.req.raw, { headers: forwarded(c) });
    if (c.req.method === 'GET' && c.req.path === AUTHORIZE_PATH) {
      const url = new URL(request.url);
      const cli = cliConsent(url.search, deps.publicOrigin);
      if (cli) await ensureCliClient(sql, deps.publicOrigin);
      // A request that names no scope gets the client's registered scopes
      // (the agent scopes for a client with none). Every registered client
      // may ask for the identity scopes, so they are left out: only an app
      // sign-in may ask for them, by name.
      if (!url.searchParams.has('scope')) {
        const [client] = await sql<{ scopes: string[] | null }[]>`
          select scopes from oauth_clients where client_id=${url.searchParams.get('client_id') ?? ''}`;
        url.searchParams.set(
          'scope',
          (client?.scopes ?? AGENT_OAUTH_SCOPES)
            .filter((scope) => !IDENTITY_SCOPES.has(scope))
            .join(' '),
        );
        request = new Request(url, request);
      }
      // Signing in to a standalone app from its sidebar link: no consent
      // page, decided per request (extensions spec 8). Any other request for
      // the person's identity is refused here.
      const signIn = appSignInRequest(new URL(c.req.url).searchParams);
      // The app's own request arrives from its site without Retainer's
      // session cookie; Better Auth sends it to the sign-in page, which
      // comes back here with the cookie and the same parameters.
      const session = signIn ? await deps.auth.getSession(request.headers) : null;
      if (signIn && session) {
        const target = await appSignInTarget(sql, catalog, {
          userId: session.user.id,
          clientId: signIn.clientId,
          installationId: signIn.installationId,
          redirectUri: signIn.redirectUri,
        });
        if (!target)
          throw forbidden(
            'This app is not installed in a workspace you belong to, or it cannot sign you in.',
          );
        await recordAppSignIn(sql, {
          userId: session.user.id,
          clientId: signIn.clientId,
          workspaceId: target.workspaceId,
        });
        return deps.auth.forWorkspace(request, target.workspaceId);
      }
      // An address pinned to one workspace (4.7): Better Auth checks the
      // resource before anyone signs in, so it must exist and be linked to
      // the client by then. A client registering during this request is
      // linked by the client metadata document hook (auth.ts).
      const clients = url.searchParams.getAll('client_id');
      const pinned = pinnedRequest(
        url.searchParams.getAll('resource'),
        clients.length === 1 ? clients[0] : undefined,
        deps.publicOrigin,
      );
      if (pinned && !cli) await linkPinnedResource(sql, pinned);
    }
    return deps.auth.handler(request);
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
  const browserOnly = signedIn(deps);
  account.use('*', async (c, next) => {
    const authorization = c.req.header('authorization');
    const bearer = bearerToken(authorization);
    if (!bearer || !tokenNamesAudience(bearer, cliResource)) return browserOnly(c, next);
    if (!allowsCliAccountRoute(c.req.method, c.req.path))
      throw forbidden('The Retainer CLI cannot call this route.');
    const identity = await verifyAccountCliToken(sql, bearer, cliOAuthSettings(deps.publicOrigin));
    const [person] = await sql<{ id: string; name: string; email: string }[]>`
      select u.id, u.name, u.email from cli_logins l
      join users u on u.id=l.user_id and u.disabled_at is null
      join oauth_clients cl on cl.client_id=${CLI_CLIENT_ID} and cl.disabled is not true
      where l.id=${identity.loginId} and u.id=${identity.userId} and l.revoked_at is null`;
    if (!person) throw new AppError(401, 'unauthorized', 'This CLI login has ended; log in again.');
    const workspace = c.req.header(WORKSPACE_HEADER)?.toLowerCase();
    const approvalId = c.req.header('x-retainer-approval')?.toLowerCase();
    if ((workspace && !isUuid(workspace)) || (approvalId && !isUuid(approvalId)))
      throw new AppError(400, 'invalid_request', 'Use IDs for the workspace and approval headers.');
    const routeWorkspace = /^\/account\/workspaces\/([^/]+)/.exec(c.req.path)?.[1]?.toLowerCase();
    if (
      workspace &&
      (routeWorkspace
        ? workspace !== routeWorkspace
        : c.req.path.startsWith('/account/organizations/'))
    )
      throw new AppError(
        400,
        'wrong_workspace',
        'The workspace header does not match the route target.',
      );
    c.set('person', {
      ...person,
      cli: {
        ...identity,
        origin: deps.publicOrigin,
        ...(workspace ? { workspace } : {}),
        ...(approvalId ? { approvalId } : {}),
      },
    });
    c.header('Cache-Control', 'no-store');
    await next();
  });
  account.post('/passkeys/change-options', async (c) => {
    const session = c.get('session');
    if (!session) throw forbidden('Use Your account to manage passkeys.');
    const change = await readBody(c, passkeyChange);
    return c.json(
      await passkeyChangeOptions(
        sql,
        { userId: session.user.id, sessionId: session.session.id },
        change,
        deps.publicOrigin,
      ),
    );
  });
  account.post('/passkeys/:id/remove', async (c) => {
    const session = c.get('session');
    if (!session) throw forbidden('Use Your account to manage passkeys.');
    const proof = await readBody(c, proofSchema);
    await removePasskey(
      sql,
      { userId: session.user.id, sessionId: session.session.id },
      idParam(c),
      proof,
      deps.publicOrigin,
    );
    return c.body(null, 204);
  });
  account.post('/cli/approvals', async (c) => {
    const person = c.get('person');
    if (!person.cli) throw forbidden('Only a CLI login can start an elevation.');
    const body = await readBody(
      c,
      z.strictObject({
        workspaceId: z.uuid().optional(),
        organizationId: z.uuid().optional(),
        minutes: z.number().int().min(1).max(60).default(30),
        reason: z.string().trim().max(1000).optional(),
      }),
    );
    const { workspaceId, organizationId } = body;
    if ((!workspaceId && !organizationId) || (workspaceId && organizationId))
      throw new AppError(400, 'invalid_request', 'Choose one workspace or organization.');
    if (person.cli.workspace && person.cli.workspace !== workspaceId)
      throw new AppError(
        400,
        'wrong_workspace',
        'The workspace header does not match the approval target.',
      );
    const identity = person.cli;
    return c.json(
      await sql.begin(async (tx) => {
        if (workspaceId) {
          await lockWorkspaceOrganization(tx, workspaceId);
          await people.workspaceAccess(tx, person, workspaceId);
          return startElevation(
            tx,
            identity,
            { workspaceId },
            body.minutes,
            body.reason,
            deps.publicOrigin,
          );
        }
        if (!organizationId) throw notFound('organization');
        await lockOrganization(tx, organizationId);
        await people.requireOrganizationManager(tx, person, organizationId);
        return startElevation(
          tx,
          identity,
          { organizationId },
          body.minutes,
          body.reason,
          deps.publicOrigin,
        );
      }),
      201,
    );
  });
  account.get('/cli/approvals/:id', async (c) => {
    const person = c.get('person');
    const id = idParam(c);
    return c.json(
      person.cli
        ? await approvalStatus(sql, person.cli, id)
        : await approvalForBrowser(sql, person.id, id, deps.publicOrigin),
    );
  });
  account.post('/cli/approvals/:id/decide', async (c) => {
    const session = c.get('session');
    if (!session) throw forbidden('Open the approval in your browser.');
    const { allow, assertion } = await readBody(
      c,
      z.strictObject({
        allow: z.boolean(),
        assertion: assertionSchema.optional(),
      }),
    );
    return c.json(
      await decideApproval(sql, session, idParam(c), allow, deps.publicOrigin, assertion),
    );
  });
  account.post('/cli/approvals/:id/end', async (c) => {
    const person = c.get('person');
    await endElevation(sql, person.id, idParam(c), person.cli?.loginId);
    return c.body(null, 204);
  });
  account.delete('/cli/login', async (c) => {
    const { cli } = c.get('person');
    if (!cli) throw forbidden('Only a CLI login can log itself out here.');
    await revokeCliLogin(sql, cli);
    return c.body(null, 204);
  });
  account.get('/', async (c) => {
    const person = c.get('person');
    const [account, elevations] = await Promise.all([
      describeAccount(sql, person),
      openElevations(sql, person.id, person.cli?.loginId),
    ]);
    return c.json({
      ...account,
      providers: deps.auth.providers,
      ...(person.cli || elevations.length ? { elevations } : {}),
      ...(deps.hostedOnboarding ? { hostedOnboarding: true } : {}),
    });
  });

  // Workspaces
  account.get('/templates', (c) => c.json({ templates: listTemplates([]) }));
  if (deps.hostedOnboarding) {
    account.post('/onboarding/workspace', async (c) => {
      const body = await readBody(
        c,
        z.strictObject({
          skipInvitation: z.boolean().default(false),
          template: z.string().min(1).max(100).optional(),
          oauthQuery: z.string().min(1).max(8192).optional(),
        }),
      );
      if (body.oauthQuery) await requireCurrentAuthorization(deps.auth, body.oauthQuery);
      return c.json({
        workspace: await people.ensureDefaultWorkspace(
          sql,
          c.get('person'),
          body.skipInvitation,
          deps.publicOrigin,
          body.template,
        ),
      });
    });
  }
  account.post('/workspaces', async (c) => {
    const body = await readBody(
      c,
      named.extend({ template: z.string().optional(), organizationId: z.uuid().optional() }),
    );
    return c.json(
      await people.createWorkspaceFor(
        sql,
        c.get('person'),
        body,
        deps.hostedOnboarding ? deps.publicOrigin : undefined,
      ),
      201,
    );
  });
  account.patch('/workspaces/:id', async (c) => {
    const { name } = await readBody(c, named);
    return c.json(await people.renameWorkspace(sql, c.get('person'), idParam(c), name));
  });
  account.delete('/workspaces/:id', async (c) => {
    const { name } = await readBody(c, named);
    return c.json(
      await people.deleteWorkspace(
        sql,
        c.get('person'),
        idParam(c),
        name,
        deps.extensionCatalog?.runtime,
      ),
    );
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

  account.get('/organizations/:id/invitations', async (c) => {
    const id = idParam(c);
    await people.requireOrganizationManager(sql, c.get('person'), id);
    return c.json({ invitations: await people.pendingInvitations(sql, id) });
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
    const [client] = await sql<
      { name: string | null; uri: string | null; onboarding_workspace_id: string | null }[]
    >`
      select name, uri, onboarding_workspace_id from oauth_clients where client_id = ${clientId} and disabled is not true`;
    if (!client)
      throw new AppError(404, 'not_found', 'This app is not known; start again from it.');
    return c.json({
      clientId,
      name: client.name ?? clientId,
      uri: client.uri,
      ...(client.onboarding_workspace_id ? { workspaceId: client.onboarding_workspace_id } : {}),
    });
  });
  account.get('/oauth/installations', async (c) => {
    const parsed = z
      .object({ workspaceId: z.uuid(), client_id: z.string().min(1).max(2048) })
      .safeParse(c.req.query());
    if (!parsed.success) throw zodError(parsed.error);
    const query = parsed.data;
    return c.json(
      await installationOptions(
        sql,
        c.get('person'),
        query.workspaceId,
        query.client_id,
        deps.extensionCatalog,
      ),
    );
  });
  account.post('/oauth/consent', async (c) => {
    const body = await readBody(
      c,
      z.object({
        oauth_query: z.string().min(1).max(8192),
        accept: z.boolean(),
        workspaceId: z.uuid().optional(),
        installationId: z.uuid().optional(),
        expectedGeneration: z.number().int().positive().optional(),
      }),
    );
    const cli = cliConsent(body.oauth_query, deps.publicOrigin);
    if (cli || deps.hostedOnboarding)
      await requireCurrentAuthorization(deps.auth, body.oauth_query);
    const { accept, workspaceId } = body;
    if (accept && !workspaceId && !cli) {
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
    if (cli) {
      if (workspaceId || body.installationId || body.expectedGeneration)
        throw new AppError(400, 'invalid_request', 'CLI consent belongs to the account.');
      if (!accept) return deps.auth.handler(request);
      return recordCliLogin(sql, c.get('person').id, cli.machineName, (id) =>
        deps.auth.forWorkspace(request, id),
      );
    }
    if (!accept || !workspaceId) return deps.auth.handler(request);
    // An app sign-in never shows this page; nothing else may ask for identity.
    if (appSignInRequest(new URLSearchParams(body.oauth_query)))
      throw new AppError(400, 'invalid_request', 'Open the app from Retainer to sign in to it.');
    const grant = installationRequest(body.oauth_query, deps.publicOrigin);
    if (grant) {
      if (!body.installationId || !body.expectedGeneration)
        throw new AppError(400, 'invalid_request', 'pick the reviewed installation to connect');
      return consentInstallation({
        sql,
        person: c.get('person'),
        workspaceId,
        installationId: body.installationId,
        expectedGeneration: body.expectedGeneration,
        grant,
        ...(deps.extensionCatalog ? { catalog: deps.extensionCatalog } : {}),
        record: (referenceId) => deps.auth.forWorkspace(request, referenceId),
      });
    }
    if (body.installationId || body.expectedGeneration)
      throw new AppError(400, 'invalid_request', 'MCP uses a separate person connection');
    const clientId = new URLSearchParams(body.oauth_query).get('client_id');
    const [client] = await sql<{ onboarding_workspace_id: string | null }[]>`
      select onboarding_workspace_id from oauth_clients where client_id = ${clientId}`;
    if (client?.onboarding_workspace_id && client.onboarding_workspace_id !== workspaceId) {
      throw new AppError(
        400,
        'wrong_workspace',
        'This setup prompt connects to a different workspace.',
      );
    }
    // An address pinned to one workspace connects only to it (4.7).
    const pinned = pinnedWorkspaceOfResources(
      new URLSearchParams(body.oauth_query).getAll('resource'),
      deps.publicOrigin,
    );
    if (pinned && pinned !== workspaceId) {
      throw new AppError(
        400,
        'wrong_workspace',
        "This connection's address is for a different workspace.",
      );
    }
    return connections.recordConsent(sql, c.get('person'), workspaceId, () =>
      deps.auth.forWorkspace(request, workspaceId),
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

async function requireCurrentAuthorization(auth: Auth, query: string) {
  if (!(await auth.validOAuthQuery(query))) {
    throw new AppError(
      400,
      'expired_authorization',
      'This authorization link expired. Start the connection again in your agent.',
    );
  }
}

const AUTHORIZE_PATH = '/account/auth/oauth2/authorize';

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
  '/account/auth/passkey/delete-passkey',
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
    c.set('session', found);
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
    user: { id: person.id, name: person.name, email: person.email },
    organizations: [...organizations.values()],
    invitations,
  };
}
