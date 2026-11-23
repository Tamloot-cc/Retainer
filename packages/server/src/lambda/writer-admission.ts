import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';
import { type Config, loadConfig } from '../config.js';
import { createControlSql, createRuntimeSql, type Sql } from '../db/client.js';
import { HOSTED_WRITER_BUILD } from '../db/writer-build.js';
import {
  acquireWriterLease,
  settleWriterLease,
  WriterAdmissionDenied,
} from '../db/writer-lease.js';
import { createMaintenanceHandler } from './maintenance.js';

type Deadline = { getRemainingTimeInMillis(): number };

let pool: Sql | undefined;
function admissionPool(config: Config) {
  // One Lambda invocation per environment. Leases hold no open transaction.
  const createPool = config.RETAINER_RUNTIME_DATABASE_URL ? createRuntimeSql : createControlSql;
  pool ??= createPool(config, { max: 1, statementTimeoutMs: 2500 });
  return pool;
}

/** Called before handler initialization and every invocation. No admission is inferred from a warm pool. */
export async function withWriterInvocation<T>(
  context: Deadline,
  work: () => T | Promise<T>,
  config = loadConfig(),
): Promise<T> {
  if (!HOSTED_WRITER_BUILD) return work();
  const sql = admissionPool(config);
  const remaining = Math.ceil(context.getRemainingTimeInMillis());
  if (remaining < 1) throw new WriterAdmissionDenied();
  // Time is taken from Lambda's deadline. Keep an extra ten seconds for teardown.
  const id = await acquireWriterLease(sql, remaining + 10_000);
  try {
    return await work();
  } finally {
    // A failed cleanup remains visible to the deployer until the hard deadline.
    await settleWriterLease(sql, id);
  }
}

export async function withHttpWriter<T>(
  event: LambdaEvent,
  context: LambdaContext,
  work: () => T | Promise<T>,
) {
  const config = loadConfig();
  // Only a denial before the callback can promise the request did not execute.
  let invoked = false;
  try {
    return await withWriterInvocation(
      context,
      () => {
        invoked = true;
        return work();
      },
      config,
    );
  } catch (error) {
    if (invoked || !(error instanceof WriterAdmissionDenied)) throw error;
    return createMaintenanceHandler(config.RETAINER_EDGE_SECRET)(event, context);
  }
}
