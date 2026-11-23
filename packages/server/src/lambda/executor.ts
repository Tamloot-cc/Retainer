import { setTimeout as delay } from 'node:timers/promises';
import { ROUTINE_LIMITS } from '@retainer/shared';
import { type Config, loadConfig } from '../config.js';
import { createRuntimeSql, type Sql } from '../db/client.js';
import { extensionServices } from '../extension-control/configuration.js';
import { RUN_GRACE_SECONDS } from '../routines/runs.js';
import type { ExtensionExecutor } from '../worker/extensions.js';
import type { RoutineExecutor } from '../worker/routines.js';
import { withPassLock } from './deploy-lock.js';
import { withWriterInvocation } from './writer-admission.js';

export const EXECUTOR_LEADER = 0x52544e07;
const DRAIN_BUDGET_MS = (300 + 15 + 30) * 1000;

/** Session pool must be max:1 with keepConnections, just like the deploy pass lock. */
export async function runExecutorLeader(
  lock: Sql,
  executor: ExtensionExecutor,
  claimWindowMs: number,
  options: {
    idleTimeoutMs?: number;
    idleMs?: number;
    routines?: Pick<RoutineExecutor, 'tick' | 'stop'>;
  } = {},
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
  const routines = options.routines;
  const routineWindow =
    Date.now() + claimWindowMs - (ROUTINE_LIMITS.maxRunSeconds + RUN_GRACE_SECONDS) * 1000;
  const routinePolling = new AbortController();
  const stopRoutinePolling = () => {
    routinePolling.abort();
    routines?.stop();
  };
  let checkingRoutines = false;
  let failure: unknown;
  const report = (error: unknown) => {
    failure ??= error;
    stopRoutinePolling();
    executor.drain();
  };
  try {
    await lock`select set_config('lock_timeout', ${`${Math.max(1, Math.floor(claimWindowMs))}ms`}, false)`;
    await withPassLock(lock, async () => {
      const pollRoutines = async () => {
        if (!routines) return;
        // Stop claiming routines early so their tool jobs still get serviced during drain.
        while (!routinePolling.signal.aborted && Date.now() < routineWindow) {
          checkingRoutines = true;
          try {
            await routines.tick(4, routineWindow);
          } finally {
            checkingRoutines = false;
          }
          if (!routinePolling.signal.aborted)
            await delay(options.idleMs ?? 1000, undefined, { signal: routinePolling.signal });
        }
      };
      const routineWork = pollRoutines().catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        report(error);
      });
      try {
        await executor.run({
          idleTimeoutMs: options.idleTimeoutMs ?? 15000,
          ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
          hasDependentWork: () => checkingRoutines,
          onClaimingStopped: async () => {
            stopRoutinePolling();
            await release();
          },
          onError: report,
        });
      } finally {
        stopRoutinePolling();
        await routineWork;
      }
    });
    if (failure) throw failure;
    return { skipped: false };
  } finally {
    stopRoutinePolling();
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
  let activeRoutines: RoutineExecutor | undefined;
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
        activeRoutines = services.routineExecutor;
        if (config.RETAINER_EXTENSION_DRIVER !== 'lambda')
          return await withPassLock(lock, async () => {
            const [extensions, routines] = await Promise.allSettled([
              executor.tick(4),
              activeRoutines?.tick(4),
            ]);
            if (extensions.status === 'rejected') throw extensions.reason;
            if (routines.status === 'rejected') throw routines.reason;
            return extensions.value;
          });
        return await runExecutorLeader(
          lock,
          active,
          context.getRemainingTimeInMillis() - DRAIN_BUDGET_MS,
          activeRoutines ? { routines: activeRoutines } : {},
        );
      } finally {
        active = undefined;
        activeRoutines = undefined;
        await services?.close();
        busy = false;
      }
    },
    {
      close: async () => {
        active?.stop();
        activeRoutines?.stop();
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
  return withWriterInvocation(context, async () => {
    cached ??= createExecutorHandler(loadConfig());
    return (await cached)(context);
  });
}
