import {
  type ExecutionResult,
  isRetryLater,
  RetryLater,
  retryLaterResult,
} from '@retainer/extension';
import { RetainerApiError } from '@retainer/sdk';

/**
 * Turns a handler's outcome into a protocol result. Retry is opt-in: a handler retries by
 * returning `retry` or throwing RetryLater. Any other exception is a terminal failure, except
 * when the deadline aborted the run, which the platform retries as `execution_timeout`.
 */
export async function settle(
  run: () => Promise<ExecutionResult>,
  signal: AbortSignal,
): Promise<ExecutionResult> {
  try {
    const result = await run();
    // A handler that swallowed its own abort did not fail on its merits.
    if (signal.aborted && result.status !== 'succeeded')
      return { status: 'retry', code: 'execution_timeout' };
    return result;
  } catch (error) {
    if (signal.aborted) return { status: 'retry', code: 'execution_timeout' };
    if (isRetryLater(error)) return retryLaterResult(error);
    return { status: 'failed', code: 'handler_failed' };
  }
}

/** Retainer API conflicts, rate limits and outages, and lost connections, are worth retrying. */
export function transient(error: unknown): unknown {
  if (isRetryLater(error)) return error;
  if (error instanceof RetainerApiError) {
    if (error.status === 429) return new RetryLater({ code: 'api_rate_limited' });
    if (error.status === 409 || error.status >= 500)
      return new RetryLater({ code: 'api_unavailable' });
    return error;
  }
  // fetch reports a lost connection as this TypeError; a non-JSON reply is a proxy or outage page.
  if (
    (error instanceof TypeError && error.message === 'fetch failed') ||
    error instanceof SyntaxError
  )
    return new RetryLater({ code: 'api_unavailable' });
  return error;
}
export async function retryTransient<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw transient(error);
  }
}
