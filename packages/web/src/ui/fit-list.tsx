import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { cn } from './core.js';

export type FitItem = {
  /** Identifies the item and changes when what it shows does, e.g. id and name. */
  key: string;
  node: ReactNode;
};

/**
 * How many items fit in `available` pixels, `gap` apart, with a count of the
 * rest after them. At least one shows, cut short if even it is too wide.
 */
export function fitCount(
  widths: readonly number[],
  available: number,
  { gap, more, extra = 0 }: { gap: number; more: number; extra?: number },
): number {
  let used = 0;
  let fits = 0;
  for (let n = 1; n <= widths.length; n++) {
    used += (widths[n - 1] ?? 0) + (n > 1 ? gap : 0);
    const hidden = widths.length - n + extra;
    const need = used + (hidden > 0 ? gap + more : 0);
    if (need <= available) fits = n;
  }
  return Math.max(Math.min(1, widths.length), fits);
}

/**
 * One line of items in a table cell: as many as the column's width holds,
 * then "+n" for the rest. Widening the column shows more and lowers the
 * count; `extra` adds items that are counted but never shown. Until the
 * cell has a width (it is hidden, or not laid out), `fallback` items show.
 */
export function FitList({
  items,
  extra = 0,
  fallback = 2,
  more,
}: {
  items: FitItem[];
  extra?: number;
  fallback?: number;
  /** The count of items not shown, e.g. a "+n" badge. */
  more: (n: number) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const signature = items.map((i) => i.key).join('\u0000');
  // Natural widths, read while every item and the widest count are shown.
  const measured = useRef<{
    signature: string;
    widths: number[];
    more: number;
    gap: number;
  } | null>(null);
  const [state, setState] = useState<{ signature: string; shown: number | null }>({
    signature,
    shown: null,
  });
  const measuring = state.signature !== signature || state.shown === null;

  const refit = useCallback(() => {
    const el = box.current;
    const m = measured.current;
    if (!el || !m) return;
    const available = el.clientWidth;
    const shown =
      available > 0
        ? fitCount(m.widths, available, { gap: m.gap, more: m.more, extra })
        : Math.min(items.length, fallback);
    setState((s) =>
      s.signature === m.signature && s.shown === shown ? s : { signature: m.signature, shown },
    );
  }, [extra, fallback, items.length]);

  useLayoutEffect(() => {
    if (!measuring || !box.current) return;
    const children = Array.from(box.current.children) as HTMLElement[];
    const widths = children
      .filter((c) => c.dataset.fitItem !== undefined)
      .map((c) => c.getBoundingClientRect().width);
    const moreEl = children.find((c) => c.dataset.fitMore !== undefined);
    measured.current = {
      signature,
      widths,
      more: moreEl?.getBoundingClientRect().width ?? 0,
      gap: Number.parseFloat(getComputedStyle(box.current).columnGap) || 0,
    };
    refit();
  });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => refit());
    observer.observe(el);
    return () => observer.disconnect();
  }, [refit]);

  const shown = measuring ? items.length : (state.shown ?? items.length);
  const hidden = items.length - shown + extra;
  return (
    <div
      ref={box}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap',
        measuring && 'invisible',
      )}
    >
      {items.slice(0, shown).map((item, i) => (
        <span
          key={item.key}
          data-fit-item=""
          className={cn(
            'flex items-center',
            // The last one shown gives way when even it doesn't fit.
            !measuring && i === shown - 1 ? 'min-w-0 shrink overflow-hidden' : 'shrink-0',
          )}
        >
          {item.node}
        </span>
      ))}
      {measuring && items.length + extra > 0 ? (
        // The widest count there can be, for its width.
        <span data-fit-more="" aria-hidden className="shrink-0">
          {more(items.length + extra)}
        </span>
      ) : hidden > 0 ? (
        <span className="shrink-0">{more(hidden)}</span>
      ) : null}
    </div>
  );
}
