import { resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { OAUTH_SCOPES } from '@retainer/shared';
import { Hono } from 'hono';
import { authenticate } from '../auth/middleware.js';
import { oauthSettings } from '../auth/oauth-token.js';
import { meRoute, sessionRoutes } from '../auth/session.js';
import { publicOriginSchema } from '../config.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import type { SecretBroker } from '../extension-runtime/secrets.js';
import type { RunTokens } from '../extension-runtime/tokens.js';
import type { ExtensionCatalog } from '../extensions/catalog.js';
import { Extensions } from '../extensions/service.js';
import type { FileStorage } from '../file-storage/contract.js';
import { type RateLimit, rateLimit } from '../http/rate-limit.js';
import { type AppEnv, errorResponse, toAppError } from '../http/response.js';
import { mcpRoute } from '../mcp/route.js';
import { Sources } from '../sources/service.js';
import { VERSION } from '../version.js';
import { changeRoutes } from './routes/changes.js';
import { commentRoutes } from './routes/comments.js';
import { runtimeRoutes } from './routes/extension-runtime.js';
import { extensionRoutes } from './routes/extensions.js';
import { fileRoutes } from './routes/files.js';
import { memoryRoutes } from './routes/memory.js';
import { recordRoutes } from './routes/records.js';
import { retrievalRoutes } from './routes/retrieval.js';
import { schemaRoutes } from './routes/schema.js';
import { sourceRoutes } from './routes/sources.js';
import { templateRoutes } from './routes/templates.js';
import { viewRoutes } from './routes/views.js';
import { webReadRoutes } from './routes/web-read.js';

export type AppDeps = {
  fileStorage?: FileStorage | undefined;
  fileQuota?: number | undefined;
  /** A pool connected as the runtime role, so RLS applies to every query. */
  sql: Sql;
  extensionCatalog?: ExtensionCatalog;
  extensionActivation?: ReadonlySet<string>;
  runTokens?: RunTokens;
  extensionSecrets?: SecretBroker;
  webDir?: string;
  publicOrigin?: string;
  /**
   * RETAINER_AUTH_SECRET, in accounts mode: people's signed session cookies
   * reach /v1, and the key-mode sign-in at /auth/session is gone (4.1).
   */
  accountsSecret?: string;
  /** The per-workspace rate limit on /v1 and /mcp (accounts spec 4.8); none if unset. */
  rateLimit?: RateLimit;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const publicOrigin = deps.publicOrigin ? publicOriginSchema.parse(deps.publicOrigin) : undefined;

  app.onError((error, c) => errorResponse(c, toAppError(error)));

  app.notFound((c) =>
    errorResponse(c, new AppError(404, 'not_found', `no route for ${c.req.method} ${c.req.path}`)),
  );

  app.get('/health', async (c) => {
    try {
      await deps.sql`select 1`;
      return c.json({ status: 'ok', version: VERSION, database: 'ok' });
    } catch {
      return c.json({ status: 'error', version: VERSION, database: 'unreachable' }, 503);
    }
  });

  if (!deps.accountsSecret) sessionRoutes(app, deps.sql, publicOrigin);
  const v1 = new Hono<AppEnv>();
  const limit = rateLimit(deps.sql, deps.rateLimit ?? { limit: 0 });
  v1.use(
    '*',
    authenticate(deps.sql, {
      publicOrigin,
      accountsSecret: deps.accountsSecret,
      runTokens: deps.runTokens,
    }),
  );
  v1.use('*', limit);
  meRoute(v1, deps.sql);
  webReadRoutes(v1, deps.sql);
  schemaRoutes(v1, deps.sql);
  templateRoutes(v1, deps.sql);
  recordRoutes(v1, deps.sql);
  memoryRoutes(v1, deps.sql);
  commentRoutes(v1, deps.sql);
  changeRoutes(v1, deps.sql);
  retrievalRoutes(v1, deps.sql);
  viewRoutes(v1, deps.sql);
  const extensions = new Extensions(
    deps.sql,
    deps.extensionCatalog,
    deps.extensionSecrets,
    deps.extensionActivation,
  );
  extensionRoutes(v1, extensions);
  runtimeRoutes(v1, deps.sql, extensions.catalog, deps.extensionSecrets);
  fileRoutes(v1, deps.sql, deps.fileStorage, deps.fileQuota);
  sourceRoutes(
    v1,
    new Sources(deps.sql, (registration, version, digest) => {
      const release = extensions.catalog.get(registration, version);
      if (release.digest !== digest)
        throw new AppError(409, 'incompatible_runtime', 'source release changed');
      return release.manifest;
    }),
  );
  app.route('/v1', v1);

  // Accounts mode: apps connect to /mcp over OAuth as well as with API keys
  // (accounts spec 4.7). The authorization server is Better Auth, under
  // /account; this function only checks its tokens.
  const oauth = deps.accountsSecret && publicOrigin ? oauthSettings(publicOrigin) : undefined;
  if (oauth) {
    // RFC 9728 protected resource metadata: static, so the API serves it.
    const metadata = {
      resource: oauth.resource,
      authorization_servers: [oauth.issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: [...OAUTH_SCOPES],
      resource_name: 'Retainer',
    };
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      app.get(path, (c) => {
        c.header('Cache-Control', 'public, max-age=3600');
        return c.json(metadata);
      });
    }
  }
  mcpRoute(app, deps.sql, {
    publicOrigin,
    oauth,
    rateLimit: limit,
    extensionCatalog: deps.extensionCatalog,
    extensionActivation: deps.extensionActivation,
    fileStorage: deps.fileStorage,
    fileQuota: deps.fileQuota,
    runTokens: deps.runTokens,
  });

  if (deps.webDir) {
    const root = resolve(deps.webDir);
    // No other site may frame the app: the consent page, where a person lets
    // an app in, must not be clickjacked (accounts spec 4.7). Requests from
    // the app send only the origin as Referer: an OAuth page's address is
    // long, and API Gateway refuses headers over 10 KB, which cookies other
    // apps set on a parent domain can already come close to.
    app.use('/app/*', async (c, next) => {
      await next();
      c.header('Content-Security-Policy', "frame-ancestors 'none'");
      c.header('X-Frame-Options', 'DENY');
      c.header('Referrer-Policy', 'strict-origin');
    });
    app.get('/app', (c) => c.redirect('/app/'));
    app.use(
      '/app/*',
      serveStatic({ root, rewriteRequestPath: (path) => path.replace(/^\/app/, '') }),
    );
    app.get('/app/*', async (c, next) => {
      if (c.req.path.startsWith('/app/assets/')) return next();
      c.header('Cache-Control', 'no-cache');
      return serveStatic({ path: resolve(root, 'index.html') })(c, next);
    });
  }
  return app;
}
