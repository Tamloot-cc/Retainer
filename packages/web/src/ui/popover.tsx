import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronLeft } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { cn, focusFirst, PANEL, PLACEMENT } from './core.js';

/**
 * An anchored panel for small forms and lists (filters, sort, columns), made
 * of `PanelHeader`, lists and `PanelBody` / `PanelFooter` that run to its edges.
 */
export function Popover({
  trigger,
  label,
  open,
  onOpenChange,
  align = 'start',
  children,
}: {
  trigger: ReactNode;
  label: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label={label}
          align={align}
          {...PLACEMENT}
          className={cn(
            PANEL,
            'flex max-h-[min(var(--radix-popover-content-available-height),32rem)] w-[min(92vw,18rem)] flex-col overflow-hidden',
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** A form laid out for popovers and dialogs; `autoFocus` focuses its first control. */
export function Form({
  onSubmit,
  autoFocus = false,
  className,
  children,
}: {
  onSubmit: () => void;
  autoFocus?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  useLayoutEffect(() => {
    if (autoFocus) focusFirst(form.current);
  }, [autoFocus]);
  return (
    <form
      ref={form}
      className={cn('flex flex-col gap-3', className)}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** The top of a flush panel: a title, a way back and an action at the end. */
export function PanelHeader({
  title,
  back,
  action,
}: {
  title: ReactNode;
  back?: { label: string; onClick: () => void };
  action?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
      {back ? (
        <button
          type="button"
          aria-label={back.label}
          onClick={back.onClick}
          className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft size={14} />
        </button>
      ) : null}
      <span
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-medium',
          !back && 'pl-1.5',
        )}
      >
        {title}
      </span>
      {action}
    </div>
  );
}
/** A part of a flush panel with padding of its own. */
export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 p-3">{children}</div>;
}
/** A bar of controls at the bottom of a flush panel. */
export function PanelFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-2">
      {children}
    </div>
  );
}

/** A small heading over a group in a `MenuList`. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <li
      role="presentation"
      className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground first:pt-1"
    >
      {children}
    </li>
  );
}
export function MenuList({ children }: { children: ReactNode }) {
  return <ul className="flex flex-col overflow-y-auto p-1">{children}</ul>;
}
/** A row in a list: its controls, with `actions` showing on hover or focus. */
export function MenuItem({
  children,
  actions,
  muted = false,
}: {
  children: ReactNode;
  actions?: ReactNode;
  muted?: boolean;
}) {
  return (
    <li
      className={cn(
        'group/item flex h-8 shrink-0 items-center gap-1 rounded-md px-2 hover:bg-hover',
        muted && 'text-muted-foreground',
      )}
    >
      {children}
      {actions ? (
        <span className="flex shrink-0 items-center md:opacity-0 md:group-focus-within/item:opacity-100 md:group-hover/item:opacity-100">
          {actions}
        </span>
      ) : null}
    </li>
  );
}
