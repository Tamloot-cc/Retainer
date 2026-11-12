import { type Config, loadConfig } from '../config.js';
import { createRuntimeSql, type Sql } from '../db/client.js';
import { extensionServices } from '../extension-control/configuration.js';
import type { ExtensionExecutor } from '../worker/extensions.js';
import { withPassLock } from './deploy-lock.js';

export const EXECUTOR_LEADER = 0x52544e07;
const DRAIN_BUDGET_MS = (300 + 15 + 30) * 1000;

/** Session pool must be max:1 with keepConnections, just like the deploy pass lock. */
export async function runExecutorLeader(
  lock: Sql,
  executor: ExtensionExecutor,
  claimWindowMs: number,
  options: { idleTimeoutMs?: number; idleMs?: number } = {},
) {
  const [leader] = await lock<{ acquired: boolean }[]>`
    select pg_try_advisory_lock(${EXECUTOR_LEADER}) as acquired`;
  if (!leader?.acquired) return { skipped: true };
  let held = true;
  const release = async () => {
    if (!held) return;
    held = false;
    const [result] = await lock<{ released: boolean }[]>`
      select pg_advisory_unlock(${EXECUTOR_LEADER}) as released`;
    if (!result?.released) throw new Error('Lost the executor leader lock during the pass');
  };
  if (claimWindowMs <= 0) {
    executor.drain();
    await release();
    return { skipped: false };
  }
  // Waiting for a migration also consumes the claim window. Never hold leadership until
  // Lambda's hard timeout while blocked on the shared deploy lock.
  const timer = setTimeout(() => executor.drain(), Math.max(0, claimWindowMs));
  let failure: unknown;
  try {
    await lock`select set_config('lock_timeout', ${`${Math.max(1, Math.floor(claimWindowMs))}ms`}, false)`;
    await withPassLock(lock, () =>
      executor.run({
        idleTimeoutMs: options.idleTimeoutMs ?? 15000,
        ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
        onClaimingStopped: release,
        onError: (error) => {
          failure ??= error;
          executor.drain();
        },
      }),
    );
    if (failure) throw failure;
    return { skipped: false };
  } finally {
    clearTimeout(timer);
    try {
      await lock`select set_config('lock_timeout', '0', false)`;
    } finally {
      await release();
    }
  }
}

/** Trusted coordinator; provider code executes in the operator-configured driver. */
export async function createExecutorHandler(config: Config) {
  const sql = createRuntimeSql(config, { max: config.RETAINER_EXECUTOR_CONCURRENCY });
  const lock = createRuntimeSql(config, { max: 1, keepConnections: true });
  let prepared: Awaited<ReturnType<typeof extensionServices>> | undefined;
  try {
    prepared = await extensionServices(config, { workerSql: sql });
    if (!prepared.executor) throw new Error('extension executor is not configured');
  } catch (error) {
    await prepared?.close();
    await Promise.all([sql.end({ timeout: 5 }), lock.end({ timeout: 5 })]);
    throw error;
  }
  let active: ExtensionExecutor | undefined;
  let busy = false;
  return Object.assign(
    async (context: { getRemainingTimeInMillis(): number }) => {
      if (busy) return { skipped: true };
      busy = true;
      let services: Awaited<ReturnType<typeof extensionServices>> | undefined;
      try {
        services = prepared ?? (await extensionServices(config, { workerSql: sql }));
        prepared = undefined;
        if (!services.executor) throw new Error('extension executor is not configured');
        const executor = services.executor;
        active = executor;
        if (config.RETAINER_EXTENSION_DRIVER !== 'lambda')
          return await withPassLock(lock, () => executor.tick(4));
        return await runExecutorLeader(
          lock,
          active,
          context.getRemainingTimeInMillis() - DRAIN_BUDGET_MS,
        );
      } finally {
        active = undefined;
        await services?.close();
        busy = false;
      }
    },
    {
      close: async () => {
        active?.stop();
        await prepared?.close();
        prepared = undefined;
        await Promise.all([sql.end({ timeout: 5 }), lock.end({ timeout: 5 })]);
      },
    },
  );
}

let cached: ReturnType<typeof createExecutorHandler> | undefined;
export async function handler(event: unknown, context: { getRemainingTimeInMillis(): number }) {
  if (
    !event ||
    typeof event !== 'object' ||
    (event as { task?: unknown }).task !== 'execute-extension-jobs'
  )
    throw new Error('invalid extension executor event');
  cached ??= createExecutorHandler(loadConfig());
  return (await cached)(context);
}
