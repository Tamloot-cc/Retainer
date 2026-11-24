import { cappedScopes, OAUTH_SCOPES, pinnedWorkspaceOfResources } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Eye, ShieldCheck, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Account, account as accountApi, signOutOfAccount } from '../api/account.js';
import { BrandMark } from '../ui/brand.js';
import { Button, Muted, Notice, Radio, Stack } from '../ui/index.js';
import { allWorkspaces } from './context.js';
import { APP_SCOPE_WORDS, capital, withoutSignInError } from './format.js';
import { NeedWorkspace } from './onboarding.js';
import { AccountFrame } from './screens.js';

/**
 * Connecting an app such as Claude (accounts spec 4.7, 5). The app opens
 * Retainer's authorization page from another site, where the SameSite=Strict
 * session cookie does not arrive, so Better Auth sends the browser to
 * /app/oauth/sign-in. That page's own requests carry the cookie: once it
 * knows the person, it continues the authorization from this site, and
 * Better Auth sends them on to /app/oauth/consent, where they pick the
 * workspace the app may use.
 */

/** The parameters Better Auth signed onto the page's address, which it adds again. */
const SIGNED = ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param'];

/** The original authorization request, without Better Auth's signature. */
function authorizeUrl(search: string): string {
  const query = new URLSearchParams(withoutSignInError(search));
  for (const name of SIGNED) query.delete(name);
  return `/account/auth/oauth2/authorize?${query}`;
}

/** /app/oauth/sign-in for a person already signed in: carry on to consent. */
export function OAuthContinue() {
  useEffect(() => {
    window.location.replace(authorizeUrl(window.location.search));
  }, []);
  return (
    <AccountFrame title="Connecting…">
      <Notice>Taking you to the next step.</Notice>
    </AccountFrame>
  );
}

const hostOf = (url: string | null): string | null => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/** /app/oauth/consent: which workspace the app may use, and allow or cancel. */
export function OAuthConsent({ account }: { account: Account }) {
  const resources = new URLSearchParams(window.location.search).getAll('resource');
  if (resources.length === 1 && resources[0] === `${window.location.origin}/cli`)
    return <CliConsent account={account} />;
  if (resources.length === 1 && resources[0] === `${window.location.origin}/v1`)
    return <InstallationConsent account={account} />;
  return <PersonConsent account={account} />;
}

function CliConsent({ account }: { account: Account }) {
  const query = new URLSearchParams(window.location.search);
  const encoded = query.get('state')?.split('.')[1];
  let machine = 'this computer';
  if (encoded) {
    try {
      machine = new TextDecoder().decode(
        Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
          c.charCodeAt(0),
        ),
      );
    } catch {
      // The server verifies the signed request before recording the login.
    }
  }
  const [pending, setPending] = useState<'allow' | 'deny' | 'sign-out' | null>(null),
    [error, setError] = useState('');
  const busy = pending !== null;
  async function answer(accept: boolean) {
    setPending(accept ? 'allow' : 'deny');
    setError('');
    try {
      const { url } = await accountApi.oauthConsent({
        oauthQuery: window.location.search.slice(1),
        accept,
      });
      window.location.assign(url);
    } catch (failure) {
      setError((failure as Error).message);
      setPending(null);
    }
  }
  async function signOut() {
    setPending('sign-out');
    setError('');
    try {
      await signOutOfAccount(window.location.pathname + window.location.search);
    } catch (failure) {
      setError((failure as Error).message);
      setPending(null);
    }
  }
  const { name, email } = account.user;
  return (
    <div className="min-h-dvh bg-frame text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl px-4 py-4 sm:px-8">
          <a
            href="/app/"
            className="inline-flex items-center gap-2.5 rounded-md text-[.9375rem] font-semibold focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <BrandMark />
            Retainer
          </a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[37rem] px-4 py-5 sm:py-14">
        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
          <div className="space-y-5 px-5 py-5 sm:space-y-6 sm:p-8">
            <div>
              <span className="mb-3 inline-flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary sm:mb-4 sm:size-12">
                <Terminal size={24} aria-hidden="true" />
              </span>
              <h1 className="text-[clamp(1.625rem,1.375rem+1vw,2rem)] leading-tight font-semibold tracking-tight">
                Connect the Retainer CLI
              </h1>
            </div>

            <dl className="divide-y divide-border rounded-xl border border-border bg-muted/40 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
                <dt className="w-24 shrink-0 text-muted-foreground">Device</dt>
                <dd className="min-w-0 grow wrap-anywhere font-mono font-medium">
                  <bdi>{machine}</bdi>
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2">
                <dt className="w-24 shrink-0 text-muted-foreground">Signed in as</dt>
                <dd className="flex min-w-0 flex-[1_1_12rem] flex-wrap items-center justify-between gap-x-2">
                  <div className="min-w-0 grow wrap-anywhere">
                    <p className="font-semibold">
                      <bdi>{name || email}</bdi>
                    </p>
                    {name && name !== email ? (
                      <p className="text-muted-foreground">
                        <bdi>{email}</bdi>
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    className="h-auto min-h-11 px-1.5"
                    disabled={busy}
                    onClick={() => void signOut()}
                  >
                    {pending === 'sign-out' ? 'Signing out…' : 'Sign out'}
                  </Button>
                </dd>
              </div>
            </dl>

            <ul className="space-y-4 text-sm">
              <li className="flex items-start gap-3">
                <Eye size={19} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <h2 className="font-semibold">Read access</h2>
                  <p className="mt-0.5 text-muted-foreground">
                    The CLI can read as an agent in every workspace you can open, within the limits
                    of your role.
                  </p>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <ShieldCheck
                  size={19}
                  className="mt-0.5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <div>
                  <h2 className="font-semibold">Separate approval for decisions</h2>
                  <p className="mt-0.5 text-muted-foreground">
                    Use{' '}
                    <code className="rounded bg-muted px-1 py-0.5 text-foreground">
                      retainer elevate
                    </code>{' '}
                    to let the CLI make decisions on your behalf for a limited time.
                  </p>
                </div>
              </li>
            </ul>
            {error ? <Notice error>{error}</Notice> : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-muted/30 px-5 py-4 sm:px-8">
            <Button
              variant="outline"
              className="h-auto min-h-11 grow px-4 py-2 whitespace-normal sm:grow-0"
              disabled={busy}
              onClick={() => void answer(false)}
            >
              {pending === 'deny' ? 'Denying…' : 'Deny'}
            </Button>
            <Button
              variant="primary"
              className="h-auto min-h-11 grow px-4 py-2 whitespace-normal sm:grow-0"
              disabled={busy}
              onClick={() => void answer(true)}
            >
              {pending === 'allow' ? 'Connecting…' : 'Allow connection'}
              <ArrowRight size={16} aria-hidden="true" />
            </Button>
          </div>
        </section>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          You can disconnect the CLI anytime in{' '}
          <a
            className="rounded-sm font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            href="/app/account"
          >
            Your account
          </a>
          .
        </p>
      </main>
    </div>
  );
}

function PersonConsent({ account }: { account: Account }) {
  const query = new URLSearchParams(window.location.search);
  const clientId = query.get('client_id') ?? '';
  const asked = query.get('scope')?.split(' ') ?? [...OAUTH_SCOPES];
  // Any app can register under any name, so say where allowing it sends you.
  // Better Auth signed this query, so the address is the one it checked.
  const returnsTo = hostOf(query.get('redirect_uri'));
  const client = useQuery({
    queryKey: ['oauth-client', clientId],
    queryFn: () => accountApi.oauthClient(clientId),
    retry: false,
  });
  // A setup prompt's client and an address pinned to one workspace (4.7)
  // each allow only that workspace.
  const setupWorkspace = client.data?.workspaceId;
  const pinned = pinnedWorkspaceOfResources(query.getAll('resource'), window.location.origin);
  const reachable = allWorkspaces(account).filter(
    ({ workspace }) =>
      (!setupWorkspace || workspace.id === setupWorkspace) && (!pinned || workspace.id === pinned),
  );
  const [selected, setSelected] = useState('');
  const picked = reachable.length === 1 ? reachable[0]?.workspace.id : selected;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const name = client.data?.name ?? 'This app';
  const choice = reachable.find(({ workspace }) => workspace.id === picked);
  const can = choice ? cappedScopes(asked, choice.workspace.role) : [];

  async function answer(accept: boolean) {
    setBusy(true);
    setError('');
    try {
      const { url } = await accountApi.oauthConsent({
        oauthQuery: window.location.search.slice(1),
        accept,
        ...(accept && picked ? { workspaceId: picked } : {}),
      });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (client.error)
    return (
      <AccountFrame title="This link does not work" account={account}>
        <Notice error>{(client.error as Error).message}</Notice>
      </AccountFrame>
    );
  if (!client.data)
    return (
      <AccountFrame title="Connecting to Retainer" account={account}>
        <Notice>Checking the connection request…</Notice>
      </AccountFrame>
    );
  return (
    <AccountFrame
      title={`Connect ${name} to Retainer`}
      signOutTo={window.location.pathname + window.location.search}
      description={`${name} will work in one workspace, as ${account.user.name || account.user.email}.`}
      account={account}
    >
      {reachable.length === 0 ? (
        <Stack>
          {pinned ? (
            <Notice>
              You don't have access to the workspace this connection's address is for. Sign in with
              the account that can open it.
            </Notice>
          ) : setupWorkspace ? (
            <Notice>
              You don't have access to the workspace in this setup prompt. Sign in with the account
              that can open it.
            </Notice>
          ) : account.hostedOnboarding ? (
            <NeedWorkspace
              account={account}
              oauthQuery={window.location.search.slice(1)}
              onWorkspace={reloadConsent}
            />
          ) : (
            <Notice>
              You have no workspace yet. <a href="/app/">Create one</a>, then connect {name} again.
            </Notice>
          )}
          {error ? <Notice error>{error}</Notice> : null}
          <div>
            {/* Tells the app no, so it stops waiting. */}
            <Button disabled={busy} onClick={() => void answer(false)}>
              Cancel
            </Button>
          </div>
        </Stack>
      ) : (
        <Stack>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Which workspace?</legend>
            {reachable.map(({ workspace, organization }) => (
              <Radio
                key={workspace.id}
                variant="option"
                name="workspace"
                value={workspace.id}
                checked={picked === workspace.id}
                onChange={() => setSelected(workspace.id)}
                label={
                  <>
                    {workspace.name}
                    {account.organizations.length > 1 ? (
                      <span className="font-normal text-muted-foreground">
                        {' '}
                        · {organization.name}
                      </span>
                    ) : null}
                  </>
                }
                description={`Your role: ${capital(workspace.role)}${
                  reachable.length > 1 ? ` · ${workspace.slug}` : ''
                }`}
              />
            ))}
          </fieldset>
          {choice ? (
            <div className="text-sm">
              <p className="font-medium">{name} will be able to:</p>
              <ul className="mt-1 list-disc pl-5">
                {can.map((scope) => (
                  <li key={scope}>{APP_SCOPE_WORDS[scope]}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <Muted small>
            Its changes show as "{name} for {account.user.name || account.user.email}". It can never
            do more than you can in this workspace, and it never manages people or keys. You can
            disconnect it at any time in Your account.
          </Muted>
          {returnsTo ? (
            <Muted small>
              Allowing sends you back to <strong>{returnsTo}</strong>. Only allow it if that is the
              app you meant to connect.
            </Muted>
          ) : null}
          {error ? <Notice error>{error}</Notice> : null}
          <div className="flex gap-2">
            <Button variant="primary" disabled={!picked || busy} onClick={() => void answer(true)}>
              Allow
            </Button>
            <Button disabled={busy} onClick={() => void answer(false)}>
              Cancel
            </Button>
          </div>
        </Stack>
      )}
    </AccountFrame>
  );
}

function reloadConsent() {
  window.location.reload();
}

/** Workspace grants use the reviewed installation's identity, independently of the installer. */
function InstallationConsent({ account }: { account: Account }) {
  const query = new URLSearchParams(window.location.search),
    clientId = query.get('client_id') ?? '';
  const asked =
    query
      .get('scope')
      ?.split(' ')
      .filter((s) => s !== 'offline_access') ?? [];
  const reachable = allWorkspaces(account).filter(({ workspace }) => workspace.role === 'admin');
  const [workspace, setWorkspace] = useState(
    reachable.length === 1 ? (reachable[0]?.workspace.id ?? '') : '',
  );
  const [picked, setPicked] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const client = useQuery({
    queryKey: ['oauth-client', clientId],
    queryFn: () => accountApi.oauthClient(clientId),
    retry: false,
  });
  const options = useQuery({
    queryKey: ['oauth-installations', clientId, workspace],
    queryFn: () => accountApi.oauthInstallations(clientId, workspace),
    enabled: !!workspace,
    retry: false,
  });
  const installations = options.data?.installations ?? [];
  const choice =
    installations.find((i) => i.id === picked) ??
    (installations.length === 1 ? installations[0] : undefined);
  const name = client.data?.name ?? 'This app',
    returnsTo = hostOf(query.get('redirect_uri'));
  const canAllow =
    choice &&
    asked.length > 0 &&
    asked.every((s) => choice.scopes.some((allowed) => allowed === s));
  async function answer(accept: boolean) {
    setBusy(true);
    setError('');
    try {
      const { url } = await accountApi.oauthConsent({
        oauthQuery: window.location.search.slice(1),
        accept,
        ...(accept && choice
          ? {
              workspaceId: workspace,
              installationId: choice.id,
              expectedGeneration: choice.generation,
            }
          : {}),
      });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <AccountFrame
      title={`Connect ${name} to this workspace`}
      account={account}
      description="Approve access for an installed workspace app."
    >
      <Stack>
        {!reachable.length ? (
          <Notice>Only a workspace admin can connect this app.</Notice>
        ) : (
          <label className="text-sm">
            Workspace
            <select
              value={workspace}
              onChange={(e) => {
                setWorkspace(e.target.value);
                setPicked('');
              }}
              className="mt-1 block w-full rounded-md border border-border bg-background p-2"
            >
              <option value="">Choose a workspace</option>
              {reachable.map(({ workspace: w, organization }) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {account.organizations.length > 1 ? ` · ${organization.name}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {options.isLoading ? <Notice>Loading approved installations…</Notice> : null}
        {workspace && options.data && !installations.length ? (
          <Notice>
            This app needs an approved installation in this workspace. Install it from Extensions,
            then connect again.
          </Notice>
        ) : null}
        {installations.length > 1 ? (
          <label className="text-sm">
            Installation
            <select
              value={choice?.id ?? ''}
              onChange={(e) => setPicked(e.target.value)}
              className="mt-1 block w-full rounded-md border border-border bg-background p-2"
            >
              <option value="">Choose an installation</option>
              {installations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} · {i.version}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {choice ? (
          <div className="text-sm">
            <p className="font-medium">
              {choice.name} will act as an {choice.actor} and may:
            </p>
            <ul className="mt-1 list-disc pl-5">
              {asked.map((s) => (
                <li key={s}>
                  {s === 'read'
                    ? 'Read workspace records'
                    : s === 'write'
                      ? 'Write workspace records'
                      : s}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Muted small>
          This access belongs to the workspace and continues if you leave. It cannot read your
          personal memory. A workspace admin can disconnect it in Extensions.
        </Muted>
        {returnsTo ? (
          <Muted small>
            Allowing sends you back to <strong>{returnsTo}</strong>. Only allow it if that is the
            app you meant to connect.
          </Muted>
        ) : null}
        {client.error || options.error || error ? (
          <Notice error>{error || ((client.error ?? options.error) as Error).message}</Notice>
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={!canAllow || !client.data || busy}
            onClick={() => void answer(true)}
          >
            Allow
          </Button>
          <Button disabled={busy} onClick={() => void answer(false)}>
            Cancel
          </Button>
        </div>
      </Stack>
    </AccountFrame>
  );
}
