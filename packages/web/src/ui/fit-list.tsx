import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Badge, cn } from './core.js';

export type FitItem = {
  /** Identifies the item and changes when what it shows does, e.g. id and name. */
  key: string;
  node: ReactNode;
};

/** Items shown while the cell has no width yet (hidden, or not laid out). */
const UNMEASURED_SHOWN = 2;

/**
 * How many items fit in `available` pixels, `gap` apart, with a count of
 * the rest (`more` pixels wide) after them. At least one shows, cut short
 * if even it is too wide.
 */
export function fitCount(
  widths: readonly number[],
  available: number,
  { gap, more }: { gap: number; more: number },
): number {
  let used = 0;
  let fits = 0;
  for (let n = 1; n <= widths.length; n++) {
    used += (widths[n - 1] ?? 0) + (n > 1 ? gap : 0);
    const need = used + (n < widths.length ? gap + more : 0);
    if (need <= available) fits = n;
  }
  return Math.max(Math.min(1, widths.length), fits);
}

/**
 * One line of items in a table cell: as many as the column's width holds,
 * then "+n" for the rest. Widening the column shows more and lowers the
 * count.
 */
export function FitList({
  items,
  more = (n) => <Badge>+{n}</Badge>,
}: {
  items: FitItem[];
  /** The count of items not shown. */
  more?: (n: number) => ReactNode;
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
  const [fitted, setFitted] = useState<{ signature: string; shown: number } | null>(null);
  const shown = fitted?.signature === signature ? fitted.shown : null;

  const refit = useCallback(() => {
    const el = box.current;
    const m = measured.current;
    if (!el || !m) return;
    const available = el.clientWidth;
    const next =
      available > 0
        ? fitCount(m.widths, available, m)
        : Math.min(m.widths.length, UNMEASURED_SHOWN);
    setFitted((s) =>
      s?.signature === m.signature && s.shown === next
        ? s
        : { signature: m.signature, shown: next },
    );
  }, []);

  useLayoutEffect(() => {
    if (shown !== null || !box.current) return;
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
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [refit]);

  const measuring = shown === null;
  const count = shown ?? items.length;
  return (
    <div
      ref={box}
      className={cn(
        'flex w-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap',
        measuring && 'invisible',
      )}
    >
      {items.slice(0, count).map((item, i) => (
        <span
          key={item.key}
          data-fit-item=""
          className={cn(
            'flex items-center',
            // The last one shown gives way when even it doesn't fit: it and its
            // content may shrink, and the item cuts its own text short with "…".
            !measuring && i === count - 1
              ? 'min-w-0 shrink overflow-hidden [&>*]:min-w-0'
              : 'shrink-0',
          )}
        >
          {item.node}
        </span>
      ))}
      {measuring && items.length > 1 ? (
        // The widest count there can be, for its width.
        <span data-fit-more="" aria-hidden className="shrink-0">
          {more(items.length - 1)}
        </span>
      ) : items.length > count ? (
        <span className="shrink-0">{more(items.length - count)}</span>
      ) : null}
    </div>
  );
}
