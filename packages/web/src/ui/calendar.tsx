import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CategoryColor } from './colors.js';
import { cn } from './core.js';
import { useDragItem, useDropTarget } from './drag.js';
import { ColorDot } from './identity.js';
import { Button } from './index.js';
import { PanelHeader, Popover } from './popover.js';

/** The bar over a month: its name, then previous, today and next. */
export function CalendarHeader({
  title,
  onPrevious,
  onNext,
  onToday,
  children,
}: {
  title: string;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  /** Notes at the end of the bar, e.g. records without a date. */
  children?: ReactNode;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
      <h2 className="min-w-0 truncate text-sm font-semibold" aria-live="polite">
        {title}
      </h2>
      <div className="flex shrink-0 items-center">
        <Button variant="ghost" size="iconSmall" aria-label="Previous month" onClick={onPrevious}>
          <ChevronLeft size={16} />
        </Button>
        <Button variant="ghost" size="small" onClick={onToday}>
          Today
        </Button>
        <Button variant="ghost" size="iconSmall" aria-label="Next month" onClick={onNext}>
          <ChevronRight size={16} />
        </Button>
      </div>
      {children ? (
        <div className="ml-auto flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A month as whole weeks under the names of the weekdays. Each day is a
 * heading with its records under it, so assistive technology moves day by
 * day by heading; the weekday row is for the eye only.
 */
export function MonthGrid({
  label,
  weekdays,
  children,
}: {
  label: string;
  /** Short names, from the first day of the week. */
  weekdays: string[];
  /** `CalendarDay`s, a week at a time. */
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div
        aria-hidden
        className="sticky top-0 z-10 grid shrink-0 grid-cols-7 border-b border-border bg-sidebar"
      >
        {weekdays.map((d) => (
          <div key={d} className="truncate px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {d}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-[minmax(7rem,1fr)] grid-cols-7">{children}</div>
    </section>
  );
}

/**
 * One day: its number (marked when it is today), its records and a "more"
 * control. Days outside the month are dimmed. A drop target unless `locked`.
 */
export function CalendarDay({
  id,
  label,
  day,
  outside = false,
  today = false,
  locked = false,
  children,
  more,
}: {
  id: string;
  /** The full date, read by assistive technology. */
  label: string;
  day: number;
  outside?: boolean;
  today?: boolean;
  locked?: boolean;
  children?: ReactNode;
  more?: ReactNode;
}) {
  const drop = useDropTarget(id, locked);
  return (
    <div
      ref={drop.ref}
      data-outside={outside || undefined}
      data-over={drop.isOver || undefined}
      className="flex min-w-0 flex-col gap-0.5 overflow-hidden border-b border-r border-border p-1 transition-colors nth-[7n]:border-r-0 data-outside:bg-muted/40 data-over:bg-primary/8"
    >
      <h3 className="sr-only" aria-current={today ? 'date' : undefined}>
        {today ? `${label}, today` : label}
      </h3>
      <span
        aria-hidden
        className={cn(
          'mb-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center self-end rounded-full px-1 text-xs tabular-nums',
          today
            ? 'bg-primary font-semibold text-primary-foreground'
            : outside
              ? 'text-muted-foreground/60'
              : 'text-muted-foreground',
        )}
      >
        {day}
      </span>
      {children}
      {more}
    </div>
  );
}

const ENTRY =
  'flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-sm border border-border bg-card px-1.5 text-left text-xs';

function EntryBody({
  title,
  time,
  category,
}: {
  title: string;
  time?: string;
  category?: { color: CategoryColor; label: string };
}) {
  return (
    <>
      {category ? <ColorDot color={category.color} label={category.label} /> : null}
      {time ? <span className="shrink-0 tabular-nums text-muted-foreground">{time}</span> : null}
      <span className="min-w-0 truncate font-medium">{title}</span>
    </>
  );
}

/** The same identity is announced on focus and during keyboard moves. */
export function calendarEntryLabel(title: string, time?: string, category?: string) {
  return [title, time, category].filter(Boolean).join(', ');
}

/**
 * A record on a day. Click or Enter opens it; with `draggable`, Space picks
 * it up to move to another day.
 */
export function CalendarEntry({
  id,
  day,
  item,
  title,
  time,
  category,
  draggable,
  selected = false,
  pending = false,
  inPanel = false,
  recordId,
  onOpen,
}: {
  /** Unique among everything draggable on the calendar. */
  id: string;
  /** The record's ID; `id` differs from it in a day's "more" panel. */
  recordId: string;
  day: string;
  /** What `DragArea` hands back when this is moved. */
  item: unknown;
  title: string;
  time?: string;
  category?: { color: CategoryColor; label: string };
  draggable: boolean;
  selected?: boolean;
  pending?: boolean;
  /** In a day's "more" panel: opening the record closes the panel. */
  inPanel?: boolean;
  onOpen: () => void;
}) {
  const drag = useDragItem(id, day, item, !draggable);
  // A native button: Enter clicks it (opening the record). While it is being
  // dragged from the keyboard, the drag consumes Space and Enter instead.
  const entry = (
    <button
      ref={drag.ref}
      type="button"
      {...drag.handle}
      aria-label={calendarEntryLabel(title, time, category?.label)}
      aria-current={selected || undefined}
      data-record-sheet-trigger={inPanel ? undefined : recordId}
      data-row={recordId}
      data-pending={pending || undefined}
      data-dragging={drag.isDragging || undefined}
      onClick={onOpen}
      className={cn(
        ENTRY,
        'w-full transition-[border-color,opacity] hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current]:bg-selection aria-[current]:border-primary aria-[current]:ring-1 aria-[current]:ring-primary data-dragging:opacity-40 data-pending:opacity-60',
        draggable && 'touch-manipulation',
      )}
    >
      <EntryBody title={title} time={time} category={category} />
    </button>
  );
  return inPanel ? <PopoverPrimitive.Close asChild>{entry}</PopoverPrimitive.Close> : entry;
}

/** The entry under the pointer while it is dragged. */
export function EntryPreview({
  title,
  time,
  category,
}: {
  title: string;
  time?: string;
  category?: { color: CategoryColor; label: string };
}) {
  return (
    <div className={cn(ENTRY, 'w-40 cursor-grabbing shadow-lg ring-1 ring-primary/40')}>
      <EntryBody title={title} time={time} category={category} />
    </div>
  );
}

/** "3 more": the rest of a busy day's records in a panel. */
export function MoreEntries({
  title,
  hiddenRecordIds,
  children,
}: {
  /** The day, as the panel's heading. */
  title: string;
  hiddenRecordIds: string[];
  children: ReactNode;
}) {
  return (
    <Popover
      label={title}
      trigger={
        <button
          type="button"
          data-record-sheet-trigger={hiddenRecordIds.join(' ')}
          className="h-5 shrink-0 rounded-sm px-1.5 text-left text-xs text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {hiddenRecordIds.length} more
        </button>
      }
    >
      <PanelHeader title={title} />
      <div className="flex flex-col gap-1 overflow-y-auto p-2">{children}</div>
    </Popover>
  );
}
