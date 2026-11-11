import { Hono } from 'hono';
import type { AppDeps } from '../api/app.js';
import { runtimeRoutes } from '../api/routes/extension-runtime.js';
import { extensionRoutes } from '../api/routes/extensions.js';
import { webhookIngress, webhookRuntime } from '../api/routes/webhooks.js';
import { authenticate } from '../auth/middleware.js';
import { installationOAuthSettings } from '../auth/oauth-token.js';
import { AppError } from '../errors.js';
import { Extensions } from '../extensions/service.js';
import { rateLimit } from '../http/rate-limit.js';
import { type AppEnv, errorResponse, toAppError } from '../http/response.js';

/** Dedicated runtime/broker surface in key mode and accounts mode; never loads account sign-in code. */
export function createExtensionControlApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  app.onError((error, c) => errorResponse(c, toAppError(error)));
  app.notFound((c) =>
    errorResponse(c, new AppError(404, 'not_found', 'extension control route not found')),
  );
  app.get('/health', async (c) => {
    try {
      await deps.sql`select 1`;
      return c.json({ status: 'ok', protocolVersion: 1 });
    } catch {
      return c.json({ status: 'unavailable', protocolVersion: 1 }, 503);
    }
  });
  webhookIngress(app, deps.webhooks);
  const v1 = new Hono<AppEnv>();
  v1.use(
    '*',
    authenticate(deps.sql, {
      publicOrigin: deps.publicOrigin,
      accountsSecret: deps.accountsSecret,
      runTokens: deps.runTokens,
      installationKeys: !deps.accountsSecret,
      oauth:
        deps.accountsSecret && deps.publicOrigin
          ? installationOAuthSettings(deps.publicOrigin)
          : undefined,
    }),
  );
  v1.use('*', rateLimit(deps.sql, deps.rateLimit ?? { limit: 0 }));
  const extensions = new Extensions(
    deps.sql,
    deps.extensionCatalog,
    deps.extensionSecrets,
    deps.extensionActivation,
  );
  extensionRoutes(v1, extensions, !deps.accountsSecret);
  runtimeRoutes(v1, deps.sql, extensions.catalog, deps.extensionSecrets);
  webhookRuntime(v1, deps.webhooks);
  app.route('/v1', v1);
  return app;
}
