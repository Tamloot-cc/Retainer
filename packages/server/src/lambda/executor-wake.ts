import { invokeEvent, type LambdaEventInvoke } from '../agent-sessions/dispatch.js';
import { log } from '../log.js';

/** How long a request waits on the wake before it answers anyway. */
const WAKE_WAIT_MS = 2000;
/**
 * A woken pass polls for routine runs every second and stays up for 15 idle
 * seconds, so wakes this close together reach the same pass: skipping them
 * keeps a burst of presses from throttling the executor's few slots.
 */
const WAKE_EVERY_MS = 3000;

/**
 * Wakes the hosted executor after the API queues a routine run (Retainer#147).
 * Its pass runs on a one-minute schedule and goes idle after a few quiet
 * seconds, so without this a pressed button waited up to a minute.
 *
 * The invoke is asynchronous and carries the scheduled event: a pass already
 * running holds the leader lock and polls for routine runs every second, so a
 * woken pass that finds it simply returns. The minute schedule stays the
 * fallback, so a failed wake only costs the old delay; it is logged, never
 * thrown, and the request waits on it at most two seconds.
 */
export function executorWake(
  functionName: string,
  invoke: LambdaEventInvoke = invokeEvent,
  { waitMs = WAKE_WAIT_MS, everyMs = WAKE_EVERY_MS, now = Date.now } = {},
): () => Promise<void> {
  const payload = new TextEncoder().encode(JSON.stringify({ task: 'execute-extension-jobs' }));
  let last = Number.NEGATIVE_INFINITY;
  return async () => {
    if (now() - last < everyMs) return;
    last = now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const status = await Promise.race([
        invoke(functionName, payload),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), waitMs);
        }),
      ]);
      if (status !== 202)
        log.warn(
          `Waking the routine executor answered ${status}; the next scheduled pass runs it.`,
        );
    } catch (error) {
      log.warn(
        `Waking the routine executor failed (${error instanceof Error ? error.message : String(error)}); the next scheduled pass runs it.`,
      );
    } finally {
      clearTimeout(timer);
    }
  };
}
