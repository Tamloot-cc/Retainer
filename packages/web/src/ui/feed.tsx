import { Link } from '@tanstack/react-router';
import { ArrowRight, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { RecordAvatar } from './identity.js';

/** A calm introduction and a shortcut to the work that needs a person. */
export function HomeWelcome({ reviewCount }: { reviewCount: number }) {
  return (
    <div className="space-y-5 pb-1 pt-3">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Your workspace, at a glance.</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Catch up on conversations, new connections, and what changed.
        </p>
      </div>
      {reviewCount > 0 ? (
        <Link
          to="/review"
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5 text-sm transition-colors hover:bg-hover"
        >
          <Inbox size={18} className="text-primary" aria-hidden />
          <span className="flex-1">
            <strong className="font-medium">
              {reviewCount} {reviewCount === 1 ? 'item needs' : 'items need'} your review
            </strong>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Help your agents keep the details right.
            </span>
          </span>
          <ArrowRight size={16} aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}

export function HomeScroll({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-10 pt-5 md:px-8">
        {children}
      </div>
    </div>
  );
}

export function HomeDay({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section aria-label={heading}>
      <h2 className="mb-3 text-xs font-medium text-muted-foreground">{heading}</h2>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

/** Links and expansion controls are independent; the whole card is not a nested button. */
export function HomeCard({
  record,
  label,
  type,
  title,
  time,
  children,
  footer,
}: {
  record: { id: string; object: string; event?: unknown };
  label: string;
  type: string;
  title: ReactNode;
  time: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-xs sm:p-5">
      <div className="flex items-start gap-3">
        <RecordAvatar
          id={record.id}
          name={label}
          object={record.object}
          objectClass={record.event ? 'event' : 'entity'}
          large
        />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{type}</span>
            {time}
          </div>
          <div className="text-sm font-medium leading-relaxed [overflow-wrap:anywhere]">
            {title}
          </div>
        </div>
      </div>
      {children ? (
        <div className="mt-4 space-y-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
          {children}
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
        {footer}
      </div>
    </article>
  );
}

export function HomeSummary({ children }: { children: ReactNode }) {
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{children}</p>
  );
}

export function HomeChange({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg bg-muted/50 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Search can shrink while the filter action stays visible on narrow screens. */
export function HomeTools({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pointer-coarse:[&>input]:min-h-11">
      {children}
    </div>
  );
}

export function HomeTitle({
  children,
  onClick,
  recordId,
}: {
  children: ReactNode;
  onClick: () => void;
  recordId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-record-sheet-trigger={recordId}
      className="rounded-sm text-left text-base font-medium leading-snug text-foreground [overflow-wrap:anywhere] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
