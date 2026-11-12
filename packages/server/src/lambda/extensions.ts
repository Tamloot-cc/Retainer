import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import { loadConfig, rateLimitPerMinute } from '../config.js';
import { createApiSql } from '../db/client.js';
import { createExtensionControlApp } from '../extension-control/app.js';
import { extensionServices } from '../extension-control/configuration.js';
import { setLogLevel } from '../log.js';
import { clientIpOf, requireEdge } from './edge.js';

/** Dedicated key/accounts runtime and secret broker, independent of the sign-in control flag. */
async function createHandler() {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);
  const sql = createApiSql(config, { max: config.RETAINER_DB_POOL_MAX });
  const services = await extensionServices(config, { broker: true, ingressSql: sql });
  const app = createExtensionControlApp({
    sql,
    extensionCatalog: services.catalog,
    extensionActivation: services.activationReady,
    webhooks: services.webhooks,
    ...(services.tokens ? { runTokens: services.tokens } : {}),
    ...(services.broker ? { extensionSecrets: services.broker } : {}),
    publicOrigin: config.RETAINER_PUBLIC_ORIGIN,
    accountsSecret: config.RETAINER_AUTH_SECRET,
    rateLimit: { limit: rateLimitPerMinute(config) },
    // API Gateway's or, behind CloudFront, CloudFront's view; never a client header.
    clientIp: (c) => clientIpOf((c.env as { event?: unknown }).event, config.RETAINER_EDGE_SECRET),
  });
  return requireEdge(config.RETAINER_EDGE_SECRET, handle(app));
}
let cached: ReturnType<typeof createHandler> | undefined;
export const handler = async (event: LambdaEvent, context: LambdaContext) => {
  cached ??= createHandler();
  return (await cached)(event, context);
};
