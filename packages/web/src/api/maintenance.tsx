import { isMaintenance, isMaintenanceRead, retryAfterMs, waitForRetry } from '@retainer/sdk';
import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

const messages = {
  writes: 'Saving is paused while Retainer updates. Your work is still here.',
  extensions: 'Extension operations are paused while Retainer updates.',
  reads: 'Some information is temporarily unavailable while Retainer updates.',
  all: 'Updating, back in a moment. Your work is still here.',
};
type Pause = keyof typeof messages;
const waiting = new Map<Pause, number>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Keep the original request pending and the React tree (including drafts) mounted. */
export async function updatingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let announced: Pause | undefined;
  try {
    for (;;) {
      init?.signal?.throwIfAborted();
      const response = await window.fetch(input, init);
      if (!(await isMaintenance(response))) return response;
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const path = new URL(input instanceof Request ? input.url : input, window.location.origin)
        .pathname;
      const read = isMaintenanceRead(method, path);
      if (!read && response.headers.get('x-retainer-maintenance') !== 'not-executed')
        return response;
      const operation = response.headers.get('x-retainer-paused-operation');
      // Session renewal is background work. An existing session can keep browsing.
      if (!announced && operation !== 'session-refresh') {
        announced =
          operation === 'writes' || operation === 'extensions' || operation === 'reads'
            ? operation
            : 'all';
        waiting.set(announced, (waiting.get(announced) ?? 0) + 1);
        notify();
      }
      const delay = retryAfterMs(response.headers.get('retry-after'));
      await response.body?.cancel();
      await waitForRetry(delay, init?.signal);
    }
  } finally {
    if (announced) {
      waiting.set(announced, (waiting.get(announced) ?? 1) - 1);
      notify();
    }
  }
}

export function UpdatingBanner() {
  const message = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => {
      for (const pause of ['all', 'writes', 'extensions', 'reads'] as const) {
        if (waiting.get(pause)) return messages[pause];
      }
      return '';
    },
  );
  // Mount the live region before dialogs open: modal aria-hiding preserves
  // it, and the portal keeps the banner above the dialog overlay.
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={
        message
          ? 'fixed inset-x-0 top-0 z-[100] bg-amber-100 p-3 text-center text-slate-900'
          : 'sr-only'
      }
    >
      {message}
    </div>,
    document.body,
  );
}
