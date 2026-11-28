import type { SavedView } from '@retainer/shared';
import { useEffect, useState } from 'react';
import type { ViewSearch } from '../state.js';

/** Remembers the view last shown for an object; `''` for all records. */
const lastViewKey = (workspace: string, object: string) =>
  `retainer:view:v1:${workspace}:${object}`;

export function rememberView(workspace: string, object: string, id: string | undefined) {
  try {
    localStorage.setItem(lastViewKey(workspace, object), id ?? '');
  } catch {
    /* Not remembering is fine. */
  }
}

/**
 * Opening an object without `?view=` (from the sidebar, say) shows the view
 * last shown here, if it still exists. Only once per visit, and never over
 * an address that has its own filter or sort.
 */
export function useLastView(
  workspace: string,
  object: string,
  search: ViewSearch,
  views: SavedView[] | undefined,
  select: (id: string | undefined, options: { replace?: boolean }) => void,
): boolean {
  const [last] = useState(() => {
    if (search.view || search.draft || search.filter || search.sort) return '';
    try {
      return localStorage.getItem(lastViewKey(workspace, object)) ?? '';
    } catch {
      return '';
    }
  });
  const [done, setDone] = useState(!last);
  useEffect(() => {
    if (done || !views) return;
    setDone(true);
    if (!search.view && !search.draft && views.some((v) => v.id === last))
      select(last, { replace: true });
  }, [done, views, last, search.view, search.draft, select]);
  // True until it knows whether to switch, so all records don't flash first.
  return !done;
}
