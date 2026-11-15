import type { KeyboardEvent, ReactNode } from 'react';
import type { CategoryColor } from './colors.js';
import { cn, isPlainClick } from './core.js';
import { useDragItem, useDropTarget } from './drag.js';
import { ColorDot } from './identity.js';
import { Button } from './index.js';

export type CardField = { name: string; label: string; value: ReactNode };

/** Columns side by side that scroll sideways; each column scrolls on its own. */
export function Board({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: lets keyboard users scroll a wide board.
      tabIndex={0}
      className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto overflow-y-hidden bg-sidebar/60 p-3 focus-visible:outline-none md:px-5"
    >
      {children}
    </section>
  );
}

/**
 * One column: its name, how many records it holds and what its header
 * computes (`meta`), then its cards. It is a drop target unless `locked`.
 */
export function BoardColumn({
  id,
  title,
  color,
  count,
  meta,
  locked = false,
  children,
  footer,
}: {
  id: string;
  title: string;
  color?: CategoryColor;
  count?: number;
  meta?: ReactNode;
  locked?: boolean;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const drop = useDropTarget(id, locked);
  return (
    <section
      ref={drop.ref}
      aria-label={count === undefined ? title : `${title}, ${count}`}
      data-over={drop.isOver || undefined}
      className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/50 transition-colors data-over:border-primary/60 data-over:bg-primary/5"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 px-3">
        <ColorDot color={color} />
        <h2 className="truncate text-sm font-medium">{title}</h2>
        {count !== undefined ? (
          <span className="shrink-0 rounded-sm bg-card px-1.5 text-xs tabular-nums text-muted-foreground">
            {count.toLocaleString()}
          </span>
        ) : null}
        {meta ? (
          <span className="ml-auto min-w-0 truncate text-xs tabular-nums text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </header>
      <div className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {children}
        {footer}
      </div>
    </section>
  );
}

/** What an empty column says. */
export function ColumnNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/** "Show more" under a column's cards. */
export function ColumnMore({
  onClick,
  loading = false,
  children,
}: {
  onClick: () => void;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="small" disabled={loading} onClick={onClick}>
      {children}
    </Button>
  );
}

const CARD = 'flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 text-left text-sm';

function CardBody({ title, fields }: { title: string; fields: CardField[] }) {
  return (
    <>
      <span className="truncate font-medium">{title}</span>
      {fields.length ? (
        <dl className="flex flex-col gap-1">
          {fields.map((f) => (
            <div key={f.name} className="flex min-w-0 items-center gap-2 text-xs">
              <dt className="w-20 shrink-0 truncate text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0 flex-1 truncate">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}

/**
 * A record on a board. Click or Enter opens it; with `draggable`, Space
 * picks it up to move to another column. `pending` while a move is saving.
 */
export function BoardCard({
  id,
  column,
  item,
  title,
  fields,
  draggable,
  selected = false,
  pending = false,
  onOpen,
}: {
  id: string;
  column: string;
  /** What `DragArea` hands back when this is moved. */
  item: unknown;
  title: string;
  fields: CardField[];
  draggable: boolean;
  selected?: boolean;
  pending?: boolean;
  onOpen: () => void;
}) {
  const drag = useDragItem(id, column, item, !draggable);
  const handle = drag.handle as { onKeyDown?: (e: KeyboardEvent) => void };
  // Without drag attributes the card is still a control that opens the record.
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card's values can hold relation links and tooltips, which a native button cannot contain.
    <div
      ref={drag.ref}
      {...drag.handle}
      role="button"
      tabIndex={0}
      aria-label={title}
      aria-current={selected || undefined}
      data-pending={pending || undefined}
      data-dragging={drag.isDragging || undefined}
      onClick={(e) => {
        if (isPlainClick(e)) onOpen();
      }}
      onKeyDown={(e) => {
        handle.onKeyDown?.(e);
        // Enter on the card itself, not on a link inside it.
        if (
          e.key === 'Enter' &&
          e.target === e.currentTarget &&
          !drag.isDragging &&
          !e.defaultPrevented
        )
          onOpen();
      }}
      className={cn(
        CARD,
        'cursor-pointer transition-[border-color,opacity] hover:border-muted-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current]:bg-selection aria-[current]:border-primary aria-[current]:ring-1 aria-[current]:ring-primary data-dragging:opacity-40 data-pending:opacity-60',
        draggable && 'touch-manipulation active:cursor-grabbing',
      )}
    >
      <CardBody title={title} fields={fields} />
    </div>
  );
}

/** The card under the pointer while it is dragged. */
export function CardPreview({ title, fields }: { title: string; fields: CardField[] }) {
  return (
    <div className={cn(CARD, 'w-68 rotate-1 cursor-grabbing shadow-lg ring-1 ring-primary/40')}>
      <CardBody title={title} fields={fields} />
    </div>
  );
}
