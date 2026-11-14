import type { Hono } from 'hono';
import type { Sql } from '../db/client.js';
import type { RunTokens } from '../extension-runtime/tokens.js';
import type { AppEnv } from '../http/response.js';
import { createModelProxy } from './proxy.js';
import { modelProxyRoute, recordDirectly, usageReportRoute } from './routes.js';

/**
 * Mounts what this process serves of the model proxy, outside the `/v1`
 * caller chain: call it before the `/v1` routes are registered. Both need the
 * run verification key, so neither is mounted without it.
 */
export function mountModelRoutes(
  app: Hono<AppEnv>,
  deps: {
    sql: Sql;
    runTokens?: RunTokens | undefined;
    model?: { apiKey: string | undefined; upstream: string } | undefined;
    modelUsageSecret?: string | undefined;
  },
) {
  const { runTokens: tokens } = deps;
  if (!tokens) return;
  if (deps.modelUsageSecret)
    usageReportRoute(app, { sql: deps.sql, tokens, secret: deps.modelUsageSecret });
  if (deps.model)
    modelProxyRoute(
      app,
      createModelProxy({
        tokens,
        apiKey: deps.model.apiKey,
        upstream: deps.model.upstream,
        record: recordDirectly(deps.sql),
      }),
    );
}
