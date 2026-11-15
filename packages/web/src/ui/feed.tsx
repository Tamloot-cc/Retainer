import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CategoryColor } from './colors.js';
import { cn, isPlainClick } from './core.js';

// A feed (5.2): things that happened, read by time rather than by column.

/** The feed's scrolling area inside a `fill` page: a readable column. */
export function FeedScroll({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-5 md:px-6">
        {children}
      </div>
    </div>
  );
}

/** One day of the feed, under a heading that stays in view while its items scroll. */
export function FeedDay({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section aria-label={heading} className="flex flex-col">
      <h2 className="sticky top-0 z-10 -mx-1 bg-background/90 px-1 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
        {heading}
      </h2>
      <ol className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
        {children}
      </ol>
    </section>
  );
}

/**
 * One item: an icon, a title that opens it, chips beside the title, the time,
 * two lines of summary, and a footer of links. A click anywhere on the row
 * that isn't on a link opens it too; the title is the keyboard path.
 */
export function FeedItem({
  icon: Icon,
  iconLabel,
  color,
  title,
  chips,
  time,
  summary,
  footer,
  selected = false,
  onOpen,
}: {
  icon: LucideIcon;
  /** What the icon stands for, e.g. the event type. */
  iconLabel: string;
  color?: CategoryColor;
  title: string;
  chips?: ReactNode;
  time: string;
  summary?: string | null;
  footer?: ReactNode;
  selected?: boolean;
  onOpen: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a pointer shortcut; the title button is the keyboard path.
    <li
      data-selected={selected || undefined}
      onClick={(e) => {
        if (isPlainClick(e)) onOpen();
      }}
      className="group flex cursor-pointer gap-3 px-3 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-hover data-selected:bg-selection"
    >
      <span
        role="img"
        aria-label={iconLabel}
        title={iconLabel}
        data-color={color}
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
          color ? 'category-tag' : 'border border-border bg-background text-muted-foreground',
        )}
      >
        <Icon size={14} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 truncate rounded-sm text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </button>
          {chips ? <span className="flex shrink-0 items-center gap-1">{chips}</span> : null}
          <time className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-muted-foreground">
            {time}
          </time>
        </div>
        {summary ? (
          <p className="line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {summary}
          </p>
        ) : null}
        {footer ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            {footer}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** A labeled group in a feed item's footer: "With Dana, Avi", "About Acme". */
export function FeedLinks({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </span>
  );
}
