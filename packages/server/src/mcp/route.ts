import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { authenticate } from '../auth/middleware.js';
import { type OAuthSettings, pinnedOAuthSettings } from '../auth/oauth-token.js';
import type { Sql } from '../db/client.js';
import type { AppEnv } from '../http/response.js';
import { type InProcessMcpOptions, mcpHandler } from './in-process.js';

/**
 * The address pinned to one workspace, as a route (accounts spec 4.7). Only a
 * lowercase workspace ID matches (`PINNED_WORKSPACE_ID`); anything else is
 * the app's usual 404.
 */
export const PINNED_MCP_ROUTE =
  '/mcp/w/:workspace{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}';

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
  options: InProcessMcpOptions & {
    /** Accepts MCP OAuth access tokens too (accounts spec 4.7). */
    oauth?: OAuthSettings | undefined;
    rateLimit: MiddlewareHandler<AppEnv>;
  },
) {
  const { publicOrigin, oauth } = options;
  const handler = mcpHandler(sql, options);
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
    const workspace = c.req.param('workspace');
    return authenticate(sql, {
      publicOrigin,
      oauth: oauth && publicOrigin ? pinnedOAuthSettings(publicOrigin, workspace) : undefined,
      workspace,
    })(c, next);
  });
  app.use(PINNED_MCP_ROUTE, options.rateLimit);
  app.all(PINNED_MCP_ROUTE, serve);
}
