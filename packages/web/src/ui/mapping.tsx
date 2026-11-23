import { ArrowRight, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { createContext, type ReactNode, useContext, useId } from 'react';
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
        <div className="min-w-0 flex-1 basis-40">
          <p id={id} className="text-sm font-medium">
            {title}
          </p>
          {description ? (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{description}</p>
          ) : null}
        </div>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <ArrowRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="sr-only"> to </span>
          <div className="min-w-0 flex-1 sm:w-56 sm:flex-none">{destination}</div>
        </div>
      </div>
      {note ? (
        <div className={cn('space-y-2', plain ? 'pt-2 sm:pl-12' : '-mt-1 px-4 pb-3')}>{note}</div>
      ) : null}
      {children ? (
        <div
          className={cn('space-y-3', plain ? 'pt-3 sm:pl-12' : 'border-t border-border px-4 py-3')}
        >
          {children}
        </div>
      ) : null}
    </li>
  );
}

/** Why a choice was suggested, marked so it reads as a suggestion and not a rule. */
export function SuggestionNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-sm text-muted-foreground">
      <Sparkles size={14} aria-hidden className="mt-0.5 shrink-0 text-primary" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-medium text-foreground">Suggested.</span> {children}
      </span>
    </p>
  );
}

/** A plain line of context in a card, such as what choosing a new list does. */
export function MappingNote({ children }: { children: ReactNode }) {
  return (
    <p className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">{children}</p>
  );
}

/**
 * The fields, folded under one line that sums them up. `open` is controlled
 * so the form can open it when a field needs attention.
 */
export function FieldDisclosure({
  label,
  summary,
  open,
  onToggle,
  children,
}: {
  label: string;
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="-mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-sm px-1 py-0.5 text-left text-sm hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chevron size={14} aria-hidden className="shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium">{label}</span>
        {open ? null : <span className="min-w-0 truncate text-muted-foreground">{summary}</span>}
      </button>
      {open ? (
        <div id={id} className="pt-3">
          {children}
        </div>
      ) : null}
    </div>
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
    <div className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{from}</span>
      <span className="pl-6 text-xs font-medium text-muted-foreground">{to}</span>
      {children}
    </div>
  );
}

/**
 * One row of a `FieldMap`. `nested` indents a row that belongs to the one
 * above, such as one status value of a status field; `note` and `error` run
 * under the row across both columns.
 */
export function FieldMapRow({
  label,
  nested = false,
  note,
  error,
  children,
}: {
  label: string;
  nested?: boolean;
  note?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <span
        className={cn(
          'min-w-0 truncate',
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
      {note ? <div className="col-span-2 -mt-1">{note}</div> : null}
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
      <span className="min-w-0 truncate">{children}</span>
      {badge}
    </span>
  );
}
