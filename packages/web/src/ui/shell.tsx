import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  Box,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  ChevronsUpDown,
  CircleCheck,
  Eye,
  FileSignature,
  FileText,
  FolderKanban,
  Handshake,
  House,
  Inbox,
  LogOut,
  type LucideIcon,
  MessageSquareDot,
  MessageSquareMore,
  MessageSquareQuote,
  MessageSquareText,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Puzzle,
  Search,
  Settings,
  Shapes,
  SquarePen,
  UserCog,
  UserRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { BrandMark } from './brand.js';
import { cn, Kbd, NavigationContext } from './core.js';
import { Menu, MenuAction, MenuCheck, MenuChoice, MenuChoices, MenuSeparator } from './menu.js';

const COLLAPSED_KEY = 'retainer:sidebar:collapsed';

/** Icons for the objects the built-in templates define; any other object gets a box. */
const OBJECT_ICONS: Record<string, LucideIcon> = {
  person: UserRound,
  company: Building2,
  deal: Handshake,
  task: CircleCheck,
  project: FolderKanban,
  property: House,
  viewing: Eye,
  job: BriefcaseBusiness,
  application: FileText,
  proposal: FileSignature,
  appointment: CalendarDays,
};
/**
 * Event types draw from one family (squared speech marks), so Activity reads
 * apart from Records at a glance; any other event type gets the plain one.
 */
const EVENT_ICONS: Record<string, LucideIcon> = {
  conversation: MessagesSquare,
  note: SquarePen,
  meeting: MessageSquareMore,
  call: MessageSquareDot,
  email: MessageSquareText,
  message: MessageSquareText,
};
const EVENT_ICON = MessageSquareQuote;

/** The icon for an object or event type, by its singular API name and class. */
export const objectIcon = (name: string, objectClass: 'entity' | 'event' = 'entity'): LucideIcon =>
  objectClass === 'event' ? (EVENT_ICONS[name] ?? EVENT_ICON) : (OBJECT_ICONS[name] ?? Box);
/** The icon for the workspace-wide activity feed. */
export const activityIcon = Activity;

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
  return (
    <NavigationContext.Provider value={() => setDrawer(true)}>
      <div className="flex min-h-dvh bg-background text-foreground">
        <aside
          className={cn(
            'sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-150 md:flex',
            collapsed ? 'w-[52px]' : 'w-60',
          )}
        >
          <Sidebar {...props} collapsed={collapsed} onToggle={toggle} />
        </aside>
        <DialogPrimitive.Root open={drawer} onOpenChange={setDrawer}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/35 md:hidden" />
            <DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col border-r border-border bg-sidebar shadow-xl md:hidden">
              <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                Records, activity, review inbox and schema
              </DialogPrimitive.Description>
              <Sidebar
                {...props}
                collapsed={false}
                onNavigate={() => setDrawer(false)}
                onSearch={() => {
                  setDrawer(false);
                  props.onSearch();
                }}
              />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </NavigationContext.Provider>
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
  onNavigate,
}: Omit<ShellProps, 'children'> & {
  collapsed: boolean;
  onToggle?: () => void;
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
                className="-ml-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                <MenuAction onSelect={accounts.onNewWorkspace}>
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
      </div>
      <nav
        aria-label="Main navigation"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden p-2"
      >
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
          to="/"
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
          <NavLink
            to="/activity"
            icon={activityIcon}
            label="All activity"
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
          {objectLinks('event')}
        </NavGroup>
        <div className="flex-1" />
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
          'flex shrink-0 items-center gap-2 border-t border-border p-2',
          collapsed ? 'flex-col' : '',
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
                'flex min-w-0 items-center gap-2 rounded-md text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
              <MenuAction onSelect={accounts.onSettings}>
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
    'relative flex h-8 shrink-0 items-center gap-2.5 rounded-md text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    'data-[status=active]:bg-hover data-[status=active]:font-medium data-[status=active]:text-foreground',
    collapsed ? 'mx-auto w-8 justify-center' : 'px-2',
  );

function NavLink({
  to,
  params,
  icon: Icon,
  label,
  collapsed,
  exact = false,
  onNavigate,
  children,
}: {
  to: '/' | '/o/$object' | '/schema' | '/activity' | '/extensions';
  params?: { object: string };
  icon: LucideIcon;
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
      <Icon size={16} className="shrink-0" />
      {collapsed ? null : <span className="truncate">{label}</span>}
      {children}
    </Link>
  );
}
