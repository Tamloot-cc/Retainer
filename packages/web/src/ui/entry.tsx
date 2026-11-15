import type { LucideIcon } from 'lucide-react';
import { type ReactNode, type Ref, useLayoutEffect, useRef, useState } from 'react';
import { cn } from './core.js';
import { Button } from './index.js';

// Entries: the one list style under a record's tabs. Rows divided by a line,
// never a panel per row, so a record's memory reads as one column.

export function EntryList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="flex list-none flex-col divide-y divide-border">
      {children}
    </ul>
  );
}

/**
 * One row: an icon, a title with any badges beside it, the time at the far end,
 * then the body and a footer of who, where from and how. `actions` appear over
 * the time on hover or focus, so every row's time lines up; on a narrow screen,
 * where there is no hover, they stay beside it.
 */
export function Entry({
  icon: Icon,
  title,
  time,
  footer,
  actions,
  children,
}: {
  icon: LucideIcon;
  title?: ReactNode;
  time?: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="group/entry relative flex gap-3 py-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
        <Icon size={14} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
        {title || time || actions ? (
          <div className="flex min-h-7 min-w-0 items-start gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-0.5 [overflow-wrap:anywhere] *:min-w-0 *:max-w-full">
              {title}
            </div>
            {time ? (
              <span className="shrink-0 whitespace-nowrap py-1 text-xs tabular-nums text-muted-foreground">
                {time}
              </span>
            ) : null}
            {actions ? <EntryActions>{actions}</EntryActions> : null}
          </div>
        ) : null}
        {children}
        {footer ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 [overflow-wrap:anywhere] *:min-w-0 *:max-w-full">
            {footer}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function EntryActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1 transition-opacity md:pointer-events-none md:absolute md:right-0 md:top-2.5 md:bg-background md:pl-2 md:opacity-0 md:focus-within:pointer-events-auto md:focus-within:opacity-100 md:group-hover/entry:pointer-events-auto md:group-hover/entry:opacity-100">
      {children}
    </div>
  );
}

/**
 * Written text: line breaks kept, long words wrapped inside the row, and with
 * `clamp`, cut after a few lines with a way to read the rest.
 */
export function EntryText({ clamp, children }: { clamp?: 3 | 4; children: ReactNode }) {
  const text = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false),
    [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = text.current;
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [open]);
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5">
      <p
        ref={text}
        className={cn(
          'm-0 w-full whitespace-pre-line [overflow-wrap:anywhere]',
          !open && clamp === 3 && 'line-clamp-3',
          !open && clamp === 4 && 'line-clamp-4',
        )}
      >
        {children}
      </p>
      {clamp && (overflows || open) ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="rounded-sm text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

/** A person's name as a row's title. */
export function EntryName({ children }: { children: ReactNode }) {
  return <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{children}</span>;
}

/** A moment in a row: the date and time, with the year only when it isn't this one. */
export function EntryTime({ at, label }: { at: string; label?: string }) {
  const date = new Date(at);
  const text = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
  return (
    <time dateTime={at} title={label ? `${label} ${date.toLocaleString()}` : date.toLocaleString()}>
      {text}
    </time>
  );
}

/** A day's heading in a list that runs by day. */
export function EntryDay({ children }: { children: ReactNode }) {
  return <h4 className="pt-2 text-xs font-medium text-muted-foreground">{children}</h4>;
}

/** The box to add to a list, under it: the input, then a hint and the action. */
export function EntryComposer({
  input,
  hint,
  action,
}: {
  input: ReactNode;
  hint: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      {input}
      <div className="flex items-center justify-between gap-2">
        {hint}
        {action}
      </div>
    </div>
  );
}

/** A quote from a source, set apart from what is said about it. */
export function EntryQuote({ children }: { children: ReactNode }) {
  return (
    <blockquote className="m-0 border-l-2 border-primary/30 pl-2.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">
      {children}
    </blockquote>
  );
}

/** Placeholder rows while a tab's first page loads, the shape of what will come. */
export function EntryLoading({ label }: { label: string }) {
  return (
    <div role="status" className="flex flex-col divide-y divide-border">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((row) => (
        <div key={row} aria-hidden className="flex motion-safe:animate-pulse gap-3 py-3">
          <span className="h-7 w-7 shrink-0 rounded-full bg-muted" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
            <span className="h-3.5 w-2/5 rounded-sm bg-muted" />
            <span className="h-3.5 w-4/5 rounded-sm bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The next page of a tab's list, added to what is shown. */
export function LoadMore({
  loading,
  onClick,
  children = 'Load more',
}: {
  loading: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex justify-center pt-2">
      <Button size="small" variant="ghost" disabled={loading} onClick={onClick}>
        {loading ? 'Loading…' : children}
      </Button>
    </div>
  );
}

/**
 * What is under a row of `Tabs`. It is always tall enough to fill the screen
 * below them, so a short tab can't pull the row back down by shrinking the page
 * under it. 5.25rem is the height of the page's or sheet's header (3rem) and the
 * tab row (2.25rem).
 */
export function TabPanel({ ref, children }: { ref?: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <div ref={ref} className="flex min-h-[calc(100dvh-5.25rem)] min-w-0 flex-col gap-2 pt-1">
      {children}
    </div>
  );
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Keeps sticky tabs still when the tab changes. While they are stuck, the new
 * tab starts at its top, right under them, rather than wherever the last
 * tab's scroll position lands in it. While they aren't, nothing moves.
 */
export function useTabAnchor(tab: string) {
  const nav = useRef<HTMLElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const shown = useRef(tab);
  useLayoutEffect(() => {
    if (shown.current === tab) return;
    shown.current = tab;
    const row = nav.current,
      under = panel.current;
    if (!row || !under) return;
    const gap = under.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
    if (gap >= 0) return;
    const scroller = scrollParent(row);
    if (scroller) scroller.scrollTop += gap;
    else window.scrollBy(0, gap);
  }, [tab]);
  return { nav, panel };
}
