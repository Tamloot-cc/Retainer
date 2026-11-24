import { ArrowRight, ChevronRight } from 'lucide-react';
import { Children, createContext, type ReactNode, useContext, useId } from 'react';
import { cn } from './core.js';

/**
 * Where an extension's data goes: one card per kind of record it imports,
 * each pointing at a list in the workspace. The same anatomy serves the form
 * (with controls) and the summaries (with plain text), so a person sees one
 * shape from setup to review to the installed extension.
 */
const Plain = createContext(false);
/** `plain` drops the cards' frames for a summary inside another card. */
export function MappingList({
  label,
  plain = false,
  children,
}: {
  label: string;
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <Plain.Provider value={plain}>
      <ul
        aria-label={label}
        className={cn('flex flex-col', plain ? 'divide-y divide-border' : 'gap-3')}
      >
        {children}
      </ul>
    </Plain.Provider>
  );
}

/**
 * One kind of record: its icon, name and a line about it, then an arrow to
 * `destination` (a control or the chosen list). `note` sits under the header,
 * such as why it was suggested; `children` hold the fields, under a rule.
 */
export function MappingCard({
  icon,
  title,
  description,
  destination,
  note,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  destination: ReactNode;
  note?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  const plain = useContext(Plain);
  return (
    <li
      aria-labelledby={id}
      className={cn(
        'min-w-0',
        plain ? 'py-3 first:pt-0 last:pb-0' : 'rounded-lg border border-border bg-card',
      )}
    >
      <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-2', !plain && 'p-4')}>
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50"
        >
          {icon}
        </span>
        <div className={cn('min-w-0 flex-1', plain ? 'basis-20' : 'basis-40')}>
          <p id={id} className="text-sm font-medium">
            {title}
          </p>
          {description ? (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
          ) : null}
        </div>
        <div
          className={cn(
            'flex min-w-0 items-center gap-2',
            plain ? 'max-w-[55%] sm:max-w-none' : 'w-full sm:w-auto',
          )}
        >
          <ArrowRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="sr-only"> to </span>
          <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">{destination}</div>
        </div>
      </div>
      {note ? (
        <div className={cn('space-y-2', plain ? 'pt-2 sm:pl-12' : '-mt-1 px-4 pb-3')}>{note}</div>
      ) : null}
      {Children.toArray(children).length ? (
        <div
          className={cn('space-y-3', plain ? 'pt-3 sm:pl-12' : 'border-t border-border px-4 py-3')}
        >
          {children}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Optional mapping or review details. The native disclosure keeps the
 * contents searchable and can open when a field needs attention.
 */
export function MappingDisclosure({
  label,
  summary,
  subtle = false,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary?: ReactNode;
  subtle?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      open={open}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      className="min-w-0 [&[open]>summary_svg]:rotate-90"
    >
      <summary
        className={cn(
          'flex min-w-0 scroll-mb-20 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md px-2.5 py-1.5 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden',
          subtle ? 'min-h-8 text-xs text-muted-foreground' : 'min-h-10 bg-muted/40 text-sm',
        )}
      >
        <span className="inline-flex items-center gap-1.5 font-medium">
          <ChevronRight
            size={14}
            aria-hidden
            className="shrink-0 text-primary motion-safe:transition-transform"
          />
          {label}
        </span>
        {summary ? <span className="min-w-0 text-xs text-muted-foreground">{summary}</span> : null}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

/**
 * Field-by-field: what the extension writes, then where it goes. `from` and
 * `to` head the two columns.
 */
export function FieldMap({
  from,
  to,
  children,
}: {
  from: string;
  to: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{from}</span>
      <span className="pl-6 text-xs font-medium text-muted-foreground">{to}</span>
      {children}
    </div>
  );
}

/**
 * One row of a `FieldMap`. `nested` indents a row that belongs to the one
 * above, such as one status value of a status field. Errors run
 * under the row across both columns.
 */
export function FieldMapRow({
  label,
  nested = false,
  error,
  children,
}: {
  label: string;
  nested?: boolean;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <span
        className={cn(
          'min-w-0 [overflow-wrap:anywhere]',
          nested ? 'pl-4 text-muted-foreground' : 'font-medium text-foreground',
        )}
      >
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <ArrowRight size={14} aria-hidden className="shrink-0 text-muted-foreground" />
        <span className="sr-only"> to </span>
        <span className="min-w-0 flex-1">{children}</span>
      </span>
      {error ? <div className="col-span-2">{error}</div> : null}
    </>
  );
}

/** A chosen destination as text: its icon and name, with an optional badge. */
export function Destination({
  icon,
  children,
  badge,
}: {
  icon?: ReactNode;
  children: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      {icon}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      {badge}
    </span>
  );
}
