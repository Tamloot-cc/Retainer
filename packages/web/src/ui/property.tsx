import { DismissableLayer } from '@radix-ui/react-dismissable-layer';
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react';
import { cn, focusFirst, isPlainClick, PANEL } from './core.js';
import { ApiName } from './layout.js';
import { PanelBody } from './popover.js';

/** A titled group on a record: fields, relations. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function PropertyList({ children }: { children: ReactNode }) {
  return <dl className="-mx-2 flex flex-col">{children}</dl>;
}

/**
 * One field of a record: label, then value (`children`). With `onEdit`,
 * clicking the value starts editing; `actions` (edit, history) appear on
 * hover or focus. When `editor` is given it replaces the value and takes the
 * row's full width.
 */
export function Property({
  label,
  apiName,
  actions,
  onEdit,
  editor,
  children,
}: {
  label: string;
  /** Developer view: the API name, shown beside the label. */
  apiName?: string;
  actions?: ReactNode;
  onEdit?: () => void;
  editor?: ReactNode;
  children?: ReactNode;
}) {
  function click(e: ReactMouseEvent) {
    if (onEdit && isPlainClick(e)) onEdit();
  }
  return (
    <div
      className={cn(
        'group/property grid items-start gap-x-3 rounded-md px-2 py-1',
        editor ? 'grid-cols-1 gap-y-1.5 py-2' : 'grid-cols-[minmax(6rem,10rem)_minmax(0,1fr)]',
      )}
    >
      <dt className={cn('truncate text-sm text-muted-foreground', !editor && 'py-1.5')}>
        {label}
        {apiName ? <ApiName>{apiName}</ApiName> : null}
      </dt>
      <dd className="m-0 min-w-0">
        {editor ?? (
          <div className="flex min-h-8 items-start gap-1">
            {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: a pointer shortcut; the Edit button is the keyboard path. */}
            <div
              onClick={click}
              className={cn(
                'min-w-0 flex-1 rounded-md px-2 py-1.5 text-sm [overflow-wrap:anywhere]',
                onEdit && 'cursor-text hover:bg-hover',
              )}
            >
              {children}
            </div>
            {actions ? (
              <div className="flex shrink-0 items-center py-0.5 transition-opacity md:opacity-0 md:focus-within:opacity-100 md:group-hover/property:opacity-100">
                {actions}
              </div>
            ) : null}
          </div>
        )}
      </dd>
    </div>
  );
}

export type EditorHandlers = { outside: () => void; cancel: () => void };
/**
 * Given by a layer an editor opens in (a grid cell's popover): the editor
 * keeps what a click outside and Escape mean in this ref, and the layer calls
 * those instead of closing on its own. The layer may get Escape first, since
 * it can be the topmost dismissable layer when both mount together.
 */
export const EditorHostContext = createContext<RefObject<EditorHandlers | null> | null>(null);

/**
 * The editing state of a `Property`: a small form that focuses its first
 * control, saves on Enter in a text box (or ⌘/Ctrl+Enter anywhere in it) and
 * cancels on Escape. A click outside it calls `onOutside`, by default
 * cancelling. It is its own dismissable layer, so Escape reaches it before an
 * enclosing sheet or dialog, wherever focus is inside it.
 *
 * `kind="picker"` is for a list to choose from: no padding, so the search box
 * and options run to the edges. `footer` (at the end) and `footerStart` sit
 * in a bar under the body.
 */
export function PropertyEditor({
  kind = 'form',
  onSave,
  onCancel,
  onOutside,
  footer,
  footerStart,
  busy = false,
  children,
}: {
  kind?: 'form' | 'picker';
  onSave: () => void;
  onCancel: () => void;
  onOutside?: () => void;
  footer?: ReactNode;
  footerStart?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const outside = onOutside ?? onCancel;
  const host = useContext(EditorHostContext);
  // Keep the host's handlers current; drop them when the editor goes.
  useLayoutEffect(() => {
    if (host) host.current = { outside, cancel: onCancel };
  });
  useLayoutEffect(
    () => () => {
      if (host) host.current = null;
    },
    [host],
  );
  useLayoutEffect(() => focusFirst(form.current), []);
  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    // React bubbles keys from portals (a picker opened inside) through here.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    const inTextBox =
      e.target instanceof HTMLInputElement && !['checkbox', 'radio'].includes(e.target.type);
    if (e.metaKey || e.ctrlKey || inTextBox) {
      e.preventDefault();
      onSave();
    }
  }
  return (
    <DismissableLayer
      asChild
      onEscapeKeyDown={onCancel}
      onPointerDownOutside={host ? undefined : outside}
    >
      <form
        ref={form}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        className={cn(PANEL, 'flex min-w-0 flex-col overflow-hidden')}
      >
        {kind === 'form' ? <PanelBody>{children}</PanelBody> : children}
        {footer || footerStart ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-1 border-t border-border px-2 py-1.5">
            {footerStart ? <div className="mr-auto flex items-center">{footerStart}</div> : null}
            {footer}
          </div>
        ) : null}
      </form>
    </DismissableLayer>
  );
}
