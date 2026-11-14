import { Link } from '@tanstack/react-router';
import { Check, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './core.js';

/**
 * The steps of a flow that takes a page, such as setting up an extension:
 * a numbered list beside the current step (from `md`), or a strip above it.
 * A finished step can be picked to go back to it; later steps cannot.
 */
export function StepFlow({
  label,
  steps,
  current,
  onBack,
  children,
}: {
  label: string;
  steps: string[];
  current: number;
  onBack: (step: number) => void;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-5 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-10">
      <nav aria-label={label} className="min-w-0 md:sticky md:top-16 md:self-start">
        <ol className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-col md:gap-1 md:px-0">
          {steps.map((step, index) => {
            const done = index < current,
              active = index === current;
            return (
              <li key={step} className="shrink-0">
                <button
                  type="button"
                  disabled={!done}
                  aria-current={active ? 'step' : undefined}
                  onClick={() => onBack(index)}
                  className={cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-hover font-medium text-foreground'
                      : done
                        ? 'text-foreground hover:bg-hover'
                        : 'text-muted-foreground',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium tabular-nums',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : done
                          ? 'border-primary text-primary'
                          : 'border-border',
                    )}
                  >
                    {done ? <Check size={12} /> : index + 1}
                  </span>
                  <span className="truncate">{step}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="flex min-w-0 max-w-2xl flex-col gap-5">{children}</div>
    </div>
  );
}

/** The heading and plain-words introduction of the current step. */
export function StepHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div>
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children ? <p className="mt-1 text-sm text-muted-foreground">{children}</p> : null}
    </div>
  );
}

/** Back and continue under a step: the primary action last, at the end. */
export function StepActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{children}</div>;
}

/**
 * One item in a list of cards: an icon, the name with a short status beside
 * it and a line of description. With `link` the whole card opens the item and
 * ends in a chevron; otherwise `action` (such as a button) sits at its end.
 */
export function ItemCard({
  icon,
  title,
  status,
  description,
  action,
  link,
}: {
  icon: ReactNode;
  title: string;
  status?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  link?: { to: string; params?: Record<string, string> };
}) {
  const body = (
    <>
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{title}</span>
          {status}
        </span>
        {description ? (
          <span className="line-clamp-2 text-sm text-muted-foreground">{description}</span>
        ) : null}
      </span>
    </>
  );
  const frame = 'flex items-center gap-3 rounded-lg border border-border bg-card p-3';
  return (
    <li>
      {link ? (
        <Link
          to={link.to as never}
          params={link.params as never}
          className={cn(
            frame,
            'transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {body}
          <ChevronRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
        </Link>
      ) : (
        <div className={frame}>
          {body}
          {action ? <span className="shrink-0">{action}</span> : null}
        </div>
      )}
    </li>
  );
}

/** A list of `ItemCard`s under an optional small heading. */
export function ItemCards({
  label,
  columns = 1,
  children,
}: {
  label: string;
  columns?: 1 | 2;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</h2>
      <ul className={cn('grid gap-2', columns === 2 && 'sm:grid-cols-2')}>{children}</ul>
    </section>
  );
}
