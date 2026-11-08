import type { Hono } from 'hono';
import { handle, type LambdaContext, type LambdaEvent } from 'hono/aws-lambda';
import { createAccountsServer } from '../accounts/index.js';
import { type Config, loadConfig } from '../config.js';
import { createControlSql, type Sql } from '../db/client.js';
import { setLogLevel } from '../log.js';
import { isPurgeEvent, type PurgeEvent } from '../worker/purge.js';
import { type PurgeReport, purgeDeletedWorkspaces } from '../workspaces/deletion.js';
import { withPassLock } from './deploy-lock.js';

/**
 * The control function (accounts spec 4.6): /account behind API Gateway,
 * with Better Auth and the control role's login. It is the only function
 * with a route to the internet, through a NAT gateway, because Google and
 * Microsoft sign-in need one. The api function never loads this code.
 *
 * EventBridge also invokes it with `{ "task": "purge-deleted-workspaces" }`
 * to remove deleted workspaces for good (4.5). That run holds the deploy
 * lock shared, like a consolidator pass, so a migration waits for it; the
 * pool `openPurgeSql` makes must have `max: 1` and keep its connection
 * (deploy-lock.ts). It is opened for each run and closed after, so a warm
 * instance that also serves /account holds only its two pools' connections.
 */
export function createControlHandler(
  config: Config,
  // One request at a time per instance, like the api function.
  sql: Sql = createControlSql(config, { max: config.RETAINER_DB_POOL_MAX }),
  authSql: Sql = createControlSql(config, { max: config.RETAINER_DB_POOL_MAX }),
  openPurgeSql: () => Sql = () => createControlSql(config, { max: 1, keepConnections: true }),
) {
  setLogLevel(config.LOG_LEVEL);
  const app = createAccountsServer({
    config,
    sql,
    authSql,
    // API Gateway's view of the caller; a header the client sent is ignored.
    clientIp: (c) =>
      (c.env as { event?: { requestContext?: { http?: { sourceIp?: string } } } }).event
        ?.requestContext?.http?.sourceIp,
  });
  const http = handle(app as unknown as Hono);
  function control(event: PurgeEvent, context?: LambdaContext): Promise<PurgeReport>;
  function control(event: LambdaEvent, context: LambdaContext): ReturnType<typeof http>;
  function control(event: LambdaEvent | PurgeEvent, context?: LambdaContext) {
    return isPurgeEvent(event) ? purge(openPurgeSql()) : http(event, context as LambdaContext);
  }
  return control;
}

async function purge(sql: Sql): Promise<PurgeReport> {
  const report = await withPassLock(sql, () => purgeDeletedWorkspaces(sql)).finally(() =>
    sql.end(),
  );
  // Fail the run so the function's error metric sees it; the rest were removed.
  if (report.failed > 0) {
    throw new Error(
      `Removing ${report.failed} deleted workspace(s) failed; ${report.purged} were removed.`,
    );
  }
  return report;
}

let cached: ReturnType<typeof createControlHandler> | undefined;

/** The Lambda entry point (`dist/lambda/control.handler`). */
export const handler = (event: LambdaEvent | PurgeEvent, context: LambdaContext) => {
  cached ??= createControlHandler(loadConfig());
  return isPurgeEvent(event) ? cached(event) : cached(event, context);
};
