import { RetainerApiError } from '@retainer/sdk';
import { isOrganizationManager, type Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  lazyRouteComponent,
  Outlet,
  RouterProvider,
  useNavigate,
} from '@tanstack/react-router';
import { lazy, type ReactNode, StrictMode, Suspense, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AccountContext,
  type AccountState,
  allWorkspaces,
  lastWorkspace,
  rememberWorkspace,
  useAccount,
} from './accounts/context.js';
import { capital, withoutSignInError } from './accounts/format.js';
import {
  type Account,
  account as accountApi,
  refreshSession,
  signOutOfAccount,
  workspaceHref,
} from './api/account.js';
import {
  AuthContext,
  api,
  openWorkspace,
  resetSessionTransport,
  useAuth,
  WorkspaceContext,
} from './api/client.js';
import { UpdatingBanner } from './api/maintenance.js';
import { SignIn } from './auth/sign-in.js';
import { CommandPalette } from './routes/command.js';
import { DeveloperContext, readDeveloperView, writeDeveloperView } from './routes/developer.js';
import type { ViewSearch } from './routes/state.js';
import { QueryError, ReportContext, sortObjects } from './routes/state.js';
import { Button, Loading, Notice, Page, Shell } from './ui/index.js';
import './style.css';

const LazyNewWorkspace = lazy(() =>
  import('./accounts/settings.js').then((m) => ({ default: m.NewWorkspaceDialog })),
);

function Layout() {
  const { session, signOut } = useAuth();
  const accountState = useAccount();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [command, setCommand] = useState(false),
    [report, setReport] = useState<ReactNode>(null),
    [developer, setDeveloper] = useState(() => readDeveloperView(() => localStorage));
  const developerView = useMemo(
    () => ({
      on: developer,
      set: (on: boolean) => {
        setDeveloper(on);
        writeDeveloperView(() => localStorage, on);
      },
    }),
    [developer],
  );
  const client = useQueryClient();
  const schema = useQuery({
    queryKey: [session.workspace.id, 'schema'],
    queryFn: async ({ signal }) => {
      const result = await api.schema(signal);
      client.setQueryData([session.workspace.id, 'schema', result.workspace.schemaVersion], result);
      return result;
    },
  });
  const inbox = useQuery({
    queryKey: [session.workspace.id, 'review', 'sidebar-count'],
    queryFn: ({ signal }) => api.review({ limit: 1, signal }),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    const refreshed = (event: Event) => {
      const schema = (event as CustomEvent<import('@retainer/shared').SchemaDescription>).detail;
      if (schema.workspace.id === session.workspace.id) {
        client.setQueryData([session.workspace.id, 'schema'], schema);
        client.setQueryData(
          [session.workspace.id, 'schema', schema.workspace.schemaVersion],
          schema,
        );
      }
    };
    window.addEventListener('retainer:schema-refreshed', refreshed);
    return () => window.removeEventListener('retainer:schema-refreshed', refreshed);
  }, [client, session.workspace.id]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommand((v) => !v);
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  if (!schema.data)
    return (
      <Page title="Retainer">
        {schema.error ? (
          <QueryError error={schema.error} retry={() => void schema.refetch()} />
        ) : (
          <Loading>Loading workspace…</Loading>
        )}
        <Button onClick={signOut}>Sign out</Button>
      </Page>
    );
  const objects = sortObjects(schema.data.objects);
  return (
    <WorkspaceContext.Provider value={{ session, schema: schema.data }}>
      <DeveloperContext.Provider value={developerView}>
        <ReportContext.Provider value={setReport}>
          <Shell
            workspace={session.workspace.name}
            user={{
              name: session.actor.name || session.actor.id,
              detail: accountState
                ? capital(accountState.workspace.role)
                : capital(session.actor.type),
            }}
            {...(accountState
              ? {
                  accounts: {
                    workspaces: allWorkspaces(accountState.account).map(
                      ({ workspace: w, organization: o }) => ({
                        id: w.id,
                        name:
                          accountState.account.organizations.length > 1
                            ? `${w.name} · ${o.name}`
                            : w.name,
                        href: workspaceHref(w.slug),
                        current: w.id === accountState.workspace.id,
                      }),
                    ),
                    ...(isOrganizationManager(accountState.organization.role)
                      ? { onNewWorkspace: () => setCreating(true) }
                      : {}),
                    onSettings: () => void navigate({ to: '/settings' }),
                    accountHref: '/app/account',
                  },
                }
              : {})}
            inboxCount={inbox.data?.totals.pendingAssertions}
            objects={objects.map((o) => ({
              name: o.nameSingular,
              label: o.labelPlural,
              class: o.class,
            }))}
            developer={developer}
            onDeveloperChange={developerView.set}
            onSignOut={signOut}
            onSearch={() => setCommand(true)}
          >
            {session.actor.type !== 'user' ? (
              <Notice>
                This key represents a {session.actor.type}. Sign in with a personal user key to make
                changes.
              </Notice>
            ) : null}
            {report ? <Notice onDismiss={() => setReport(null)}>{report}</Notice> : null}
            <Outlet />
          </Shell>
          <CommandPalette open={command} onOpenChange={setCommand} />
          {accountState && creating ? (
            <Suspense fallback={null}>
              <LazyNewWorkspace
                open={creating}
                onOpenChange={setCreating}
                organizationId={accountState.organization.id}
              />
            </Suspense>
          ) : null}
        </ReportContext.Provider>
      </DeveloperContext.Provider>
    </WorkspaceContext.Provider>
  );
}
function validateSearch(raw: Record<string, unknown>): ViewSearch {
  const result: ViewSearch = {};
  for (const key of [
    'tab',
    'cursor',
    'filter',
    'sort',
    'assertion',
    'record',
    'view',
    'month',
    'object',
    'field',
    'status',
    'fields',
    'tasks',
    'eventTypes',
    'channel',
    'from',
    'to',
    'linked',
    'layout',
  ] as const)
    if (typeof raw[key] === 'string') result[key] = raw[key];
  return result;
}
const rootRoute = createRootRoute({
  component: Layout,
  validateSearch,
  notFoundComponent: () => (
    <Page title="Page not found">
      <Link to="/">Go to the review inbox</Link>
    </Page>
  ),
  errorComponent: ({ error, reset }) => (
    <Page title="Something went wrong">
      <QueryError error={error instanceof Error ? error : new Error(String(error))} retry={reset} />
    </Page>
  ),
});
const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: lazyRouteComponent(() => import('./routes/review/review.js'), 'ReviewPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/sign-in',
    component: lazyRouteComponent(() => import('./routes/review/review.js'), 'ReviewPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/o/$object',
    component: lazyRouteComponent(() => import('./routes/views/objects.js'), 'ObjectPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/activity',
    component: lazyRouteComponent(() => import('./routes/events/activity.js'), 'ActivityPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/r/$id',
    component: lazyRouteComponent(() => import('./routes/records/record.js'), 'RecordPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/e/$id',
    component: lazyRouteComponent(() => import('./routes/events/event.js'), 'EventPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/schema',
    component: lazyRouteComponent(() => import('./routes/schema/schema.js'), 'SchemaPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/extensions',
    component: lazyRouteComponent(() => import('./routes/extensions/list.js'), 'ExtensionsPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/extensions/new/$registration',
    component: lazyRouteComponent(
      () => import('./routes/extensions/setup.js'),
      'ExtensionInstallPage',
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/extensions/$id',
    component: lazyRouteComponent(() => import('./routes/extensions/detail.js'), 'ExtensionPage'),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/extensions/$id/upgrade',
    component: lazyRouteComponent(
      () => import('./routes/extensions/setup.js'),
      'ExtensionUpgradePage',
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/extensions/$id/reconnect',
    component: lazyRouteComponent(
      () => import('./routes/extensions/setup.js'),
      'ExtensionReconnectPage',
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/extensions/$id/mapping',
    component: lazyRouteComponent(
      () => import('./routes/extensions/setup.js'),
      'ExtensionMappingPage',
    ),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: lazyRouteComponent(() => import('./accounts/settings.js'), 'SettingsPage'),
  }),
]);
/**
 * In accounts mode a workspace's pages live under `/app/w/<slug>/`; in key
 * mode under `/app/`. Read once: switching workspaces is a full page load.
 */
const workspaceSlug = /^\/app\/w\/([^/]+)/.exec(window.location.pathname)?.[1];
const router = createRouter({
  routeTree,
  basepath: workspaceSlug ? `/app/w/${workspaceSlug}` : '/app',
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
/** Key mode: today's app, signed in with a personal API key. */
function KeyApp() {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [client, setClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: 'always' },
        },
      }),
  );
  useEffect(() => {
    const controller = new AbortController();
    void api
      .me(controller.signal)
      .then((s) => {
        if (!controller.signal.aborted) setSession(s);
      })
      .catch((e) => {
        if (!controller.signal.aborted && e.status !== 401) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    function expired() {
      void client.cancelQueries();
      client.clear();
      resetSessionTransport();
      setSession(null);
      setLoading(false);
    }
    window.addEventListener('retainer:unauthorized', expired);
    return () => window.removeEventListener('retainer:unauthorized', expired);
  }, [client]);
  function activate(next: Session) {
    setError('');
    void client.cancelQueries();
    client.clear();
    setClient(
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: 'always' },
        },
      }),
    );
    setSession(next);
    resetSessionTransport();
    if (window.location.pathname === '/app/sign-in') window.history.replaceState(null, '', '/app/');
  }
  const signOut = () => {
    void api
      .signOut()
      .then(async () => {
        await client.cancelQueries();
        client.clear();
        resetSessionTransport();
        setSession(null);
        window.history.replaceState(null, '', '/app/sign-in');
      })
      .catch((e) => setError(e.message));
  };
  if (loading)
    return (
      <Page title="Retainer">
        <Loading>Checking session…</Loading>
      </Page>
    );
  return (
    <>
      {error ? <Notice error>{error}</Notice> : null}
      {session ? (
        <QueryClientProvider client={client}>
          <AuthContext.Provider value={{ session, signOut }}>
            <RouterProvider router={router} />
          </AuthContext.Provider>
        </QueryClientProvider>
      ) : (
        <SignIn onSession={activate} />
      )}
    </>
  );
}
const newQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: 'always' } },
  });

/**
 * Accounts mode, inside one workspace: the person's session in it, with the
 * same app as key mode. A role removed mid-visit shows at the next request.
 */
function AccountWorkspaceApp({ state }: { state: AccountState }) {
  const [session, setSession] = useState<Session | null>(null),
    [lost, setLost] = useState(false),
    [error, setError] = useState('');
  const [client] = useState(newQueryClient);
  useEffect(() => {
    const controller = new AbortController();
    api
      .me(controller.signal)
      .then((s) => {
        if (!controller.signal.aborted) setSession(s);
      })
      .catch((e: { status?: number; message: string }) => {
        if (controller.signal.aborted) return;
        if (e.status === 404) setLost(true);
        else if (e.status !== 401) setError(e.message);
      });
    // A session that ended starts the app again, at the sign-in screen.
    const expired = () => window.location.reload();
    window.addEventListener('retainer:unauthorized', expired);
    return () => {
      controller.abort();
      window.removeEventListener('retainer:unauthorized', expired);
    };
  }, []);
  if (lost) return <LazyNoAccess account={state.account} />;
  if (!session)
    return (
      <Page title="Retainer">
        {error ? <Notice error>{error}</Notice> : <Notice>Opening {state.workspace.name}…</Notice>}
      </Page>
    );
  return (
    <QueryClientProvider client={client}>
      <AccountContext.Provider value={state}>
        {error ? <Notice error>{error}</Notice> : null}
        <AuthContext.Provider
          value={{
            session,
            signOut: () => void signOutOfAccount().catch((e: Error) => setError(e.message)),
          }}
        >
          <RouterProvider router={router} />
        </AuthContext.Provider>
      </AccountContext.Provider>
    </QueryClientProvider>
  );
}

const screens = () => import('./accounts/screens.js');
const LazySignIn = lazy(() => screens().then((m) => ({ default: m.AccountSignIn })));
const LazyFirstRun = lazy(() => screens().then((m) => ({ default: m.FirstRun })));
const LazyInvite = lazy(() => screens().then((m) => ({ default: m.InvitePage })));
const LazyNoAccess = lazy(() => screens().then((m) => ({ default: m.NoAccess })));
const oauth = () => import('./accounts/oauth.js');
const LazyOAuthContinue = lazy(() => oauth().then((m) => ({ default: m.OAuthContinue })));
const LazyOAuthConsent = lazy(() => oauth().then((m) => ({ default: m.OAuthConsent })));
const LazyYourAccount = lazy(() =>
  import('./accounts/your-account.js').then((m) => ({ default: m.YourAccount })),
);

/** Which screen a signed-in person sees at this address (accounts spec 5). */
function AccountsApp({ account }: { account: Account }) {
  const path = window.location.pathname;
  const invite = /^\/app\/invite\/([^/]+)/.exec(path)?.[1];
  if (invite) return <LazyInvite token={invite} account={account} />;
  // Connecting an app over OAuth (accounts spec 4.7).
  if (path === '/app/oauth/sign-in') return <LazyOAuthContinue />;
  if (path === '/app/oauth/consent') return <LazyOAuthConsent account={account} />;
  if (path === '/app/account' || path === '/app/account/')
    return <LazyYourAccount account={account} />;
  const reachable = allWorkspaces(account);
  if (workspaceSlug) {
    const here = reachable.find(({ workspace }) => workspace.slug === workspaceSlug);
    if (!here) return <LazyNoAccess account={account} />;
    rememberWorkspace(here.workspace.slug);
    openWorkspace(here.workspace.id);
    return <AccountWorkspaceApp state={{ account, ...here }} />;
  }
  const last = lastWorkspace();
  const next = reachable.find(({ workspace }) => workspace.slug === last) ?? reachable[0];
  if (next) {
    window.location.replace(workspaceHref(next.workspace.slug));
    return null;
  }
  return <LazyFirstRun account={account} />;
}

type Boot =
  | { mode: 'loading' }
  | { mode: 'key' }
  | { mode: 'signed-out' }
  | { mode: 'account'; account: Account }
  | { mode: 'error'; message: string };

/**
 * Starts in the mode the server runs in: `/account` answers 404 in key mode,
 * 401 to a person who is signed out, and the person otherwise.
 */
function App() {
  const [boot, setBoot] = useState<Boot>({ mode: 'loading' });
  // For the account screens outside a workspace; a workspace brings its own.
  const [accountClient] = useState(newQueryClient);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => document.documentElement.classList.toggle('dark', media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    accountApi.me().then(
      (account) => {
        setBoot({ mode: 'account', account });
        // Not awaited: a failed refresh only means the next load tries again.
        void refreshSession().catch(() => {});
      },
      (e: Error) =>
        setBoot(
          e instanceof RetainerApiError && e.status === 404
            ? { mode: 'key' }
            : e instanceof RetainerApiError && e.status === 401
              ? { mode: 'signed-out' }
              : { mode: 'error', message: e.message },
        ),
    );
  }, []);
  const loading = (
    <Page title="Retainer">
      <Notice>Checking session…</Notice>
    </Page>
  );
  if (boot.mode === 'loading') return loading;
  if (boot.mode === 'key') return <KeyApp />;
  if (boot.mode === 'error')
    return (
      <Page title="Retainer">
        <Notice error>Retainer could not be reached: {boot.message}</Notice>
      </Page>
    );
  return (
    <QueryClientProvider client={accountClient}>
      <Suspense fallback={loading}>
        {boot.mode === 'signed-out' ? (
          // Connecting an app keeps its whole address, signed parameters and
          // all, but not the error of a sign-in that failed.
          <LazySignIn
            {...(window.location.pathname.startsWith('/app/oauth/')
              ? { returnTo: window.location.pathname + withoutSignInError(window.location.search) }
              : {})}
          />
        ) : (
          <AccountsApp account={boot.account} />
        )}
      </Suspense>
    </QueryClientProvider>
  );
}

const container = document.getElementById('root');
if (container)
  createRoot(container).render(
    <StrictMode>
      <UpdatingBanner />
      <App />
    </StrictMode>,
  );
