import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import type { AppDeps } from '../api/app.js';
import { createApp } from '../api/app.js';
import { type Config, loadConfig, rateLimitPerMinute } from '../config.js';
import { createApiSql, type Sql } from '../db/client.js';
import { extensionServices } from '../extension-control/configuration.js';
import { setLogLevel } from '../log.js';
import { requireEdge } from './edge.js';

/**
 * The API as an AWS Lambda function behind API Gateway: the
 * same Hono app the container serves, REST, MCP and the web app included.
 *
 * Boot tasks the container runs on start (migrations, first-boot key,
 * search rebuild) are not run here: the deploy runs them once through the
 * ops function, so a cold start never migrates and no key reaches the logs.
 */
export function createApiHandler(
  config: Config,
  // One request at a time per instance; a small pool keeps the total number
  // of connections bounded by the function's concurrency.
  sql: Sql = createApiSql(config, { max: config.RETAINER_DB_POOL_MAX }),
  extensions: Pick<AppDeps, 'extensionCatalog' | 'runTokens' | 'extensionActivation'> = {},
) {
  setLogLevel(config.LOG_LEVEL);
  const app = createApp({
    sql,
    ...extensions,
    webDir: config.RETAINER_WEB_DIR,
    publicOrigin: config.RETAINER_PUBLIC_ORIGIN,
    // Checks people's session cookies; never loads Better Auth (4.4).
    accountsSecret: config.RETAINER_AUTH_SECRET,
    rateLimit: { limit: rateLimitPerMinute(config) },
  });
  return requireEdge(config.RETAINER_EDGE_SECRET, handle(app));
}

let cached: Promise<ReturnType<typeof createApiHandler>> | undefined;
/** The Lambda entry point (`dist/lambda/api.handler`). */
export const handler = async (event: LambdaEvent, context: LambdaContext) => {
  cached ??= (async () => {
    const config = loadConfig(),
      sql = createApiSql(config, { max: config.RETAINER_DB_POOL_MAX });
    const extensions = await extensionServices(config);
    return createApiHandler(config, sql, {
      extensionCatalog: extensions.catalog,
      extensionActivation: extensions.activationReady,
      ...(extensions.tokens ? { runTokens: extensions.tokens } : {}),
    });
  })();
  return (await cached)(event, context);
};
