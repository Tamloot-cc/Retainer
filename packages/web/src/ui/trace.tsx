// Adapted from shadcn/ui Trace (MIT); see THIRD_PARTY.md. The Nova style's
// classes are written in place, and left/right are start/end so it mirrors in RTL.
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from './core.js';

/**
 * The steps an agent took, one line each (shadcn/ui Trace). A line can be
 * plain, a link or button wrapping it, or a collapsible that opens to show
 * more, indented under a thin rule.
 */
export function Trace({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="trace"
      className={cn(
        'flex w-full min-w-0 flex-col gap-2',
        // A link or button wrapping a line sizes to the line and shows focus.
        '*:has-[>[data-slot=trace-line]]:flex *:has-[>[data-slot=trace-line]]:w-fit *:has-[>[data-slot=trace-line]]:max-w-full *:has-[>[data-slot=trace-line]]:min-w-0 *:has-[>[data-slot=trace-line]]:rounded-md *:has-[>[data-slot=trace-line]]:text-start *:has-[>[data-slot=trace-line]]:outline-none *:has-[>[data-slot=trace-line]]:focus-visible:ring-2 *:has-[>[data-slot=trace-line]]:focus-visible:ring-ring',
        className,
      )}
      {...props}
    />
  );
}

export type TraceStatus = 'running' | 'error' | 'pending';

/** One step: an icon and a title. `running` shimmers the title; `error` turns it red. */
export function TraceLine({
  className,
  status,
  ...props
}: ComponentProps<'span'> & { status?: TraceStatus }) {
  return (
    <span
      data-slot="trace-line"
      data-status={status}
      className={cn(
        'flex w-fit min-w-0 max-w-full items-center gap-2 text-sm text-muted-foreground transition-colors',
        'in-[a,button]:cursor-pointer in-[a:hover,button:hover]:text-foreground',
        'data-[status=error]:text-destructive data-[status=error]:in-[a:hover,button:hover]:text-destructive',
        'data-[status=pending]:opacity-60 data-[status=running]:*:data-[slot=trace-title]:shimmer',
        className,
      )}
      {...props}
    />
  );
}

export function TraceIcon({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*=size-])]:size-4 [[data-slot=trace-title]~&]:-ms-1',
        className,
      )}
      {...props}
    />
  );
}

export function TraceTitle({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-title"
      dir="auto"
      className={cn('min-w-0 truncate', className)}
      {...props}
    />
  );
}

/** A short detail after the title, like a count or a time. */
export function TraceDescription({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-description"
      className={cn('shrink-0 tabular-nums text-muted-foreground/70', className)}
      {...props}
    />
  );
}

/** A line that opens. Controlled (`open` and `onOpenChange`) or not. */
export function TraceCollapsible({
  className,
  ...props
}: Omit<ComponentProps<typeof Collapsible.Root>, 'asChild'>) {
  return (
    <Collapsible.Root
      data-slot="trace-collapsible"
      className={cn('flex w-full min-w-0 flex-col', className)}
      {...props}
    />
  );
}

export function TraceCollapsibleTrigger({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Collapsible.Trigger>, 'asChild'>) {
  return (
    <Collapsible.Trigger
      data-slot="trace-collapsible-trigger"
      className={cn(
        'group/trace-trigger flex w-fit min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-md text-start text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring has-[[data-status=error]]:text-destructive',
        className,
      )}
      {...props}
    >
      {children}
      <TraceIcon className="motion-safe:transition-transform rtl:-scale-x-100 group-aria-expanded/trace-trigger:rotate-90">
        <ChevronRight />
      </TraceIcon>
    </Collapsible.Trigger>
  );
}

/** What a line opens to, under a thin rule that lines up with the line's icon. */
export function TraceCollapsibleContent({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Collapsible.Content>, 'asChild'>) {
  return (
    <Collapsible.Content
      data-slot="trace-collapsible-content"
      className="min-w-0 overflow-hidden motion-safe:data-[state=open]:animate-collapsible-down motion-safe:data-[state=closed]:animate-collapsible-up"
      {...props}
    >
      <div
        className={cn(
          'mt-2 mb-1 ms-[calc(--spacing(2)-1px)] min-w-0 wrap-break-word border-s border-border ps-4 pe-1 leading-relaxed text-muted-foreground',
          className,
        )}
      >
        {children}
      </div>
    </Collapsible.Content>
  );
}
