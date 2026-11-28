import * as MenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import {
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { cn, PANEL, PLACEMENT } from './core.js';

const ITEM =
  'flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-sm outline-none data-highlighted:bg-hover data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:shrink-0';

/**
 * A menu of actions or choices under a trigger: arrow keys move, Enter
 * picks, typing jumps to an item, and Escape closes it.
 */
export function Menu({
  trigger,
  label,
  align = 'start',
  children,
}: {
  trigger: ReactNode;
  label: string;
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  return (
    // Not modal, so a dialog opened from an item gets focus and pointer events.
    <MenuPrimitive.Root modal={false}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          aria-label={label}
          align={align}
          {...PLACEMENT}
          className={cn(
            PANEL,
            'flex max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-44 max-w-[92vw] flex-col overflow-y-auto p-1',
          )}
        >
          {children}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/** An action; `destructive` for one that cannot be undone. */
export function MenuAction({
  onSelect,
  destructive = false,
  children,
}: {
  onSelect: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <MenuPrimitive.Item
      onSelect={onSelect}
      className={cn(ITEM, destructive && 'text-destructive data-highlighted:bg-destructive/10')}
    >
      {children}
    </MenuPrimitive.Item>
  );
}

/**
 * A destination: `children` is one link (the router's `Link`), so it opens in
 * a new tab and copies as a URL like any link.
 */
export function MenuLink({ children }: { children: ReactElement }) {
  return (
    <MenuPrimitive.Item asChild className={ITEM}>
      {children}
    </MenuPrimitive.Item>
  );
}

/** One-of-many choices; the chosen one is checked. */
export function MenuChoices({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <MenuPrimitive.RadioGroup value={value} onValueChange={onChange}>
      {children}
    </MenuPrimitive.RadioGroup>
  );
}
/** `end` is a quiet note or icon after the name, e.g. that only you can see it. */
export function MenuChoice({
  value,
  end,
  children,
}: {
  value: string;
  end?: ReactNode;
  children: ReactNode;
}) {
  return (
    <MenuPrimitive.RadioItem value={value} className={ITEM}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {end ? <span className="flex shrink-0 items-center text-muted-foreground">{end}</span> : null}
      <MenuPrimitive.ItemIndicator>
        <Check size={14} className="text-primary" />
      </MenuPrimitive.ItemIndicator>
    </MenuPrimitive.RadioItem>
  );
}
/**
 * Levels that build on each other, as a slider with a stop for each: the
 * track fills up to the chosen one. Inside a menu, so arrow keys move across
 * the stops as menu items, and picking one leaves the menu open so the
 * slider is seen to move.
 */
export function MenuSteps<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  // Stops sit at the middle of equal columns: the first at half a column in.
  const inset = `${50 / options.length}%`;
  const fill = `${(index / Math.max(1, options.length - 1)) * (100 - 100 / options.length)}%`;
  return (
    <MenuPrimitive.RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const option = options.find((o) => o.value === next);
        if (option) onChange(option.value);
      }}
      className="relative mx-1 mb-1 flex pt-1"
    >
      <span
        aria-hidden
        className="absolute top-[12px] h-0.5 rounded-full bg-muted"
        style={{ left: inset, right: inset }}
      />
      <span
        aria-hidden
        className="absolute top-[12px] h-0.5 rounded-full bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none"
        style={{ left: inset, width: fill }}
      />
      {options.map((o, i) => (
        <MenuPrimitive.RadioItem
          key={o.value}
          value={o.value}
          onSelect={(e) => e.preventDefault()}
          className="group relative flex flex-1 cursor-pointer select-none flex-col items-center gap-1.5 rounded-md px-1.5 pb-1.5 pt-1 text-xs text-muted-foreground outline-none transition-colors data-highlighted:bg-hover data-highlighted:text-foreground data-[state=checked]:font-medium data-[state=checked]:text-foreground pointer-coarse:min-h-11"
        >
          <span
            aria-hidden
            className={cn(
              'size-2.5 rounded-full border-2 transition-colors',
              i <= index ? 'border-primary bg-primary' : 'border-border bg-card',
              'group-data-[state=checked]:ring-4 group-data-[state=checked]:ring-primary/20',
            )}
          />
          <span className="whitespace-nowrap">{o.label}</span>
        </MenuPrimitive.RadioItem>
      ))}
    </MenuPrimitive.RadioGroup>
  );
}
/** A quiet heading over the items that follow it. */
export function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <MenuPrimitive.Label className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
      {children}
    </MenuPrimitive.Label>
  );
}
export function MenuSeparator() {
  return <MenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}

/** Where a menu opened at a point is, and what it is for. */
export type MenuOpening<T> = { x: number; y: number; value: T };
/** What `PointMenu` needs of an opening: where, and the element to give focus back to. */
export type PointMenuOpening = MenuOpening<unknown> & { origin?: Element };

const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const LONG_PRESS = 600;

/**
 * Where a menu at a point is open, kept outside React state so opening and
 * closing it re-renders only the menu (`usePointMenuOpening`), not the
 * surface with every row on it.
 */
type Opening<T> = MenuOpening<T> & { origin: Element };
export type PointMenuStore<T> = {
  get: () => Opening<T> | null;
  /** Opens the menu, or closes it with null. */
  set: (opening: Opening<T> | null) => void;
  subscribe: (listener: () => void) => () => void;
};
function pointMenuStore<T>(): PointMenuStore<T> {
  let opening: Opening<T> | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => opening,
    set: (next) => {
      opening = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
/** The opening in `store`, re-rendering the caller when it opens or closes. */
export function usePointMenuOpening<T>(store: PointMenuStore<T>) {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Opens a menu at the pointer for what `find` reads off the element
 * right-clicked: spread `handlers` on the surface. Where `find` gives
 * nothing, and in inputs, the browser's own menu opens. On touch a long
 * press opens it.
 */
export function usePointMenu<T>(
  find: (element: Element) => T | undefined,
  /** Called as the menu opens, e.g. to select what it acts on. */
  onOpen?: (value: T) => void,
) {
  const [store] = useState(() => pointMenuStore<T>());
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const findRef = useRef({ find, onOpen });
  findRef.current = { find, onOpen };
  const open = useCallback(
    (target: EventTarget | null, x: number, y: number) => {
      if (!(target instanceof Element) || target.closest(EDITABLE)) return false;
      const value = findRef.current.find(target);
      if (value === undefined) return false;
      findRef.current.onOpen?.(value);
      // A menu opened from the keyboard has no pointer: open it at the element.
      if (!x && !y) {
        const box = target.getBoundingClientRect();
        x = box.left + Math.min(box.width, 24);
        y = box.bottom;
      }
      store.set({ x, y, value, origin: target });
      return true;
    },
    [store],
  );
  const cancel = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
  }, []);
  useEffect(() => cancel, [cancel]);
  const handlers = useMemo(
    () => ({
      onContextMenu: (e: ReactMouseEvent) => {
        cancel();
        if (open(e.target, e.clientX, e.clientY)) e.preventDefault();
      },
      onPointerDown: (e: ReactPointerEvent) => {
        cancel();
        press.current = null;
        if (e.pointerType === 'mouse') return;
        const { target, clientX: x, clientY: y } = e;
        const state = { x, y, fired: false, timer: 0 };
        state.timer = window.setTimeout(() => {
          state.fired = open(target, x, y);
        }, LONG_PRESS);
        press.current = state;
      },
      onPointerMove: (e: ReactPointerEvent) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      // The click that ends a long press doesn't also open the record.
      onClickCapture: (e: ReactMouseEvent) => {
        if (!press.current?.fired) return;
        press.current = null;
        e.preventDefault();
        e.stopPropagation();
      },
    }),
    [open, cancel],
  );
  return { store, handlers };
}

/**
 * A menu at a point, for `usePointMenu`: the same items as `Menu`. When it
 * closes without an item moving focus (to a dialog), focus goes back to
 * where the menu was opened.
 */
export function PointMenu({
  opening,
  label,
  onClose,
  children,
}: {
  opening: PointMenuOpening | null;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!opening) return null;
  const origin = opening.origin;
  return (
    <MenuPrimitive.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <MenuPrimitive.Trigger asChild>
        <span
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-0"
          style={{ left: opening.x, top: opening.y }}
        />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          aria-label={label}
          // Named by `label`: the trigger is an empty point.
          aria-labelledby={undefined}
          align="start"
          {...PLACEMENT}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const focused = document.activeElement;
            if (
              origin instanceof HTMLElement &&
              origin.isConnected &&
              (!focused || focused === document.body)
            )
              (origin.closest<HTMLElement>('a, button, [tabindex]') ?? origin).focus();
          }}
          className={cn(
            PANEL,
            'flex max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-48 max-w-[92vw] flex-col overflow-y-auto p-1',
          )}
        >
          {children}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
