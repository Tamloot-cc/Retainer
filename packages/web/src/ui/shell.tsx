import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Link } from '@tanstack/react-router';
import {
  ChevronsUpDown,
  House,
  Inbox,
  LogOut,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  Search,
  Settings,
  Shapes,
  UserCog,
  Workflow,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { BrandMark } from './brand.js';
import { type CategoryColor, objectColor } from './colors.js';
import { cn, Kbd, NavigationContext } from './core.js';
import { Menu, MenuAction, MenuCheck, MenuChoice, MenuChoices, MenuSeparator } from './menu.js';
import { objectIcon } from './object-icons.js';

const COLLAPSED_KEY = 'retainer:sidebar:collapsed';
const WIDTH_KEY = 'retainer:sidebar:width';
const MIN_WIDTH = 192;
const DEFAULT_WIDTH = 240;
const MAX_WIDTH = 400;
const clampWidth = (width: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));

export { objectIcon } from './object-icons.js';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

type ShellObject = { name: string; label: string; class: 'entity' | 'event' };
type ShellProps = {
  workspace: string;
  /** Under the name: the role or key type. */
  user: { name: string; detail: string };
  /**
   * Accounts mode: the workspaces to switch between (each a full page load),
   * creating one, Settings and Your account.
   */
  accounts?: {
    workspaces: { id: string; name: string; href: string; current: boolean }[];
    onNewWorkspace?: () => void;
    onSettings: () => void;
    accountHref: string;
  };
  /** Entities are listed under Records, event types under Activity. */
  objects: ShellObject[];
  inboxCount?: number;
  /** Developer view, switched from the account menu. */
  developer: boolean;
  onDeveloperChange: (on: boolean) => void;
  onSignOut: () => void;
  onSearch: () => void;
  children: ReactNode;
};

export function Shell({ children, ...props }: ShellProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed),
    [drawer, setDrawer] = useState(false);
  const drawerClose = useRef<HTMLButtonElement>(null);
  const toggle = () => setCollapsed((c) => !c);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* Collapse still works for this visit. */
    }
  }, [collapsed]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!drawer) return;
    // Match the md breakpoint where the desktop sidebar takes over.
    const desktop = window.matchMedia('(min-width: 48rem)');
    const dismiss = () => {
      if (desktop.matches) setDrawer(false);
    };
    desktop.addEventListener('change', dismiss);
    dismiss();
    return () => desktop.removeEventListener('change', dismiss);
  }, [drawer]);
  return (
    <NavigationContext.Provider value={true}>
      <DialogPrimitive.Root open={drawer} onOpenChange={setDrawer}>
        <div className="flex min-h-dvh bg-frame text-foreground md:[--workspace-bottom-inset:0.5rem] md:[--workspace-footer-height:4rem]">
          <DesktopSidebar collapsed={collapsed}>
            <Sidebar {...props} collapsed={collapsed} onToggle={toggle} />
          </DesktopSidebar>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35 md:hidden" />
            <DialogPrimitive.Content
              className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-border bg-sidebar shadow-xl md:hidden"
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                drawerClose.current?.focus({ preventScroll: true });
              }}
              onCloseAutoFocus={(event) => {
                // Search or another dialog may already have taken focus.
                if (document.activeElement !== document.body) event.preventDefault();
              }}
            >
              <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Records, activity, review inbox and schema
              </DialogPrimitive.Description>
              <Sidebar
                {...props}
                collapsed={false}
                headerAction={
                  <DialogPrimitive.Close
                    ref={drawerClose}
                    aria-label="Close navigation"
                    className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <X size={16} />
                  </DialogPrimitive.Close>
                }
                onNavigate={() => setDrawer(false)}
                onSearch={() => {
                  setDrawer(false);
                  props.onSearch();
                }}
              />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
          <main className="min-w-0 flex-1 bg-background md:mb-[var(--workspace-bottom-inset)] md:mr-2 md:overflow-clip md:rounded-b-xl md:rounded-tl-xl md:ring-1 md:ring-inset md:ring-border md:[--page-height:calc(100dvh-var(--workspace-bottom-inset))]">
            {children}
          </main>
        </div>
      </DialogPrimitive.Root>
    </NavigationContext.Provider>
  );
}

function DesktopSidebar({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  const id = useId();
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(saved) && saved > 0) return clampWidth(saved);
    } catch {
      /* Storage can be unavailable. */
    }
    return DEFAULT_WIDTH;
  });
  const dragOffset = useRef(0);

  function saveWidth(value: number) {
    const next = clampWidth(value);
    setWidth(next);
    try {
      localStorage.setItem(WIDTH_KEY, String(next));
    } catch {
      /* Resizing still works for this visit. */
    }
  }

  return (
    <aside
      id={id}
      style={{ width: collapsed ? 52 : width }}
      className="sticky top-0 hidden h-dvh shrink-0 flex-col bg-sidebar transition-[width] duration-150 has-[[role=separator]:active]:duration-0 motion-reduce:transition-none md:flex"
    >
      {children}
      {collapsed ? null : (
        // biome-ignore lint/a11y/useSemanticElements: a keyboard-adjustable splitter has no native element.
        <div
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-controls={id}
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={width}
          aria-valuetext={`${width} pixels`}
          tabIndex={0}
          title="Resize sidebar"
          className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none select-none border-r-2 border-transparent hover:border-primary/50 focus-visible:border-primary focus-visible:outline-none active:border-primary"
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary) return;
            dragOffset.current = width - e.clientX;
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.currentTarget.focus();
          }}
          onPointerMove={(e) => {
            if (e.isPrimary && e.currentTarget.hasPointerCapture(e.pointerId))
              setWidth(clampWidth(e.clientX + dragOffset.current));
          }}
          onPointerUp={(e) => {
            if (e.isPrimary && e.currentTarget.hasPointerCapture(e.pointerId))
              saveWidth(e.clientX + dragOffset.current);
          }}
          onPointerCancel={(e) => {
            if (e.isPrimary) saveWidth(width);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            saveWidth(width + (e.key === 'ArrowRight' ? 16 : -16));
          }}
        />
      )}
    </aside>
  );
}

function Sidebar({
  workspace,
  user,
  accounts,
  objects,
  inboxCount,
  developer,
  onDeveloperChange,
  onSignOut,
  onSearch,
  collapsed,
  onToggle,
  headerAction,
  onNavigate,
}: Omit<ShellProps, 'children'> & {
  collapsed: boolean;
  onToggle?: () => void;
  headerAction?: ReactNode;
  onNavigate?: () => void;
}) {
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  /** A link to each object list of one class: records, or event types under Activity. */
  const objectLinks = (objectClass: ShellObject['class']) =>
    objects
      .filter((o) => o.class === objectClass)
      .map((o) => (
        <NavLink
          key={o.name}
          to="/o/$object"
          params={{ object: o.name }}
          icon={objectIcon(o.name, objectClass)}
          color={objectColor(o.name)}
          label={o.label}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ));
  return (
    <>
      <div
        className={cn(
          'flex h-12 shrink-0 items-center gap-2 border-b border-border',
          collapsed ? 'justify-center' : 'px-3',
        )}
      >
        {collapsed ? null : accounts &&
          (accounts.workspaces.length > 1 || accounts.onNewWorkspace) ? (
          <Menu
            label="Workspaces"
            trigger={
              <button
                type="button"
                aria-label={`Workspace: ${workspace}`}
                className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
              >
                <BrandMark className="h-6 w-6" />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold">{workspace}</span>
                <ChevronsUpDown size={14} className="shrink-0 text-muted-foreground" />
              </button>
            }
          >
            <MenuChoices
              value={accounts.workspaces.find((w) => w.current)?.id ?? ''}
              onChange={(id) => {
                const next = accounts.workspaces.find((w) => w.id === id);
                if (next && !next.current) window.location.assign(next.href);
              }}
            >
              {accounts.workspaces.map((w) => (
                <MenuChoice key={w.id} value={w.id}>
                  {w.name}
                </MenuChoice>
              ))}
            </MenuChoices>
            {accounts.onNewWorkspace ? (
              <>
                <MenuSeparator />
                <MenuAction
                  onSelect={() => {
                    onNavigate?.();
                    accounts.onNewWorkspace?.();
                  }}
                >
                  <Plus size={14} />
                  New workspace
                </MenuAction>
              </>
            ) : null}
          </Menu>
        ) : (
          <>
            <BrandMark className="h-6 w-6" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{workspace}</span>
          </>
        )}
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label={toggleLabel}
            title={`${toggleLabel} (⌘\\)`}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground"
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        ) : null}
        {headerAction}
      </div>
      <nav
        aria-label="Main navigation"
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden overscroll-contain p-2',
          // Keep the scrollbar clear of the desktop resize handle.
          !collapsed && 'md:mr-2 md:pr-0',
        )}
      >
        <NavLink
          to="/"
          icon={House}
          label="Home"
          collapsed={collapsed}
          exact
          onNavigate={onNavigate}
        />
        <button
          type="button"
          onClick={onSearch}
          title={collapsed ? 'Find anything (⌘K)' : undefined}
          className={navItem(collapsed)}
        >
          <Search size={16} />
          <span className={collapsed ? 'sr-only' : 'flex-1 text-left'}>Find anything</span>
          {collapsed ? null : <Kbd>⌘K</Kbd>}
        </button>
        <NavLink
          to="/review"
          icon={Inbox}
          label="Review inbox"
          collapsed={collapsed}
          exact
          onNavigate={onNavigate}
        >
          {inboxCount ? (
            <span
              className={cn(
                'rounded-full bg-primary font-medium tabular-nums text-primary-foreground',
                collapsed
                  ? 'absolute right-1 top-1 h-2 w-2 overflow-hidden text-[0px]'
                  : 'ml-auto px-1.5 text-[11px] leading-4',
              )}
            >
              {inboxCount > 99 ? '99+' : inboxCount}
            </span>
          ) : null}
        </NavLink>
        <NavGroup label="Records" collapsed={collapsed}>
          {objectLinks('entity')}
        </NavGroup>
        <NavGroup label="Activity" collapsed={collapsed}>
          {objectLinks('event')}
        </NavGroup>
        <div className="flex-1" />
        <NavLink
          to="/routines"
          icon={Workflow}
          label="Routines"
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
        <NavLink
          to="/extensions"
          icon={Puzzle}
          label="Extensions"
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
        <NavLink
          to="/schema"
          icon={Shapes}
          label="Schema"
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      </nav>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-t border-border p-2 md:h-[var(--workspace-footer-height)]',
          collapsed ? 'justify-center' : '',
        )}
      >
        <Menu
          label="Account"
          align={collapsed ? 'start' : 'end'}
          trigger={
            <button
              type="button"
              aria-label={`Account: ${user.name}`}
              title={collapsed ? user.name : undefined}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-md text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11',
                collapsed ? 'p-0.5' : 'flex-1 p-1',
              )}
            >
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold"
              >
                {initials(user.name)}
              </span>
              {collapsed ? null : (
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium">{user.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {user.detail}
                    {developer ? ' · Developer view' : ''}
                  </span>
                </span>
              )}
            </button>
          }
        >
          {accounts ? (
            <>
              <MenuAction
                onSelect={() => {
                  onNavigate?.();
                  accounts.onSettings();
                }}
              >
                <Settings size={14} />
                Settings
              </MenuAction>
              <MenuAction onSelect={() => window.location.assign(accounts.accountHref)}>
                <UserCog size={14} />
                Your account
              </MenuAction>
              <MenuSeparator />
            </>
          ) : null}
          <MenuCheck checked={developer} onChange={onDeveloperChange}>
            Developer view
          </MenuCheck>
          <MenuSeparator />
          <MenuAction onSelect={onSignOut}>
            <LogOut size={14} />
            Sign out
          </MenuAction>
        </Menu>
      </div>
    </>
  );
}

/** A labeled group of sidebar links; in the icon rail, its name becomes a divider. */
function NavGroup({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls; these are links.
    <div role="group" aria-label={label} className="flex flex-col gap-0.5">
      {collapsed ? (
        <div aria-hidden className="mx-2 my-2 border-t border-border" />
      ) : (
        <p aria-hidden className="px-2 pb-1 pt-4 text-[11px] font-medium text-muted-foreground">
          {label}
        </p>
      )}
      {children}
    </div>
  );
}

const navItem = (collapsed: boolean) =>
  cn(
    'relative flex h-8 shrink-0 items-center gap-2.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11',
    'data-[status=active]:bg-selection data-[status=active]:font-medium data-[status=active]:text-selection-foreground',
    collapsed ? 'mx-auto w-8 justify-center' : 'px-2',
  );

function NavLink({
  to,
  params,
  icon: Icon,
  color,
  label,
  collapsed,
  exact = false,
  onNavigate,
  children,
}: {
  to: '/' | '/review' | '/o/$object' | '/schema' | '/activity' | '/extensions' | '/routines';
  params?: { object: string };
  icon: LucideIcon;
  color?: CategoryColor;
  label: string;
  collapsed: boolean;
  exact?: boolean;
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  return (
    <Link
      to={to}
      params={params as never}
      activeOptions={{ exact, includeSearch: false }}
      onClick={onNavigate}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={navItem(collapsed)}
    >
      <Icon size={16} data-color={color} className={cn('shrink-0', color && 'category-color')} />
      {collapsed ? null : <span className="truncate">{label}</span>}
      {children}
    </Link>
  );
}
