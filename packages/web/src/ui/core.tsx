import { type ClassValue, clsx } from 'clsx';
import { createContext, type ReactNode } from 'react';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/** The status colours a badge or a timeline icon can take. */
export type Tone = 'neutral' | 'pending' | 'success' | 'error';

/** The look of every floating panel: popovers, pickers, menus and in-place editors. */
export const PANEL = 'z-50 rounded-lg border border-border bg-popover text-foreground shadow-lg';
/** Where floating panels sit against their trigger. */
export const PLACEMENT = { sideOffset: 4, collisionPadding: 12 } as const;

/** Focuses the first control in `root`, selecting a text box's contents. */
export function focusFirst(root: HTMLElement | null) {
  const first = root?.querySelector<HTMLElement>(
    'input:not([type=hidden]):not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled),[tabindex="0"]',
  );
  first?.focus();
  if (first instanceof HTMLInputElement && first.type === 'text') first.select();
}

/** Hover and selected backgrounds for the cells of a clickable row (`group` on the row). */
export const ROW_STATE = 'group-hover:bg-hover group-data-selected:bg-muted';

/**
 * Whether a click on a clickable area (a grid row, a field value) is meant
 * for the area itself: not on a control inside it, and not ending a text
 * selection. Tooltip triggers (`role="button"`) wrap most values, so they
 * count as the area.
 */
export function isPlainClick(e: { target: EventTarget | null; currentTarget: EventTarget | null }) {
  const target = e.target instanceof Element ? e.target : null;
  // React bubbles events from portals (popovers, dialogs) through their owner;
  // a click in a layer outside this element isn't a click on it.
  if (target && e.currentTarget instanceof Node && !e.currentTarget.contains(target)) return false;
  if (target?.closest('a,button,input,select,textarea,label,[role="switch"]')) return false;
  return !window.getSelection()?.toString();
}

/** Set by the Shell so pages can open the navigation drawer on small screens. */
export const NavigationContext = createContext<(() => void) | null>(null);

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border bg-background px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/** A short label in a box; `tone` colours it by status. */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-px text-xs font-medium',
        tone === 'pending'
          ? 'border-amber-300/40 text-amber-700 dark:text-amber-300'
          : tone === 'success'
            ? 'border-emerald-300/40 text-emerald-700 dark:text-emerald-300'
            : tone === 'error'
              ? 'border-destructive/30 text-destructive'
              : 'border-border text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}
