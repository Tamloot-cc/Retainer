import { type Config, loadConfig } from '../config.js';
import { createRuntimeSql, type Sql } from '../db/client.js';
import { setLogLevel } from '../log.js';
import { type ConsolidatePass, consolidateDue } from '../worker/index.js';
import { withPassLock } from './deploy-lock.js';
import { withWriterInvocation } from './writer-admission.js';

/**
 * The consolidator (4.2) as a scheduled AWS Lambda function: each run is one
 * pass over the workspaces that are due, the same pass the long-running
 * worker makes on its timer. A schedule more frequent than
 * RETAINER_CONSOLIDATE_INTERVAL_MINUTES is fine: a workspace run within the
 * interval is not due, and one another run holds is skipped.
 *
 * Each pass holds the deploy lock shared, so a migration waits for it.
 * `sql` must have `max: 1` and keep its connection (see deploy-lock.ts).
 */
export function createConsolidateHandler(
  config: Config,
  sql: Sql = createRuntimeSql(config, { max: 1, keepConnections: true }),
) {
  setLogLevel(config.LOG_LEVEL);
  return async (): Promise<ConsolidatePass> => {
    const pass = await withPassLock(sql, () =>
      consolidateDue({
        sql,
        intervalMinutes: config.RETAINER_CONSOLIDATE_INTERVAL_MINUTES,
      }),
    );
    // A failed workspace fails the run, so the function's error metric (and
    // any alarm on it) sees it; the others were still consolidated.
    if (pass.failed > 0) {
      throw new Error(
        `Consolidating ${pass.failed} workspace(s) failed; ${pass.consolidated} succeeded.`,
      );
    }
    return pass;
  };
}

let cached: ReturnType<typeof createConsolidateHandler> | undefined;

/** The Lambda entry point (`dist/lambda/consolidate.handler`). */
export const handler = (_event: unknown, context: { getRemainingTimeInMillis(): number }) =>
  withWriterInvocation(context, () => {
    cached ??= createConsolidateHandler(loadConfig());
    return cached();
  });
