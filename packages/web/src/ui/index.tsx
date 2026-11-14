import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Slot } from '@radix-ui/react-slot';
import { Link } from '@tanstack/react-router';
import { cva } from 'class-variance-authority';
import { ArrowUpRight, ChevronRight, Inbox, Info, Menu, X } from 'lucide-react';
import {
  type ComponentProps,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  lazy,
  type ReactNode,
  type Ref,
  useContext,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { BrandMark } from './brand.js';
import { Badge, cn, isPlainClick, NavigationContext, ROW_STATE } from './core.js';
import { ApiName } from './layout.js';
import { CYCLE, LogoMark } from './logo-mark.js';
import { Tooltip } from './tooltip.js';

// Adapted from shadcn/ui Button (MIT); see THIRD_PARTY.md.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:opacity-90',
        destructive: 'bg-destructive text-white hover:opacity-90',
        outline: 'border border-input bg-background hover:bg-hover',
        ghost: 'hover:bg-hover text-muted-foreground hover:text-foreground',
      },
      size: {
        default: 'h-8 px-3',
        small: 'h-7 px-2 text-xs',
        icon: 'h-8 w-8 px-0',
        iconSmall: 'h-7 w-7 px-0',
      },
    },
    defaultVariants: { variant: 'outline', size: 'default' },
  },
);
/** Defaults to `type="button"`, so only an explicit submit button submits a form. */
export function Button({
  variant = 'outline',
  size = 'default',
  asChild,
  className,
  ...props
}: ComponentProps<'button'> & {
  variant?: 'primary' | 'destructive' | 'outline' | 'ghost';
  size?: 'default' | 'small' | 'icon' | 'iconSmall';
  asChild?: boolean;
}) {
  const C = asChild ? Slot : 'button';
  return (
    <C
      type={asChild ? undefined : 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={
        props.type === 'checkbox'
          ? props.role === 'switch'
            ? 'ui-switch'
            : 'ui-checkbox'
          : props.type === 'radio'
            ? 'ui-radio'
            : 'h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring disabled:opacity-50'
      }
    />
  );
}
/** `prose` is for what people write to each other; the default is for values and JSON. */
export function Textarea({
  prose = false,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { prose?: boolean }) {
  return (
    <textarea
      {...props}
      className={cn(
        'w-full rounded-md border border-input bg-background p-2.5 text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring',
        prose ? 'min-h-20 resize-y' : 'min-h-28 font-mono',
      )}
    />
  );
}
export function Stack({
  children,
  gap = 'default',
}: {
  children: ReactNode;
  gap?: 'default' | 'small';
}) {
  return <div className={cn('flex flex-col', gap === 'small' ? 'gap-2' : 'gap-3')}>{children}</div>;
}
/** Items side by side; `nowrap` keeps them on one line, inputs taking the room. */
export function Row({ children, nowrap = false }: { children: ReactNode; nowrap?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center', nowrap ? 'gap-1' : 'flex-wrap gap-2')}>
      {children}
    </div>
  );
}
/** Two equal columns, for the parts of one value (first and last name). */
export function Columns({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}
/** Holds a short control at a fixed width in a `Row`: `xs` for a code, `sm` for a label. */
export function Fixed({ size, children }: { size: 'xs' | 'sm'; children: ReactNode }) {
  return <div className={cn('shrink-0', size === 'xs' ? 'w-14' : 'w-28')}>{children}</div>;
}
/** A control under its name. `quiet` for the small parts of one value (city, amount). */
export function Label({
  children,
  htmlFor,
  quiet = false,
}: {
  children: ReactNode;
  htmlFor?: string;
  quiet?: boolean;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        'flex min-w-0 flex-col',
        quiet
          ? 'gap-1 text-xs font-medium text-muted-foreground [&>*]:text-foreground'
          : 'gap-1.5 text-sm font-medium',
      )}
    >
      {children}
    </label>
  );
}
/** A checkbox (or radio) beside its label, on one line. */
export function CheckLabel({ children }: { children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child.
    <label className="flex min-w-0 flex-1 items-center gap-2 text-sm [&>span]:truncate">
      {children}
    </label>
  );
}
/** Text cut to one line with an ellipsis, inside a button or row. */
export function Truncate({ children }: { children: ReactNode }) {
  return <span className="min-w-0 truncate">{children}</span>;
}
export function Muted({ children, small = false }: { children: ReactNode; small?: boolean }) {
  return (
    <span className={cn('text-muted-foreground', small ? 'text-xs' : 'text-sm')}>{children}</span>
  );
}
/** A short note inside a button, after its label, in the button's own colour: "Last used". */
export function ButtonNote({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-sm border border-current/30 px-1.5 py-px text-xs font-normal opacity-80">
      {children}
    </span>
  );
}
/** With `onDismiss`, a close button sits at its end. */
export function Notice({
  children,
  error = false,
  onDismiss,
}: {
  children: ReactNode;
  error?: boolean;
  onDismiss?: () => void;
}) {
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm',
        error
          ? 'border-destructive/30 text-destructive'
          : 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {onDismiss ? (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="-my-0.5 shrink-0 rounded-md p-0.5 hover:bg-hover"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}
/** A wait the whole page is in, such as the first load: the mark turning, and what is happening in words. */
export function Loading({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="flex items-center gap-3 text-sm text-muted-foreground">
      <LogoMark mood="working" size={32} />
      <span>{children}</span>
    </div>
  );
}
/**
 * The app starting: only the mark, turning in the middle of the page.
 * index.html shows the same before the scripts load, and each splash turns in
 * step with the one before, so the wait reads as one motion.
 */
export function Splash({ label }: { label: string }) {
  const [phase] = useState(() => `${-(performance.now() % CYCLE.working.ms)}ms`);
  return (
    <div
      role="status"
      className="retainer-splash"
      style={{ '--splash-phase': phase } as CSSProperties}
    >
      <LogoMark mood="working" size={40} label={label} />
    </div>
  );
}
/**
 * One control in a form: its name, an optional hint beside it and an error
 * under it. Not a `<label>`, because some inputs hold several controls that
 * carry their own accessible names.
 */
export function FormField({
  label,
  apiName,
  hint,
  error,
  children,
}: {
  label: string;
  /** Developer view: the API name, shown beside the label. */
  apiName?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-sm font-medium">
        <span>
          {label}
          {apiName ? <ApiName>{apiName}</ApiName> : null}
        </span>
        {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
      </div>
      {children}
      {error ? <span className="text-xs font-normal text-destructive">{error}</span> : null}
    </div>
  );
}

/**
 * A screen: a slim top bar with breadcrumb and actions, then the content.
 * `layout="fill"` gives the content the rest of the viewport with no padding,
 * for grids that scroll on their own.
 */
export function Page({
  eyebrow,
  title,
  apiName,
  description,
  actions,
  layout = 'default',
  children,
}: {
  eyebrow?: string;
  title: string;
  /** Developer view: the API name, shown beside the title. */
  apiName?: string;
  actions?: ReactNode;
  children: ReactNode;
} & ({ layout?: 'default'; description?: string } | { layout: 'fill'; description?: never })) {
  const openNavigation = useContext(NavigationContext);
  const fill = layout === 'fill';
  return (
    <section className={cn('flex flex-col', fill ? 'h-dvh' : 'min-h-dvh')}>
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur md:px-5">
        {openNavigation ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            className="-ml-1 md:hidden"
            onClick={openNavigation}
          >
            <Menu size={16} />
          </Button>
        ) : null}
        <div className="flex min-w-0 items-center gap-1.5 text-sm">
          {eyebrow ? (
            <>
              <span className="hidden max-w-48 truncate text-muted-foreground first-letter:uppercase sm:inline-block">
                {eyebrow}
              </span>
              <ChevronRight
                size={14}
                aria-hidden
                className="hidden shrink-0 text-muted-foreground/60 sm:inline"
              />
            </>
          ) : null}
          {fill ? (
            <h1 className="truncate font-medium">{title}</h1>
          ) : (
            <span className="truncate font-medium">{title}</span>
          )}
          {apiName ? <ApiName>{apiName}</ApiName> : null}
        </div>
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {fill ? (
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 md:px-8 md:py-8">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description ? (
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {children}
        </div>
      )}
    </section>
  );
}
/** Padded area inside a `fill` page, for notices and empty states. */
export function Inset({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 p-3 md:px-5">{children}</div>;
}
export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      {title ? (
        <h2 className="border-b border-border px-4 py-2.5 text-sm font-medium">{title}</h2>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}
/** `quiet` drops the frame, for a tab that is empty inside a panel or a sheet. */
export function Empty({
  title,
  description,
  quiet = false,
}: {
  title: string;
  description?: string;
  quiet?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        quiet ? 'px-4 py-10' : 'min-h-48 rounded-lg border border-dashed border-border p-8',
      )}
    >
      <Inbox size={24} strokeWidth={1.4} className="mb-3 text-muted-foreground" />
      <h2 className="text-sm font-medium">{title}</h2>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
/**
 * Tabs in a row that scrolls sideways when narrow, keeping the current one in
 * view. Every label has one weight, so switching moves nothing. `sticky` keeps
 * the row on screen while what is under it scrolls; `--sticky-top` is the height
 * of what it sticks under (the page's header, unless a `Sheet` says otherwise).
 * A tab's `hint` says in plain words what it holds: an info button beside the
 * tabs shows the current tab's, in view however far they scroll.
 */
export function Tabs({
  items,
  value,
  onChange,
  sticky = false,
  ref,
}: {
  items: { value: string; label: string; count?: number; hint?: string }[];
  value: string;
  onChange: (v: string) => void;
  sticky?: boolean;
  ref?: Ref<HTMLElement>;
}) {
  const bar = useRef<HTMLDivElement>(null),
    row = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => bar.current as HTMLElement);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the current tab, read from the DOM, is what changed.
  useLayoutEffect(() => {
    const nav = row.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current) return;
    const left = current.offsetLeft - nav.offsetLeft;
    const right = left + current.offsetWidth;
    if (left < nav.scrollLeft) nav.scrollLeft = left;
    else if (right > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = right - nav.clientWidth;
  }, [value]);
  const current = items.find((i) => i.value === value);
  return (
    <div
      ref={bar}
      className={cn(
        'flex border-b border-border',
        sticky && 'sticky top-[var(--sticky-top,3rem)] z-20 bg-background',
      )}
    >
      <nav
        ref={row}
        aria-label="Sections"
        className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]"
      >
        {items.map((i) => (
          <button
            type="button"
            key={i.value}
            aria-current={value === i.value ? 'page' : undefined}
            onClick={() => onChange(i.value)}
            className={cn(
              '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-2.5 py-2 text-sm font-medium',
              value === i.value
                ? 'border-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {i.label}
            {i.count !== undefined ? <Badge>{i.count}</Badge> : null}
          </button>
        ))}
      </nav>
      {current?.hint ? (
        <span className="flex shrink-0 items-center pl-2 pr-1 text-muted-foreground hover:text-foreground">
          <Tooltip content={current.hint}>
            <Info size={13} aria-label={`About ${current.label}`} />
          </Tooltip>
        </span>
      ) : null}
    </div>
  );
}
/**
 * Links to the record page, or with `inSheet` opens it in the current list's sheet
 * (`?record=`). `struck` is for a record that no longer needs doing, such as a done task.
 */
export function RecordLink({
  id,
  inSheet = false,
  struck = false,
  children,
}: {
  id: string;
  inSheet?: boolean;
  struck?: boolean;
  children: ReactNode;
}) {
  const className = cn(
    'min-w-0 max-w-full truncate font-medium',
    struck ? 'text-muted-foreground line-through' : 'hover:underline',
  );
  return inSheet ? (
    <Link
      to="."
      search={(prev: Record<string, unknown>) => ({ ...prev, record: id })}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link to="/r/$id" params={{ id }} className={className}>
      {children}
    </Link>
  );
}
/** Links to the event page. `title` for a row's own name, styled as a record's link is. */
export function EventLink({
  id,
  title = false,
  children,
}: {
  id: string;
  title?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      to="/e/$id"
      params={{ id }}
      className={
        title
          ? 'min-w-0 font-medium [overflow-wrap:anywhere] hover:underline'
          : 'text-sm text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground'
      }
    >
      {children}
    </Link>
  );
}
export function ReviewLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Link
      to="/"
      search={{ assertion: id }}
      className="text-xs text-amber-700 underline dark:text-amber-300"
    >
      {children}
    </Link>
  );
}
export function ObjectLink({
  object,
  filter,
  children,
}: {
  object: string;
  filter?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to="/o/$object"
      params={{ object }}
      search={{ filter }}
      className="text-sm text-muted-foreground hover:underline"
    >
      {children}
    </Link>
  );
}
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^https?:\/\//i.test(href);
  return safe ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      {children}
      <ArrowUpRight size={12} />
    </a>
  ) : (
    <span>{children}</span>
  );
}
export { Tooltip };
export function Sourced({ children }: { children: ReactNode }) {
  return <span className="underline decoration-dotted underline-offset-4">{children}</span>;
}
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-xs" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(94vw,42rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-auto rounded-lg border border-border bg-background p-5 shadow-xl">
          <DialogPrimitive.Title className="pr-6 text-base font-semibold">
            {title}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description
            className={description ? 'text-sm text-muted-foreground' : 'sr-only'}
          >
            {description ?? title}
          </DialogPrimitive.Description>
          <DialogPrimitive.Close asChild>
            <button
              type="button"
              aria-label="Close"
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-hover"
            >
              <X size={16} />
            </button>
          </DialogPrimitive.Close>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
/** A small static table inside a page. Record lists use `DataGrid`. */
export function Table({
  headers,
  children,
}: {
  headers: { label: string; align?: 'center' }[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-auto rounded-lg border border-border">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            {headers.map((h, i) => (
              <th
                key={h.label}
                className={cn(
                  'h-9 whitespace-nowrap border-b border-border bg-muted/50 px-3 font-medium',
                  i === 0 && 'sticky left-0 z-10 bg-muted',
                  h.align === 'center' && 'text-center',
                )}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr:last-child>td]:border-b-0">{children}</tbody>
      </table>
    </div>
  );
}
/**
 * A table row. With `onOpen`, a plain click anywhere on the row opens it
 * (controls inside keep their own clicks); `selected` keeps it highlighted.
 */
export function Tr({
  children,
  onOpen,
  selected = false,
  onClick,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { onOpen?: () => void; selected?: boolean }) {
  return (
    <tr
      {...props}
      data-selected={selected || undefined}
      onClick={(e) => {
        onClick?.(e);
        if (onOpen && isPlainClick(e)) onOpen();
      }}
      className={cn('group', onOpen && 'cursor-pointer')}
    >
      {children}
    </tr>
  );
}
export function Td({
  children,
  first = false,
  align = 'left',
}: {
  children: ReactNode;
  first?: boolean;
  align?: 'left' | 'center';
}) {
  return (
    <td
      className={cn(
        'max-w-72 border-b border-border px-3 py-2 align-top',
        first && 'sticky left-0 bg-card font-medium',
        ROW_STATE,
        align === 'center' && 'text-center',
      )}
    >
      {children}
    </td>
  );
}
export {
  Board,
  BoardCard,
  BoardColumn,
  type CardField,
  CardPreview,
  ColumnMore,
  ColumnNote,
} from './board.js';
export {
  CalendarDay,
  CalendarEntry,
  CalendarHeader,
  EntryPreview,
  MonthGrid,
  MoreEntries,
} from './calendar.js';
export { Badge, type Tone } from './core.js';
export {
  DataGrid,
  EditableCell,
  FilterChip,
  FooterButton,
  GridFooter,
  type GridSelection,
  Toolbar,
} from './data-grid.js';
export {
  DiagramDashedKey,
  type DiagramEdge,
  type DiagramEnd,
  DiagramKey,
  type DiagramNode,
} from './diagram-parts.js';
export { DragArea } from './drag.js';
export {
  Entry,
  EntryComposer,
  EntryDay,
  EntryList,
  EntryLoading,
  EntryName,
  EntryQuote,
  EntryText,
  EntryTime,
  LoadMore,
  TabPanel,
  useTabAnchor,
} from './entry.js';
export { FeedDay, FeedItem, FeedLinks, FeedScroll } from './feed.js';
export { type FitItem, FitList, fitCount } from './fit-list.js';
/** React Flow and dagre are heavy, so the canvas loads on first render; wrap it in Suspense. */
export const Diagram = lazy(() => import('./diagram.js').then((m) => ({ default: m.Diagram })));
export {
  ApiName,
  CardGrid,
  Check,
  Code,
  CopyButton,
  EntityHeader,
  JsonBlock,
  NavItem,
  NavList,
  SplitView,
  TextButton,
  Timeline,
  TimelineItem,
} from './layout.js';
export { LogoMark, type LogoMood } from './logo-mark.js';
export { Menu, MenuAction, MenuCheck, MenuChoice, MenuChoices, MenuSeparator } from './menu.js';
export {
  IconLabel,
  OptionList,
  type PickerOption,
  Segmented,
  SelectMenu,
  toggleValue,
} from './picker.js';
export {
  Form,
  MenuItem,
  MenuLabel,
  MenuList,
  PanelBody,
  PanelFooter,
  PanelHeader,
  Popover,
} from './popover.js';
export { Property, PropertyEditor, PropertyList, Section } from './property.js';
export { Sheet } from './sheet.js';
export { activityIcon, objectIcon, Shell } from './shell.js';
export { ItemCard, ItemCards, StepActions, StepFlow, StepHeader } from './steps.js';
export function SignInFrame({
  subtitle = 'Sign in with your personal API key.',
  children,
}: {
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <section className="w-full max-w-sm rounded-lg border border-border bg-card p-8 shadow-xs">
        <div className="mb-8 flex items-center gap-2 text-lg font-semibold">
          <BrandMark className="h-8 w-8" />
          Retainer
        </div>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">
          Your agents remember.
          <br />
          You stay in control.
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">{subtitle}</p>
        {children}
      </section>
    </main>
  );
}
