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

/** 409 codes that a later attempt can resolve: optimistic-revision races and a replaced lease. */
const TRANSIENT_CONFLICTS = new Set([
  'revision_conflict',
  'scan_conflict',
  'source_revision_conflict',
  'lease_expired',
]);
/** Retainer API rate limits, outages, transient conflicts and lost connections are worth retrying. */
export function transient(error: unknown): unknown {
  if (isRetryLater(error)) return error;
  if (error instanceof RetainerApiError) {
    if (error.status === 429) return new RetryLater({ code: 'api_rate_limited' });
    if (error.status >= 500 || (error.status === 409 && TRANSIENT_CONFLICTS.has(error.code)))
      return new RetryLater({ code: 'api_unavailable' });
    return error;
  }
  // fetch reports a lost connection as this TypeError.
  if (error instanceof TypeError && error.message === 'fetch failed')
    return new RetryLater({ code: 'api_unavailable' });
  return error;
}
/**
 * The Retainer API client's fetch. A reply that is not JSON (a proxy or outage page) becomes
 * RetryLater here, so a handler's own parse errors stay terminal.
 */
export function apiFetch(transport: typeof fetch, signal: AbortSignal): typeof fetch {
  return async (url, init) => {
    const response = await transport(url, { ...init, signal });
    const text = await response.text();
    try {
      JSON.parse(text);
    } catch {
      throw new RetryLater({ code: 'api_unavailable' });
    }
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
export async function retryTransient<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw transient(error);
  }
}
