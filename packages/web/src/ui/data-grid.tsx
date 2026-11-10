import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ArrowDown, ArrowUp, Pencil, X } from 'lucide-react';
import {
  type ComponentProps,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useRef,
  useState,
} from 'react';
import { cn, isPlainClick, PLACEMENT, ROW_STATE } from './core.js';
import { ApiName } from './layout.js';
import { type EditorHandlers, EditorHostContext } from './property.js';

export type GridColumn = {
  id: string;
  label: string;
  /** Developer view: the API name, shown after the label. */
  apiName?: string;
  width: number;
  sortable?: boolean;
  /** Pinned to the left edge; can't be dragged or dropped on. */
  pinned?: boolean;
};
/** `label` names the row for its checkbox: "Select Acme". */
export type GridRow = { id: string; label?: string; cells: ReactNode[] };
/** Row checkboxes: which rows are selected, and how to change that. */
export type GridSelection = {
  selected: ReadonlySet<string>;
  onToggle: (row: string) => void;
  /** Selects every row shown, or clears the selection when all are selected. */
  onToggleAll: () => void;
};

/** The checkbox column's width; the pinned label column sits right after it. */
const CHECK_WIDTH = 40;

export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 640;
const STEP = 16;
export const clampWidth = (w: number) =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, w)));

/**
 * A spreadsheet-style record grid: sticky header and first column, click a
 * header to sort, drag a header edge to resize, drag a header to reorder.
 * The grid owns no data; changes come back through the callbacks.
 */
export function DataGrid({
  label,
  columns,
  rows,
  sort,
  onSort,
  onResize,
  onReorder,
  onOpenRow,
  selectedRow,
  selection,
  footer,
}: {
  label: string;
  columns: GridColumn[];
  rows: GridRow[];
  selection?: GridSelection;
  /** One cell per column under the rows, e.g. column totals. */
  footer?: ReactNode[];
  /** The row whose record is open beside the grid; it stays highlighted. */
  selectedRow?: string;
  sort?: { column: string; direction: 'asc' | 'desc' };
  onSort?: (column: string) => void;
  onResize?: (column: string, width: number) => void;
  onReorder?: (column: string, target: string) => void;
  onOpenRow?: (row: string) => void;
}) {
  const [draft, setDraft] = useState<{ id: string; width: number } | null>(null),
    [dragging, setDragging] = useState<string | null>(null),
    [over, setOver] = useState<string | null>(null);
  const resizing = useRef(false);
  const widthOf = (c: GridColumn) => (draft?.id === c.id ? draft.width : c.width);
  const pinLeft = selection ? CHECK_WIDTH : 0;
  const total = columns.reduce((sum, c) => sum + widthOf(c), pinLeft);
  const all = rows.length > 0 && rows.every((r) => selection?.selected.has(r.id));
  const some = !all && rows.some((r) => selection?.selected.has(r.id));

  function startResize(e: ReactPointerEvent<HTMLDivElement>, column: GridColumn) {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    const startX = e.clientX,
      startWidth = column.width;
    let latest = startWidth;
    const move = (ev: PointerEvent) => {
      latest = clampWidth(startWidth + ev.clientX - startX);
      setDraft({ id: column.id, width: latest });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.removeProperty('cursor');
      resizing.current = false;
      setDraft(null);
      if (latest !== startWidth) onResize?.(column.id, latest);
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  // Arrow keys resize a step per press, and save once the key is let go,
  // as a pointer does: holding a key repeats without a save per step.
  function keyResize(e: ReactKeyboardEvent, column: GridColumn) {
    const by = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0;
    if (!by) return;
    e.preventDefault();
    setDraft({ id: column.id, width: clampWidth(widthOf(column) + by) });
  }
  function endKeyResize(column: GridColumn) {
    if (resizing.current || draft?.id !== column.id) return;
    setDraft(null);
    if (draft.width !== column.width) onResize?.(column.id, draft.width);
  }
  return (
    <section
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: lets keyboard users scroll a wide grid.
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto focus-visible:outline-none"
    >
      <table
        className="border-separate border-spacing-0 text-sm"
        style={{ tableLayout: 'fixed', width: `max(100%, ${total}px)` }}
      >
        <colgroup>
          {selection ? <col style={{ width: CHECK_WIDTH }} /> : null}
          {columns.map((c) => (
            <col key={c.id} style={{ width: widthOf(c) }} />
          ))}
          <col />
        </colgroup>
        <thead>
          <tr>
            {selection ? (
              <th
                scope="col"
                className="sticky left-0 top-0 z-20 h-9 border-b border-border bg-sidebar p-0"
              >
                <div className="flex h-9 items-center justify-center">
                  <input
                    type="checkbox"
                    aria-label="Select all rows on this page"
                    className="ui-checkbox"
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = some;
                    }}
                    onChange={selection.onToggleAll}
                  />
                </div>
              </th>
            ) : null}
            {columns.map((c) => {
              const sorted = sort?.column === c.id ? sort.direction : undefined;
              const canDrag = !!onReorder && !c.pinned;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={
                    sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                  }
                  draggable={canDrag}
                  style={c.pinned ? { left: pinLeft } : undefined}
                  onDragStart={(e) => {
                    if (resizing.current) return e.preventDefault();
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', c.id);
                    setDragging(c.id);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  onDragOver={(e) => {
                    if (!dragging || c.pinned || dragging === c.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setOver(c.id);
                  }}
                  onDragLeave={() => setOver((o) => (o === c.id ? null : o))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragging && dragging !== c.id) onReorder?.(dragging, c.id);
                    setDragging(null);
                    setOver(null);
                  }}
                  className={cn(
                    'group/th sticky top-0 z-10 h-9 border-b border-r border-border bg-sidebar p-0 text-left text-xs font-medium text-muted-foreground',
                    c.pinned && 'z-20',
                    canDrag && 'cursor-grab active:cursor-grabbing',
                    dragging === c.id && 'opacity-50',
                    over === c.id && 'shadow-[inset_2px_0_0_var(--color-primary)]',
                  )}
                >
                  <div className="relative flex h-9 items-center">
                    {c.sortable && onSort ? (
                      <button
                        type="button"
                        onClick={() => onSort(c.id)}
                        title={`Sort by ${c.label}`}
                        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="truncate">
                          {c.label}
                          {c.apiName ? <ApiName>{c.apiName}</ApiName> : null}
                        </span>
                        {sorted === 'asc' ? (
                          <ArrowUp size={12} className="shrink-0 text-foreground" />
                        ) : sorted === 'desc' ? (
                          <ArrowDown size={12} className="shrink-0 text-foreground" />
                        ) : (
                          <ArrowUp
                            size={12}
                            aria-hidden
                            className="shrink-0 opacity-0 transition-opacity group-hover/th:opacity-40"
                          />
                        )}
                      </button>
                    ) : (
                      <span className="truncate px-3">
                        {c.label}
                        {c.apiName ? <ApiName>{c.apiName}</ApiName> : null}
                      </span>
                    )}
                    {onResize ? (
                      // biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no native element.
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${c.label}`}
                        aria-valuenow={widthOf(c)}
                        aria-valuemin={MIN_COLUMN_WIDTH}
                        aria-valuemax={MAX_COLUMN_WIDTH}
                        tabIndex={0}
                        draggable={false}
                        onPointerDown={(e) => startResize(e, c)}
                        onKeyDown={(e) => keyResize(e, c)}
                        onKeyUp={() => endKeyResize(c)}
                        onBlur={() => endKeyResize(c)}
                        onDragStart={(e) => e.preventDefault()}
                        className={cn(
                          'absolute -right-px top-0 z-10 h-full w-1.5 cursor-col-resize touch-none hover:bg-primary/50 focus-visible:bg-primary focus-visible:outline-none',
                          draft?.id === c.id && 'bg-primary',
                        )}
                      />
                    ) : null}
                  </div>
                </th>
              );
            })}
            <th aria-hidden className="sticky top-0 z-10 border-b border-border bg-sidebar" />
          </tr>
        </thead>
        <GridBody
          rows={rows}
          columns={columns}
          onOpenRow={onOpenRow}
          selectedRow={selectedRow}
          selection={selection}
          pinLeft={pinLeft}
        />
        {footer ? (
          <tfoot>
            <tr>
              {selection ? <td className={`${FOOT} left-0 z-20`} /> : null}
              {footer.map((cell, i) => (
                <td
                  key={columns[i]?.id ?? i}
                  className={cn(FOOT, columns[i]?.pinned && 'z-20')}
                  style={columns[i]?.pinned ? { left: pinLeft } : undefined}
                >
                  <div className="flex h-9 items-center overflow-hidden whitespace-nowrap px-1">
                    {cell}
                  </div>
                </td>
              ))}
              <td aria-hidden className={FOOT} />
            </tr>
          </tfoot>
        ) : null}
      </table>
    </section>
  );
}

const ROW_BG = `bg-background ${ROW_STATE}`;
const CELL = `border-b border-r border-border p-0 ${ROW_BG}`;
const PINNED_CELL = `${CELL} sticky z-[5]`;
const FOOT = 'sticky bottom-0 z-10 border-t border-r border-border bg-sidebar p-0';

/** Rows re-render only when their data changes, not while a column is resized or dragged. */
const GridBody = memo(function GridBody({
  rows,
  columns,
  onOpenRow,
  selectedRow,
  selection,
  pinLeft,
}: {
  rows: GridRow[];
  columns: GridColumn[];
  onOpenRow?: (row: string) => void;
  selectedRow?: string;
  selection?: GridSelection;
  pinLeft: number;
}) {
  function openRow(e: ReactMouseEvent, id: string) {
    if (onOpenRow && isPlainClick(e)) onOpenRow(id);
  }
  return (
    <tbody>
      {rows.map((r) => (
        <tr
          key={r.id}
          onClick={(e) => openRow(e, r.id)}
          data-selected={r.id === selectedRow || selection?.selected.has(r.id) || undefined}
          className={onOpenRow ? 'group cursor-pointer' : 'group'}
        >
          {selection ? (
            <td className={`${CELL} sticky left-0 z-[5]`}>
              <div className="flex h-9 items-center justify-center">
                <input
                  type="checkbox"
                  aria-label={`Select ${r.label ?? 'row'}`}
                  className="ui-checkbox"
                  checked={selection.selected.has(r.id)}
                  onChange={() => selection.onToggle(r.id)}
                />
              </div>
            </td>
          ) : null}
          {r.cells.map((cell, i) => (
            <td
              key={columns[i]?.id ?? i}
              className={columns[i]?.pinned ? PINNED_CELL : CELL}
              style={columns[i]?.pinned ? { left: pinLeft } : undefined}
            >
              <div className="flex h-9 items-center gap-1 overflow-hidden whitespace-nowrap px-3 [&>*]:min-w-0 [&>*]:truncate">
                {cell}
              </div>
            </td>
          ))}
          <td aria-hidden className={`border-b border-border ${ROW_BG}`} />
        </tr>
      ))}
    </tbody>
  );
});

/**
 * A grid cell a person can edit: its value, and a pencil that shows on hover
 * or focus and opens `editor` in a layer anchored to the cell.
 */
export function EditableCell({
  label,
  editor,
  wide = false,
  children,
}: {
  label: string;
  /** The editor, rendered only while open; `close` dismisses it. */
  editor: (close: () => void) => ReactNode;
  /** Room for a form of several controls, rather than a list to pick from. */
  wide?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // The editor inside decides what a click outside (save) and Escape (drop
  // the draft) mean, and closes itself when it's done.
  const handlers = useRef<EditorHandlers | null>(null);
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && handlers.current) handlers.current.outside();
        else setOpen(next);
      }}
    >
      <PopoverPrimitive.Anchor asChild>
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span className="min-w-0 flex-1 truncate">{children}</span>
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              aria-label={`Edit ${label}`}
              title="Edit"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <Pencil size={12} />
            </button>
          </PopoverPrimitive.Trigger>
        </span>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          {...PLACEMENT}
          // The editor takes focus itself.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            if (!handlers.current) return;
            e.preventDefault();
            handlers.current.cancel();
          }}
          className={cn('z-50', wide ? 'w-[min(92vw,22rem)]' : 'w-[min(92vw,16rem)]')}
        >
          <EditorHostContext.Provider value={handlers}>
            {editor(() => setOpen(false))}
          </EditorHostContext.Provider>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** A footer cell's menu trigger: what the column computes, or "Calculate". */
export function FooterButton({ children, ...props }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      {...props}
      className="flex h-7 min-w-0 max-w-full items-center rounded-sm px-2 text-xs text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

/** The bar above a grid: filters on the left, view controls on the right. */
export function Toolbar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 md:px-5">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
      {end ? <div className="flex shrink-0 items-center gap-1.5">{end}</div> : null}
    </div>
  );
}

export function FilterChip({
  field,
  operator,
  value,
  removeLabel = `Remove filter ${field}`,
  onRemove,
}: {
  field: string;
  operator?: string;
  value?: string;
  removeLabel?: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 pl-2 text-xs">
      <span className="shrink-0 font-medium">{field}</span>
      {operator ? <span className="shrink-0 text-muted-foreground">{operator}</span> : null}
      {value ? (
        <span className="truncate font-medium" title={value}>
          {value}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="flex h-full shrink-0 items-center rounded-r-md px-1.5 text-muted-foreground hover:bg-hover hover:text-foreground"
      >
        <X size={12} />
      </button>
    </span>
  );
}

/** The bar under a grid: what's shown on the left, paging on the right. */
export function GridFooter({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-t border-border bg-sidebar px-3 text-xs text-muted-foreground md:px-5">
      <div className="min-w-0 flex-1 truncate tabular-nums">{children}</div>
      {end ? <div className="flex shrink-0 items-center gap-1">{end}</div> : null}
    </div>
  );
}
