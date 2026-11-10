/** Only a deliberate maintenance response is retryable; never a generic 503. */
export async function isMaintenance(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: { code?: string } } | null;
  return body?.error?.code === 'maintenance';
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (value !== null && /^\d+$/.test(value)) return Math.max(100, Number(value) * 1000);
  const date = value === null ? NaN : Date.parse(value);
  return Number.isFinite(date) ? Math.max(100, date - now) : 5000;
}

export function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Bounded SDK retries, with replay of the same body and idempotency key. */
export async function maintenanceFetch(
  fetcher: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher(input, init);
    if (attempt >= 12 || !(await isMaintenance(response))) return response;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const path = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    const read =
      ['GET', 'HEAD'].includes(method) ||
      (method === 'POST' && /\/(query|aggregate|delete-impact|search)$/.test(path));
    // The maintenance handler never forwards to application code. Without
    // that guarantee only reads and server-supported keyed writes retry.
    const keyed =
      new Headers(init?.headers).has('idempotency-key') &&
      (/^\/v1\/objects\/[^/]+\/records$/.test(path) ||
        /^\/v1\/records\/[^/]+\/(merge|comments|facts)$/.test(path) ||
        /^\/v1\/comments\/[^/]+$/.test(path));
    if (!read && !keyed && response.headers.get('x-retainer-maintenance') !== 'not-executed')
      return response;
    const delay = retryAfterMs(response.headers.get('retry-after'));
    if (Date.now() + delay > deadline) return response;
    await response.body?.cancel();
    await waitForRetry(delay, init?.signal);
  }
}
