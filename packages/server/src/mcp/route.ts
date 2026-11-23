import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { authenticate } from '../auth/middleware.js';
import {
  isPinnableWorkspaceId,
  type OAuthSettings,
  PINNED_MCP_PATH,
  pinnedOAuthSettings,
} from '../auth/oauth-token.js';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import type { ExtensionCatalog } from '../extensions/catalog.js';
import type { FileStorage } from '../file-storage/contract.js';
import { type AppEnv, errorResponse } from '../http/response.js';
import { log } from '../log.js';
import type { RoutineConfig } from '../routines/capabilities.js';
import { createMcpServer } from './server.js';

/** The address pinned to one workspace, as a route (accounts spec 4.7). */
export const PINNED_MCP_ROUTE = `${PINNED_MCP_PATH}:workspace`;

/**
 * Serves MCP over Streamable HTTP at `/mcp` (6.2), and at `/mcp/w/<workspace
 * ID>`, the same server pinned to one workspace (accounts spec 4.7). The API
 * key or OAuth token is checked by the same middleware as REST; the caller it
 * yields reaches the tools through the handler's auth info, never through the
 * request body. Serving is stateless: each request gets a server built for
 * its caller.
 */
export function mcpRoute(
  app: Hono<AppEnv>,
  sql: Sql,
  options: {
    extensionCatalog?: ExtensionCatalog | undefined;
    extensionActivation?: ReadonlySet<string> | undefined;
    fileStorage?: FileStorage | undefined;
    fileQuota?: number | undefined;
    routines?: RoutineConfig | undefined;
    publicOrigin?: string | undefined;
    /** Accepts MCP OAuth access tokens too (accounts spec 4.7). */
    oauth?: OAuthSettings | undefined;
    rateLimit: MiddlewareHandler<AppEnv>;
  },
) {
  const { publicOrigin, oauth } = options;
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.caller as Caller | undefined;
      // Unreachable behind authenticate(); fail closed if that ever changes.
      if (!caller) throw new Error('MCP request reached the server without a caller');
      return createMcpServer(sql, caller, options.extensionCatalog, options);
    },
    { onerror: (error) => log.error(error) },
  );
  const serve = (c: Context<AppEnv>) => {
    const caller = c.get('caller');
    const authInfo: AuthInfo = {
      // The key itself never travels past the middleware.
      token: '',
      clientId: caller.actor.id,
      scopes: [...caller.scopes],
      extra: { caller },
    };
    return handler.fetch(c.req.raw, { authInfo });
  };

  // Extension runs use only the REST runtime and API endpoints: a run token is
  // never an MCP credential, so it cannot reach tools beyond its function's needs.
  app.use('/mcp', authenticate(sql, { publicOrigin, oauth }));
  app.use('/mcp', options.rateLimit);
  app.all('/mcp', serve);

  // A pinned address is its own OAuth resource: its tokens name it as their
  // audience, and any credential must belong to its workspace.
  app.use(PINNED_MCP_ROUTE, (c, next) => {
    const workspace = c.req.param('workspace') ?? '';
    if (!isPinnableWorkspaceId(workspace))
      return Promise.resolve(
        errorResponse(
          c,
          new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`),
        ),
      );
    return authenticate(sql, {
      publicOrigin,
      oauth: oauth && publicOrigin ? pinnedOAuthSettings(publicOrigin, workspace) : undefined,
      workspace,
    })(c, next);
  });
  app.use(PINNED_MCP_ROUTE, options.rateLimit);
  app.all(PINNED_MCP_ROUTE, serve);
}
