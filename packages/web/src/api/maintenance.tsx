import { isMaintenance, retryAfterMs, waitForRetry } from '@retainer/sdk';
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

let waiting = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Keep the original request pending and the React tree (including drafts) mounted. */
export async function updatingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let announced = false;
  try {
    for (;;) {
      init?.signal?.throwIfAborted();
      const response = await window.fetch(input, init);
      if (!(await isMaintenance(response))) return response;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const path = new URL(input instanceof Request ? input.url : input, window.location.origin)
        .pathname;
      const read =
        ['GET', 'HEAD'].includes(method) ||
        (method === 'POST' && /\/(query|aggregate|delete-impact|search)$/.test(path));
      if (!read && response.headers.get('x-retainer-maintenance') !== 'not-executed')
        return response;
      if (!announced) {
        announced = true;
        waiting++;
        notify();
      }
      const delay = retryAfterMs(response.headers.get('retry-after'));
      await response.body?.cancel();
      await waitForRetry(delay, init?.signal);
    }
  } finally {
    if (announced) {
      waiting--;
      notify();
    }
  }
}

export function UpdatingBanner() {
  const active = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => waiting > 0,
  );
  // Mount the live region before dialogs open: modal aria-hiding preserves
  // it, and the portal keeps the banner above the dialog overlay.
  return createPortal(
    <div aria-live="polite" className="fixed inset-x-0 top-0 z-[100]">
      {active ? (
        <div role="status" className="bg-amber-100 p-3 text-center text-slate-900">
          Updating, back in a moment. Your work is still here.
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
