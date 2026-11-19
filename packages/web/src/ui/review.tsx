import { ArrowRight, Copy, type LucideIcon, PencilLine, Shapes, UsersRound } from 'lucide-react';
import { createContext, type ReactNode, useContext, useId } from 'react';
import { Badge, cn } from './core.js';
import { EntryQuote } from './entry.js';

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
      'Compare the records and choose which values to keep. The older record is kept automatically.',
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
              ? 'border-primary/50 bg-primary/5 ring-1 ring-primary/30'
              : 'border-border bg-card hover:bg-hover',
          )}
        >
          <span className="flex w-full items-center justify-between gap-2">
            <Icon
              size={17}
              aria-hidden
              className={value === id ? 'text-primary' : 'text-muted-foreground'}
            />
            <span
              className={cn(
                'min-w-6 rounded-full px-1.5 py-px text-center text-xs font-medium tabular-nums',
                counts[id] ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
              )}
            >
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

const CardTitle = createContext<string | undefined>(undefined);

/**
 * One item to decide. Every category shares this anatomy: a header (what it
 * is, who asked and when, its status), a body (what would change and why),
 * and, for people who can act, a footer with the actions. The header's
 * title names the card for screen readers.
 */
export function ReviewCard({
  children,
  active = false,
}: {
  children: ReactNode;
  active?: boolean;
}) {
  const title = useId();
  return (
    <section
      data-review-card
      data-active={active || undefined}
      aria-labelledby={title}
      className={cn(
        'min-w-0 overflow-hidden rounded-lg border bg-card shadow-xs [overflow-wrap:anywhere]',
        active ? 'border-primary/50 ring-1 ring-primary/30' : 'border-border',
      )}
    >
      <CardTitle.Provider value={title}>{children}</CardTitle.Provider>
    </section>
  );
}

/**
 * `leading` holds a selection checkbox or a `ReviewIcon`, `meta` a row of
 * small details under the title, `status` a badge that sits at the end (and
 * wraps under on phones).
 */
export function ReviewCardHeader({
  leading,
  title,
  meta,
  status,
}: {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
}) {
  const id = useContext(CardTitle);
  return (
    <div className="flex min-w-0 items-start gap-3 px-4 pt-4 sm:px-5">
      {leading}
      <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-60 space-y-1">
          <h3
            id={id}
            className="min-w-0 text-[15px] font-semibold leading-snug [overflow-wrap:anywhere]"
          >
            {title}
          </h3>
          {meta ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground [&>*]:min-w-0 [&>*]:max-w-full">
              {meta}
            </div>
          ) : null}
        </div>
        {status ? <div className="flex shrink-0 flex-wrap gap-1.5">{status}</div> : null}
      </div>
    </div>
  );
}

/** The kind of item, as a tile at the start of a card's header. */
export function ReviewIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
      <Icon size={17} aria-hidden />
    </div>
  );
}

/** A selection checkbox at the start of a card's header, aligned with the title. */
export function ReviewSelect({ children }: { children: ReactNode }) {
  return <div className="flex h-5 shrink-0 items-center">{children}</div>;
}

/** A dot between two details in a header's meta row. */
export function MetaDot() {
  return (
    <span aria-hidden className="text-muted-foreground/60">
      ·
    </span>
  );
}

/** The detail in a meta row that names what is being decided, such as the field. */
export function MetaStrong({ children }: { children: ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

/** Plain body text in a card. */
export function ReviewText({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed">{children}</p>;
}

export function ReviewCardBody({ children }: { children: ReactNode }) {
  return <div className="min-w-0 space-y-3 px-4 pb-4 pt-3 sm:px-5">{children}</div>;
}

/** The actions, set apart from the content: full width on phones, at the end on larger screens. */
export function ReviewCardFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3 sm:px-5 [&>button]:min-h-11 [&>button]:min-w-0 [&>button]:flex-1 sm:[&>button]:min-h-8 sm:[&>button]:flex-none">
      {children}
    </div>
  );
}

/** A line of context under the content: why it is waiting, where it came from. */
export function ReviewNote({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground">
      <Icon size={15} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/** The proposer's own explanation, quoted, so it reads as theirs and not the app's. */
export function ReviewReason({ children }: { children: ReactNode }) {
  return (
    <figure className="min-w-0 space-y-1">
      <figcaption className="text-xs font-medium text-muted-foreground">Why</figcaption>
      <EntryQuote>{children}</EntryQuote>
    </figure>
  );
}

const KIND_BADGE = {
  added: { tone: 'success', text: 'New' },
  removed: { tone: 'error', text: 'Deleted' },
  changed: { tone: 'neutral', text: 'Edited' },
} as const;
/** Whether a part of the schema is new, edited or deleted. */
export function ChangeBadge({ kind }: { kind: keyof typeof KIND_BADGE }) {
  return <Badge tone={KIND_BADGE[kind].tone}>{KIND_BADGE[kind].text}</Badge>;
}

/** A structure change, one section per object. */
export function ChangeList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul
      aria-label={label}
      className="min-w-0 divide-y divide-border rounded-lg border border-border"
    >
      {children}
    </ul>
  );
}

/** One property, before and after; either side may be absent. */
export type ChangeLineProps = { label: string; before?: string; after?: string; code?: boolean };
function ChangeLines({ lines }: { lines: ChangeLineProps[] }) {
  return lines.map((line) => (
    <ChangeLine key={`${line.label}:${line.after ?? line.before}`} {...line} />
  ));
}

/** One object in a structure change: its own properties, then its fields. */
export function ChangeGroup({
  icon,
  title,
  badge,
  lines,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  lines: ChangeLineProps[];
  children?: ReactNode;
}) {
  return (
    <li className="min-w-0 space-y-2 p-3 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {icon}
        <span className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{title}</span>
        {badge}
      </div>
      <ChangeLines lines={lines} />
      {children}
    </li>
  );
}

/** One field within an object's section. */
export function ChangeField({
  title,
  type,
  badge,
  lines,
}: {
  title: ReactNode;
  type?: ReactNode;
  badge?: ReactNode;
  lines: ChangeLineProps[];
}) {
  return (
    <div className="min-w-0 space-y-1.5 rounded-md bg-muted/50 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{title}</span>
        {type ? <span className="text-xs text-muted-foreground">{type}</span> : null}
        {badge}
      </div>
      <ChangeLines lines={lines} />
    </div>
  );
}

const SHORT = 40;
/**
 * One property, before and after. Short values read inline ("Engagement →
 * Project"); long ones stack, the old one struck through above the new.
 * Screen readers hear "was … now …".
 */
export function ChangeLine({ label, before, after, code = false }: ChangeLineProps) {
  const value = code ? 'font-mono text-xs' : '';
  const old = before ? (
    <span
      className={cn('text-muted-foreground line-through decoration-muted-foreground/60', value)}
    >
      <span className="sr-only">was </span>
      {before}
    </span>
  ) : null;
  const next = after ? (
    <span className={cn('text-foreground', value)}>
      {before ? <span className="sr-only">now </span> : null}
      {after}
    </span>
  ) : null;
  const inline =
    before &&
    after &&
    before.length <= SHORT &&
    after.length <= SHORT &&
    !/\n/.test(before + after);
  return (
    <div className="grid min-w-0 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
      <span className="text-xs leading-5 text-muted-foreground sm:text-sm">{label}</span>
      {!before && !after ? null : inline ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 [overflow-wrap:anywhere]">
          {old}
          <ArrowRight size={13} aria-hidden className="shrink-0 text-muted-foreground" />
          {next}
        </span>
      ) : (
        <span className="flex min-w-0 flex-col gap-0.5 leading-relaxed [overflow-wrap:anywhere]">
          {old}
          {next}
        </span>
      )}
    </div>
  );
}

/** Two boxes side by side with a mark between them; stacked, without the mark, on phones. */
function SideBySide({
  left,
  right,
  between,
}: {
  left: ReactNode;
  right: ReactNode;
  between: ReactNode;
}) {
  return (
    <div className="grid min-w-0 items-stretch gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
      {left}
      <span aria-hidden className="hidden self-center text-muted-foreground sm:block">
        {between}
      </span>
      {right}
    </div>
  );
}
const BOX = 'min-w-0 rounded-lg border p-3 text-sm [overflow-wrap:anywhere]';

/** Two records that may be the same, with "≈" between them. */
export function ReviewPair({ left, right }: { left: ReactNode; right: ReactNode }) {
  const box = (content: ReactNode) => (
    <div className={cn(BOX, 'flex items-center border-border bg-muted/40')}>{content}</div>
  );
  return <SideBySide left={box(left)} right={box(right)} between="≈" />;
}

export function ReviewComparison({
  current,
  proposed,
}: {
  current: ReactNode;
  proposed: ReactNode;
}) {
  return (
    <SideBySide
      left={
        <div className={cn(BOX, 'space-y-1.5 border-border bg-muted/40')}>
          <p className="text-xs text-muted-foreground">Current value</p>
          <div className="min-w-0">{current}</div>
        </div>
      }
      between={<ArrowRight size={15} />}
      right={
        <div className={cn(BOX, 'space-y-1.5 border-primary/25 bg-primary/5')}>
          <p className="text-xs font-medium text-primary">Proposed value</p>
          <div className="min-w-0">{proposed}</div>
        </div>
      }
    />
  );
}

export function ReviewActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2 [&>button]:min-h-11 [&>button]:min-w-0 [&>button]:flex-1 sm:[&>button]:flex-none">
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
