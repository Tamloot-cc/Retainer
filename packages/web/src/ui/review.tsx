import { Copy, PencilLine, Shapes, UsersRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './core.js';

export const REVIEW_CATEGORIES = [
  {
    value: 'pendingAssertions',
    label: 'Proposed updates',
    icon: PencilLine,
    description: 'Suggested changes to record details.',
    explanation: 'Compare the current and proposed values, then accept or reject the suggestion.',
  },
  {
    value: 'schema',
    label: 'Structure changes',
    icon: Shapes,
    description: 'Changes to record types and their fields.',
    explanation:
      'For example, adding a Deal type or a Renewal date field. Workspace admins approve these changes.',
  },
  {
    value: 'mergeSuggestions',
    label: 'Possible duplicates',
    icon: Copy,
    description: 'Records that may describe the same thing.',
    explanation:
      'Compare the records, then choose whether to combine them into one. You choose which record to keep.',
  },
  {
    value: 'unresolvedParticipants',
    label: 'Participant issues',
    icon: UsersRound,
    description: 'Participants whose matching record was deleted.',
    explanation:
      'Open the related activity to check its participants. These items are handled in the activity details.',
  },
] as const;
export type ReviewCategory = (typeof REVIEW_CATEGORIES)[number]['value'];

export function ReviewScroll({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 pb-10 pt-7 md:px-8">
        {children}
      </div>
    </div>
  );
}

export function ReviewWelcome() {
  return (
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Keep the details right.</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Review suggestions and check anything that needs your attention.
      </p>
    </div>
  );
}

/** All four explanations stay visible on phones; no category is hidden offscreen. */
export function ReviewCategories({
  value,
  counts,
  onChange,
}: {
  value: ReviewCategory;
  counts: Partial<Record<ReviewCategory, number>>;
  onChange: (value: ReviewCategory) => void;
}) {
  return (
    <nav aria-label="Review categories" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {REVIEW_CATEGORIES.map(({ value: id, label, description, icon: Icon }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          aria-label={`${label}${counts[id] === undefined ? '' : ` (${counts[id]})`}`}
          aria-describedby={`review-category-${id}`}
          onClick={() => onChange(id)}
          className={cn(
            'flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-4',
            value === id
              ? 'border-primary/50 bg-primary/5'
              : 'border-border bg-card hover:bg-hover',
          )}
        >
          <span className="flex w-full items-center justify-between gap-2">
            <Icon
              size={17}
              aria-hidden
              className={value === id ? 'text-primary' : 'text-muted-foreground'}
            />
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {counts[id] ?? '—'}
            </span>
          </span>
          <span className="text-sm font-medium leading-snug">{label}</span>
          <span
            id={`review-category-${id}`}
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {description}
          </span>
        </button>
      ))}
    </nav>
  );
}

export function ReviewIntroduction({
  category,
  readOnly,
}: {
  category: ReviewCategory;
  readOnly: boolean;
}) {
  const item = REVIEW_CATEGORIES.find((item) => item.value === category) ?? REVIEW_CATEGORIES[0];
  return (
    <div className="space-y-1.5">
      <h2 className="text-base font-semibold">{item.label}</h2>
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{item.explanation}</p>
      {readOnly && category !== 'unresolvedParticipants' ? (
        <p className="text-xs text-muted-foreground">
          You can view these suggestions.{' '}
          {category === 'schema' ? 'A workspace admin' : 'Someone with write access'} can act on
          them.
        </p>
      ) : null}
    </div>
  );
}

export function ReviewCard({
  children,
  active = false,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <section
      data-review-card
      data-active={active || undefined}
      className={cn(
        'min-w-0 rounded-lg border bg-card p-4 shadow-xs [overflow-wrap:anywhere] sm:p-5',
        active ? 'border-primary/40' : 'border-border',
      )}
    >
      {children}
    </section>
  );
}

export function ReviewComparison({
  current,
  proposed,
}: {
  current: ReactNode;
  proposed: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      <div className="min-w-0 space-y-2 rounded-lg bg-muted/60 p-3">
        <p className="text-xs text-muted-foreground">Current value</p>
        <div className="min-w-0 text-sm [overflow-wrap:anywhere]">{current}</div>
      </div>
      <div className="min-w-0 space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
        <p className="text-xs text-muted-foreground">Proposed value</p>
        <div className="min-w-0 text-sm [overflow-wrap:anywhere]">{proposed}</div>
      </div>
    </div>
  );
}

export function ReviewActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2 [&>button]:min-h-11 [&>button]:min-w-0 [&>button]:flex-1 sm:[&>button]:flex-none">
      {children}
    </div>
  );
}

export function ReviewDetails({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground [&>*]:min-w-0 [&>*]:max-w-full [overflow-wrap:anywhere]">
      {children}
    </div>
  );
}

export function ReviewKeyboard() {
  return (
    <p className="hidden text-xs text-muted-foreground md:block">
      Keyboard: j / k move · x select · a accept · r reject
    </p>
  );
}
