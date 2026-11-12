import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Caller } from '../caller.js';
import { changePosition } from '../db/change-cursor.js';
import type { Sql } from '../db/client.js';
import type { ApiKeyScope } from '../db/schema.js';
import { AppError } from '../errors.js';
import { isInstallationKey, lookupInstallationKey } from '../extension-runtime/credentials.js';
import { isRunToken, type RunTokens } from '../extension-runtime/tokens.js';
import { type AppEnv, errorResponse } from '../http/response.js';
import {
  accountSessionCookie,
  lookupAccountSession,
  requestedWorkspace,
  WORKSPACE_HEADER,
} from './account-session.js';
import { looksLikeJwt, lookupOAuthToken, type OAuthSettings } from './oauth-token.js';
import { lookupKey, requireWebHeader, SESSION_COOKIE } from './session.js';

const BEARER = /^Bearer\s+(\S+)$/i;
/** A standalone app names the change cursor it is reacting to (extensions spec §9.4). */
export const CAUSED_BY_HEADER = 'Retainer-Caused-By';

export type AuthOptions = {
  runTokens?: RunTokens | undefined;
  installationKeys?: boolean;
  publicOrigin?: string | undefined;
  /** RETAINER_AUTH_SECRET: accounts mode, where people sign in (4.1). */
  accountsSecret?: string | undefined;
  /**
   * Accepts MCP OAuth access tokens for this resource (accounts spec 4.7),
   * and points a 401 at its metadata so clients can start signing in.
   */
  oauth?: OAuthSettings | undefined;
};

/**
 * Authenticates a request (7, accounts spec 4.4), in this order:
 *
 * 1. `Authorization: Bearer <key>`: an API key, looked up by its hash
 *    through `retainer_lookup_api_key`, or on /mcp in accounts mode an
 *    OAuth access token (oauth-token.ts). It never falls back to a cookie.
 * 2. In accounts mode, a person's signed session cookie, for the workspace
 *    `X-Retainer-Workspace` names, checked on every request.
 * 3. The key-mode cookie, which holds a personal API key.
 *
 * The caller's workspace, scopes and actor come from the credential, never
 * from the request body.
 */
export function authenticate(sql: Sql, options: AuthOptions = {}): MiddlewareHandler<AppEnv> {
  const { publicOrigin, accountsSecret, oauth } = options;
  // RFC 9728: tells an OAuth client where to learn how to get a token.
  const challenge = (error?: string) => {
    const params = [
      ...(error ? [`error="${error}"`] : []),
      ...(oauth ? [`resource_metadata="${oauth.resourceMetadata}"`] : []),
    ];
    return params.length > 0 ? `Bearer ${params.join(', ')}` : 'Bearer';
  };
  return createMiddleware<AppEnv>(async (c, next) => {
    const authorization = c.req.header('authorization');
    const accountCookie = accountsSecret ? accountSessionCookie(c) : undefined;
    const keyCookie = getCookie(c, SESSION_COOKIE);
    if (authorization === undefined && !accountCookie && !keyCookie) {
      c.header('www-authenticate', challenge());
      return errorResponse(
        c,
        new AppError(
          401,
          'unauthorized',
          'send an API key as "Authorization: Bearer <key>" or sign in',
        ),
      );
    }
    try {
      let caller: Caller;
      if (authorization !== undefined) {
        const key = BEARER.exec(authorization)?.[1];
        if (!key) throw new AppError(401, 'unauthorized', 'send "Authorization: Bearer <key>"');
        if (isInstallationKey(key) && !options.installationKeys)
          throw new AppError(401, 'unauthorized', 'installation keys require the REST resource');
        caller = isInstallationKey(key)
          ? await lookupInstallationKey(sql, key)
          : isRunToken(key)
            ? options.runTokens
              ? await options.runTokens.authenticate(sql, key)
              : (() => {
                  throw new AppError(401, 'unauthorized', 'run credentials are not enabled');
                })()
            : oauth && looksLikeJwt(key)
              ? await lookupOAuthToken(sql, key, oauth)
              : await lookupKey(sql, key);
        // A key belongs to one workspace; naming another is a client mistake.
        const named = c.req.header(WORKSPACE_HEADER);
        if (named !== undefined && named !== caller.workspaceId) {
          throw new AppError(
            400,
            'invalid_request',
            `${WORKSPACE_HEADER} names a workspace this credential does not belong to`,
          );
        }
      } else {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) requireWebHeader(c, publicOrigin);
        caller =
          accountCookie && accountsSecret
            ? await lookupAccountSession(sql, {
                cookie: accountCookie,
                secret: accountsSecret,
                workspace: requestedWorkspace(c),
              })
            : await lookupKey(sql, keyCookie ?? '');
      }
      const causedBy = c.req.header(CAUSED_BY_HEADER);
      if (causedBy !== undefined) {
        // Declaring a cause only adds installations to the chain, which can
        // only suppress triggers; it is limited to standalone app credentials.
        if (!caller.installation)
          throw new AppError(
            400,
            'invalid_request',
            `${CAUSED_BY_HEADER} is accepted only from standalone installation credentials`,
          );
        // The cursor names a feed change, which only a reader may see.
        if (!caller.scopes.includes('read'))
          throw new AppError(403, 'forbidden', `${CAUSED_BY_HEADER} requires read scope`);
        caller = {
          ...caller,
          installation: {
            ...caller.installation,
            causedBy: changePosition(caller.workspaceId, causedBy),
          },
        };
      }
      c.set('caller', caller);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.status === 401) c.header('www-authenticate', challenge('invalid_token'));
      return errorResponse(c, error);
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });
}

/** Requires a scope; `admin` implies every other scope. */
export function requireScope(scope: ApiKeyScope): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const missing = missingScope(c.get('caller'), scope);
    if (missing) return errorResponse(c, missing);
    await next();
  });
}

const PERSON_NEEDS: Record<ApiKeyScope, string> = {
  read: 'You need access to this workspace to see this.',
  write: 'Your role in this workspace lets you look but not make changes; ask an admin.',
  'schema:write': "Only a workspace admin can change the workspace's structure.",
  admin: 'Only a workspace admin can do this.',
};

/**
 * The 403 for a caller without `scope`, or undefined when it has it (REST
 * and MCP). A signed-in person is told about their role, an agent about its
 * key.
 */
export function missingScope(
  caller: Pick<Caller, 'scopes' | 'userId' | 'connectedBy'>,
  scope: ApiKeyScope,
): AppError | undefined {
  const { scopes } = caller;
  if (scopes.includes(scope) || scopes.includes('admin')) return undefined;
  const message = caller.userId
    ? PERSON_NEEDS[scope]
    : caller.connectedBy
      ? `this connection needs the "${scope}" scope: the person who connected it must allow it and have a role in this workspace that includes it`
      : `this API key needs the "${scope}" scope`;
  return new AppError(403, 'forbidden', message, { required: scope, scopes });
}
