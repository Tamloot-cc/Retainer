import { Check as CheckIcon, Copy, type LucideIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { CategoryColor } from './colors.js';
import { cn, type Tone } from './core.js';

/**
 * A page section with its own navigation: a sticky list on the left and the
 * selected item beside it. Below `md` the list becomes a scrolling strip
 * above the content.
 */
export function SplitView({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-6 md:grid-cols-[13rem_minmax(0,1fr)] md:gap-8">
      <div className="min-w-0 md:sticky md:top-16 md:self-start">{nav}</div>
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
    </div>
  );
}

/** `label` is both the visible heading (from `md`) and the navigation's accessible name. */
export function NavList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <nav aria-label={label} className="flex flex-col gap-1.5">
      <p className="hidden px-2 text-[11px] font-medium text-muted-foreground md:block">{label}</p>
      <ul className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-col md:gap-0.5 md:overflow-visible md:px-0">
        {children}
      </ul>
    </nav>
  );
}

export function NavItem({
  icon: Icon,
  label,
  color,
  meta,
  active = false,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  color?: CategoryColor;
  /** A short count or note at the end of the row. */
  meta?: ReactNode;
  active?: boolean;
  onSelect: () => void;
}) {
  return (
    <li className="shrink-0">
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={cn(
          'flex h-8 w-full items-center gap-2.5 rounded-md border px-2 text-sm transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 md:border-transparent',
          active
            ? 'border-border bg-selection font-medium text-selection-foreground'
            : 'border-border text-muted-foreground',
        )}
      >
        <Icon
          size={16}
          aria-hidden
          data-color={color}
          className={cn('shrink-0', color && 'category-color')}
        />
        <span className="truncate">{label}</span>
        {meta !== undefined ? (
          <span className="ml-auto pl-2 text-xs font-normal tabular-nums text-muted-foreground">
            {meta}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** The heading of the item a page is showing: icon, name, a meta line, description and actions. */
export function EntityHeader({
  icon: Icon,
  title,
  color,
  meta,
  description,
  actions,
}: {
  icon: LucideIcon;
  title: string;
  color?: CategoryColor;
  meta?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <span
          aria-hidden
          data-color={color}
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
            color ? 'category-tag' : 'border border-border bg-card text-muted-foreground',
          )}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h2>
          {meta ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {meta}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="col-start-2 flex min-w-0 items-center gap-2 sm:col-start-3 sm:row-start-1">
            {actions}
          </div>
        ) : null}
      </div>
      {description ? (
        <p className="max-w-2xl text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {description}
        </p>
      ) : null}
    </header>
  );
}

/** A button that reads as a link in running text or a table cell. */
export function TextButton({
  onClick,
  className,
  children,
}: {
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'max-w-full truncate rounded-sm text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** An API name or other identifier, set in monospace. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="min-w-0 rounded-sm bg-muted px-1 py-px font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
      {children}
    </code>
  );
}

/**
 * An API name beside the label people read, shown in developer view: quiet
 * and monospace.
 */
export function ApiName({ children }: { children: ReactNode }) {
  return (
    <code
      data-api-name
      className="ml-1.5 shrink-0 font-mono text-[11px] font-normal text-muted-foreground/80 [overflow-wrap:anywhere]"
    >
      {children}
    </code>
  );
}

/** A small button that copies `value` to the clipboard and says so. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* The clipboard can be refused; the value is on screen to select. */
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      title={copied ? 'Copied' : label}
      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <CheckIcon size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : null}
    </button>
  );
}

/** A value as formatted JSON, scrolling on its own. */
export function JsonBlock({ value, label }: { value: unknown; label: string }) {
  return (
    <section aria-label={label}>
      <pre className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </section>
  );
}

/** A yes/no cell: a check mark or a faint dash. */
export function Check({ value }: { value: boolean }) {
  return value ? (
    <CheckIcon size={15} role="img" aria-label="Yes" className="inline-block" />
  ) : (
    <span role="img" aria-label="No" className="text-muted-foreground/50">
      –
    </span>
  );
}

/** Cards laid out two to a row from `sm`. */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-2">{children}</div>;
}

export function Timeline({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ol aria-label={label} className="flex flex-col">
      {children}
    </ol>
  );
}

const TONES: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  pending: 'text-amber-600 dark:text-amber-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  error: 'text-destructive',
};
/** One event on a `Timeline`: an icon on the rail, then the content. */
export function TimelineItem({
  icon: Icon,
  tone = 'neutral',
  children,
}: {
  icon: LucideIcon;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <li className="group/item relative flex gap-3 pb-6 last:pb-0">
      <span
        aria-hidden
        className="absolute bottom-0 left-[13px] top-7 w-px bg-border group-last/item:hidden"
      />
      <span
        aria-hidden
        className={cn(
          'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-card',
          TONES[tone],
        )}
      >
        <Icon size={14} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-1 text-sm [overflow-wrap:anywhere]">
        {children}
      </div>
    </li>
  );
}
