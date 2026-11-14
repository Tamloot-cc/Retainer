import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './api/app.js';
import {
  accountsMode,
  accountsOrigin,
  loadConfig,
  ownerDatabaseUrl,
  rateLimitPerMinute,
} from './config.js';
import {
  createApiSql,
  createControlSql,
  createRuntimeSql,
  createSql,
  type Sql,
} from './db/client.js';
import { applyLogins } from './db/logins.js';
import { createExtensionControlApp } from './extension-control/app.js';
import { extensionServices } from './extension-control/configuration.js';
import { log, setLogLevel } from './log.js';
import { bootstrap, firstBootBanner } from './operator/bootstrap.js';
import { rebuildSearchText } from './records/rebuild-search.js';
import { startWorker } from './worker/index.js';
import { startPurger } from './worker/purge.js';
import { upgradeWorkspaces } from './workspaces/upgrade.js';

const config = loadConfig();
setLogLevel(config.LOG_LEVEL);

// Boot tasks run as the migration role: only it can create workspaces and keys,
// and it rebuilds stale search text and upgrades workspaces across the database.
const owner = createSql(ownerDatabaseUrl(config), { max: 1 });
try {
  // The runtime and control roles log in themselves when their URLs are set.
  await applyLogins(config, owner);
  const firstBoot = await bootstrap(owner);
  // Printed whatever LOG_LEVEL is: it holds the only copy of the first key.
  if (firstBoot) console.log(firstBootBanner(firstBoot));
  // A migration that changes how search text is built leaves it null (5.1).
  const rebuilt = await rebuildSearchText(owner);
  if (rebuilt > 0) log.info(`Rebuilt the search text of ${rebuilt} records.`);
  // A release that adds built-in objects, fields or protection brings older
  // workspaces up to it (3); it logs what it did.
  await upgradeWorkspaces(owner);
} finally {
  await owner.end({ timeout: 5 });
}

// Everything else runs as the runtime role, so row-level security applies.
// The API and the worker each get their own pool: only the API's has the
// statement timeout, and a long consolidator pass does not take the API's
// connections (accounts spec 4.8).
const stops: Array<() => Promise<void>> = [];
const pools: Sql[] = [];
const role = config.RETAINER_ROLE;
const pool = (sql: Sql) => {
  pools.push(sql);
  return sql;
};

// Accounts mode (accounts spec 4.1): /account runs as the control role, in
// this process with `all` or alone with `control`. Loaded only then, so key
// mode never loads Better Auth.
let accounts:
  | { fetch: (request: Request, env: Record<string, unknown>) => Response | Promise<Response> }
  | undefined;
if (accountsMode(config) && (role === 'all' || role === 'control')) {
  const { createAccountsServer } = await import('./accounts/index.js');
  // Ended after every stop, so the purger finishes a removal first.
  const control = pool(createControlSql(config, { max: config.RETAINER_DB_POOL_MAX }));
  const authControl = pool(createControlSql(config, { max: config.RETAINER_DB_POOL_MAX }));
  accounts = createAccountsServer({
    config,
    sql: control,
    authSql: authControl,
    clientIp: (c) => getConnInfo(c).remote.address,
  });
  // Removes deleted workspaces for good once their grace period ends (4.5).
  stops.push(startPurger({ sql: control }).stop);
}

const extensionApiSql =
  role === 'api' || role === 'all' || role === 'extensions'
    ? pool(createApiSql(config, { max: config.RETAINER_DB_POOL_MAX }))
    : undefined;
const extensionWorkerSql =
  role === 'worker' || role === 'all' || role === 'files'
    ? pool(createRuntimeSql(config, { max: config.RETAINER_DB_POOL_MAX }))
    : undefined;
const extensions = await extensionServices(config, {
  broker: role === 'all' || role === 'api' || role === 'extensions',
  ...(extensionApiSql && ['all', 'api', 'extensions'].includes(role)
    ? { ingressSql: extensionApiSql }
    : {}),
  ...(extensionWorkerSql ? { workerSql: extensionWorkerSql } : {}),
});
if (role === 'api' || role === 'all' || role === 'control' || role === 'extensions') {
  const app =
    role === 'control'
      ? undefined
      : (role === 'extensions' ? createExtensionControlApp : createApp)({
          sql: extensionApiSql as Sql,
          fileStorage: extensions.fileStorage,
          fileQuota: config.RETAINER_FILE_QUOTA_BYTES,
          extensionCatalog: extensions.catalog,
          extensionActivation: extensions.activationReady,
          webhooks: extensions.webhooks,
          ...(extensions.tokens ? { runTokens: extensions.tokens } : {}),
          ...(extensions.broker ? { extensionSecrets: extensions.broker } : {}),
          webDir: config.RETAINER_WEB_DIR,
          // The same origin /account issues OAuth tokens for, even in its own container.
          publicOrigin: accountsMode(config)
            ? accountsOrigin(config)
            : config.RETAINER_PUBLIC_ORIGIN,
          accountsSecret: config.RETAINER_AUTH_SECRET,
          rateLimit: { limit: rateLimitPerMinute(config) },
          clientIp: (c) => getConnInfo(c).remote.address,
          // Self-hosted serves the model proxy in this process (model calls spec 3.6).
          model: {
            apiKey: config.RETAINER_MODEL_API_KEY,
            upstream: config.RETAINER_MODEL_UPSTREAM_ORIGIN,
          },
          modelUsageSecret: config.RETAINER_MODEL_USAGE_SECRET,
        });
  const fetch = (request: Request, env: Record<string, unknown>) => {
    if (accounts) {
      const { pathname } = new URL(request.url);
      if (
        pathname === '/account' ||
        pathname.startsWith('/account/') ||
        pathname.startsWith('/.well-known/oauth-authorization-server')
      ) {
        return accounts.fetch(request, env);
      }
    }
    if (app) return app.fetch(request, env);
    return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
  };
  const server = serve({ fetch, port: config.PORT }, (info) => {
    log.info(`Retainer ${role} listening on http://localhost:${info.port}`);
  });
  stops.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  );
}

if (
  config.RETAINER_ROLE === 'worker' ||
  config.RETAINER_ROLE === 'all' ||
  config.RETAINER_ROLE === 'files'
) {
  const worker = await startWorker({
    sql: pool(createRuntimeSql(config, { max: config.RETAINER_DB_POOL_MAX })),
    intervalMinutes: config.RETAINER_CONSOLIDATE_INTERVAL_MINUTES,
  });
  stops.push(worker.stop);
  const executor = extensions.executor;
  if (executor) {
    // Continuous loop: a finished run frees its slot at once, so one long run never stalls dispatch.
    const running = executor.run({
      onError: () => log.error('Extension executor pass failed.'),
    });
    stops.push(async () => {
      executor.stop();
      await running;
    });
  }
}

if (extensions.fileMaintenance) {
  let running = Promise.resolve(),
    busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    running = (extensions.fileMaintenance as NonNullable<typeof extensions.fileMaintenance>)
      .tick()
      .then(() => {})
      .catch(() => log.error('File storage maintenance failed.'))
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(tick, 60000);
  tick();
  stops.push(async () => {
    clearInterval(timer);
    extensions.fileMaintenance?.stop();
    await running;
  });
}

if (extensions.changeMaintenance) {
  let running = Promise.resolve(),
    busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    running = (extensions.changeMaintenance as NonNullable<typeof extensions.changeMaintenance>)
      .tick()
      .then((result) => {
        if (result.failed) log.error('Change dispatch or retention remains pending.');
      })
      .catch(() => log.error('Change maintenance failed.'))
      .finally(() => {
        busy = false;
      });
  };
  const timer = setInterval(tick, 1000);
  tick();
  stops.push(async () => {
    clearInterval(timer);
    extensions.changeMaintenance?.stop();
    await running;
  });
}

async function shutdown(signal: string) {
  log.info(`${signal} received, shutting down.`);
  await Promise.allSettled(stops.map((stop) => stop()));
  await extensions.close();
  await Promise.allSettled(pools.map((sql) => sql.end({ timeout: 5 })));
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
