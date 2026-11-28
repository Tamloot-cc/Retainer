import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from './core.js';

/** A heading counts as in view once this much of it shows, as in Fumadocs. */
const VISIBLE_RATIO = 0.9;
/** The sticky page header's height (`Page`'s `h-12`): a heading under it is not in view. */
const HEADER_HEIGHT = 48;

/**
 * Which sections the reader is looking at: every section whose heading is in
 * view or, when none is, the last one whose heading has scrolled above the
 * middle of the screen (`above`, measured only then); at the very top, the
 * first. Ported from Fumadocs' table of contents (fumadocs-core/toc, MIT).
 */
export function activeSections(
  ids: string[],
  visible: ReadonlySet<string>,
  above: () => string | undefined,
): string[] {
  const shown = ids.filter((id) => visible.has(id));
  if (shown.length) return shown;
  const last = above();
  return last ? [last] : ids.slice(0, 1);
}

/** The last heading above the middle of the screen, measured. */
function headingAbove(headings: string[]): string | undefined {
  const middle = (HEADER_HEIGHT + window.innerHeight) / 2;
  let found: string | undefined;
  for (const id of headings) {
    const rect = document.getElementById(id)?.getBoundingClientRect();
    if (!rect || rect.height === 0) continue;
    if (rect.top >= middle) break;
    found = id;
  }
  return found;
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Tracks the sections in view while the page scrolls. `headings` are the
 * element ids of each section's heading, in page order; `active` is the ids
 * of the ones in view. `select` marks one active straight away, for a click
 * that jumps to it.
 */
function useActiveSections(headings: string[]) {
  // A string, so a caller's new array with the same ids doesn't restart the observer.
  const key = headings.join(' ');
  const [active, setActive] = useState<string[]>(() => headings.slice(0, 1));
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const ids = key.split(' ');
    const seen = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio >= VISIBLE_RATIO) seen.add(entry.target.id);
          else seen.delete(entry.target.id);
        }
        const next = activeSections(ids, seen, () => headingAbove(ids));
        setActive((now) => (sameIds(now, next) ? now : next));
      },
      { threshold: VISIBLE_RATIO, rootMargin: `-${HEADER_HEIGHT}px 0px 0px 0px` },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [key]);
  return {
    active,
    select: (id: string) => setActive((now) => (now.includes(id) ? now : [id])),
  };
}

/**
 * A page's table of contents, like Fumadocs' "On this page": a sticky list
 * of the page's sections with a line beside it that lights up the ones in
 * view and slides as the page scrolls. Below `md` it is a scrolling strip of
 * the same items, the first one in view marked. Each item's `id` is its
 * section heading's element id; the scroll tracking lives here, so the page
 * around it doesn't render again as the reader scrolls.
 */
export function SectionNav({
  label,
  items,
  onSelect,
}: {
  /** The visible heading and the navigation's accessible name. */
  label: string;
  items: { id: string; label: string; meta?: ReactNode }[];
  /** Jumps to the section whose heading has this id. */
  onSelect: (id: string) => void;
}) {
  const { active, select } = useActiveSections(items.map((item) => item.id));
  const list = useRef<HTMLUListElement>(null);
  const [thumb, setThumb] = useState<{ top: number; height: number } | null>(null);
  const measure = useRef(() => {});
  measure.current = () => {
    const lit = list.current?.querySelectorAll<HTMLElement>('[data-active=true]');
    const first = lit?.[0];
    const last = lit?.[lit.length - 1];
    const next =
      first && last
        ? { top: first.offsetTop, height: last.offsetTop + last.offsetHeight - first.offsetTop }
        : null;
    setThumb((now) =>
      now && next && now.top === next.top && now.height === next.height ? now : next,
    );
  };
  // Size the lit part of the line to cover the active items, and again when the list resizes.
  useLayoutEffect(() => {
    const ul = list.current;
    if (!ul) return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(ul);
    return () => observer.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure again when the active items change
  useLayoutEffect(() => measure.current(), [active]);
  const current = active[0];
  return (
    <nav aria-label={label} className="flex flex-col gap-1.5">
      <p className="hidden text-[11px] font-medium text-muted-foreground md:block">{label}</p>
      <div className="relative">
        {/* The line, then its lit part. */}
        <div aria-hidden className="absolute inset-y-0 left-0 hidden w-px bg-border md:block" />
        {thumb ? (
          <div
            aria-hidden
            className="absolute left-0 hidden w-px bg-primary transition-[top,height] duration-200 ease-out motion-reduce:transition-none md:block"
            style={{ top: thumb.top, height: thumb.height }}
          />
        ) : null}
        <ul
          ref={list}
          className="-mx-4 flex list-none gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-col md:gap-0 md:overflow-visible md:px-0"
        >
          {items.map((item) => {
            const on = active.includes(item.id);
            return (
              <li key={item.id} data-active={on} className="shrink-0">
                <button
                  type="button"
                  aria-current={item.id === current ? 'location' : undefined}
                  onClick={() => {
                    select(item.id);
                    onSelect(item.id);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-left text-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 md:rounded-none md:border-0 md:py-1.5 md:pl-3.5 md:pr-0',
                    on ? 'text-foreground' : 'text-muted-foreground',
                    item.id === current && 'max-md:bg-selection max-md:font-medium',
                  )}
                >
                  <span className="truncate">{item.label}</span>
                  {item.meta !== undefined ? (
                    <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">
                      {item.meta}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
