import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import { createApp } from '../api/app.js';
import { type Config, loadConfig, rateLimitPerMinute } from '../config.js';
import { createApiSql, type Sql } from '../db/client.js';
import { setLogLevel } from '../log.js';

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
) {
  setLogLevel(config.LOG_LEVEL);
  const app = createApp({
    sql,
    webDir: config.RETAINER_WEB_DIR,
    publicOrigin: config.RETAINER_PUBLIC_ORIGIN,
    // Checks people's session cookies; never loads Better Auth (4.4).
    accountsSecret: config.RETAINER_AUTH_SECRET,
    rateLimit: { limit: rateLimitPerMinute(config) },
  });
  return handle(app);
}

let cached: ReturnType<typeof createApiHandler> | undefined;

/** The Lambda entry point (`dist/lambda/api.handler`). */
export const handler = (event: LambdaEvent, context: LambdaContext) => {
  cached ??= createApiHandler(loadConfig());
  return cached(event, context);
};
