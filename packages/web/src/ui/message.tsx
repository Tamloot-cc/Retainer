// Adapted from shadcn/ui Message, Bubble and Message Scroller (MIT); see
// THIRD_PARTY.md. The Nova style's classes are written in place, with
// start/end instead of left/right. Scrolling itself is @shadcn/react's.
import { MessageScroller as Scroller } from '@shadcn/react/message-scroller';
import { ArrowDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from './core.js';
import { Button } from './index.js';

/** One turn in a chat. `end` is the person's side. */
export function Message({
  className,
  align = 'start',
  ...props
}: ComponentProps<'div'> & { align?: 'start' | 'end' }) {
  return (
    <div
      data-slot="message"
      data-align={align}
      className={cn(
        'group/message relative flex w-full min-w-0 gap-3 text-sm data-[align=end]:flex-row-reverse',
        className,
      )}
      {...props}
    />
  );
}

export function MessageContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        'flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:items-end',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Actions under a message. On a screen with a pointer they show when the
 * message is hovered or focused, unless `pinned` (the latest reply).
 */
export function MessageFooter({
  className,
  pinned = false,
  ...props
}: ComponentProps<'div'> & { pinned?: boolean }) {
  return (
    <div
      data-slot="message-footer"
      className={cn(
        '-ms-1.5 -mt-1.5 flex min-w-0 max-w-full items-center gap-0.5 text-xs text-muted-foreground group-data-[align=end]/message:-me-1.5 group-data-[align=end]/message:justify-end',
        !pinned &&
          'transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:focus-within:opacity-100',
        className,
      )}
      {...props}
    />
  );
}

/** The person's words in a chat, in a soft box on their side. */
export function Bubble({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="bubble"
      dir="auto"
      className={cn(
        'w-fit min-w-0 max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-3.5 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A chat's scrolling thread (shadcn/ui Message Scroller). It opens at the
 * end, follows a reply while the person stays at the bottom, and settles a
 * new question near the top so its answer streams in under it.
 */
export function MessageScroller({
  className,
  contentClassName,
  children,
  label,
}: {
  className?: string;
  /** The column the messages sit in: its width and padding. */
  contentClassName?: string;
  children: React.ReactNode;
  /** Names the thread for screen readers. */
  label: string;
}) {
  return (
    <Scroller.Provider autoScroll defaultScrollPosition="end">
      <Scroller.Root
        data-slot="message-scroller"
        className={cn('relative flex size-full min-h-0 flex-col overflow-hidden', className)}
      >
        <Scroller.Viewport
          aria-label={label}
          className="size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [scrollbar-width:thin] data-pending-scroll:invisible"
        >
          <Scroller.Content
            className={cn('flex h-max min-h-full flex-col gap-6', contentClassName)}
          >
            {children}
          </Scroller.Content>
        </Scroller.Viewport>
        <Scroller.Button
          direction="end"
          aria-label="Scroll to the latest message"
          className="absolute start-1/2 bottom-4 -translate-x-1/2 rounded-full bg-background shadow-md transition-[translate,scale,opacity] duration-200 rtl:translate-x-1/2 data-[active=false]:pointer-events-none data-[active=false]:translate-y-full data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100"
          render={<Button size="icon" />}
        >
          <ArrowDown size={16} aria-hidden />
        </Scroller.Button>
      </Scroller.Root>
    </Scroller.Provider>
  );
}

/** One message in a `MessageScroller`. The person's messages are anchors. */
export function MessageScrollerItem({ className, ...props }: ComponentProps<typeof Scroller.Item>) {
  return (
    <Scroller.Item
      data-slot="message-scroller-item"
      className={cn(
        'min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]',
        className,
      )}
      {...props}
    />
  );
}
