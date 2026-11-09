import {
  LAST_SIGN_IN_COOKIE,
  SIGN_IN_PROVIDER_NAMES,
  type SignInMethod,
  type SignInProvider,
} from '@retainer/shared';
import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import {
  type Account,
  account as accountApi,
  authClient,
  type InvitationPreview,
  signOutOfAccount,
  workspaceHref,
} from '../api/account.js';
import { BrandMark } from '../ui/brand.js';
import {
  Button,
  ButtonNote,
  Input,
  Label,
  Muted,
  Notice,
  SignInFrame,
  Stack,
} from '../ui/index.js';
import { allWorkspaces, managed } from './context.js';
import { providerNames, roleWords, signInError } from './format.js';

/** Screens outside any workspace in accounts mode (accounts spec 5). */

/** How this browser last signed in (a `SignInMethod`), from the cookie the server sets then. */
const lastSignIn = () =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith(`${LAST_SIGN_IN_COOKIE}=`))
    ?.slice(LAST_SIGN_IN_COOKIE.length + 1);

export function AccountSignIn({ returnTo }: { returnTo?: string } = {}) {
  const [error, setError] = useState(() =>
    signInError(new URLSearchParams(window.location.search).get('error')),
  );
  const [busy, setBusy] = useState<SignInMethod | null>(null);
  const last = lastSignIn();
  // Google, Microsoft or both, as the server is set up.
  const [providers, setProviders] = useState<SignInProvider[] | null>(null);
  useEffect(() => {
    accountApi.providers().then(
      (r) => setProviders(r.providers),
      () => setError('Could not load the ways to sign in. Reload the page to try again.'),
    );
  }, []);
  // After signing in, come back to the page that asked for it.
  const here =
    returnTo ?? (window.location.pathname.startsWith('/app/') ? window.location.pathname : '/app/');
  async function social(provider: SignInProvider) {
    setBusy(provider);
    setError('');
    const client = await authClient();
    const result = await client.signIn.social({
      provider,
      callbackURL: here,
      // Connecting an app: come back here, so its request is not lost.
      errorCallbackURL: returnTo ?? '/app/',
    });
    if (result.error) {
      setError(`${SIGN_IN_PROVIDER_NAMES[provider]} sign-in could not start. Try again.`);
      setBusy(null);
    }
  }
  async function passkey() {
    setBusy('passkey');
    setError('');
    const client = await authClient();
    const result = await client.signIn.passkey();
    if (result.error) {
      setError(
        `That passkey did not work. Use ${providerNames(providers ?? [])} instead, or try another passkey saved for this site.`,
      );
      setBusy(null);
      return;
    }
    window.location.assign(here);
  }
  return (
    <SignInFrame subtitle="Sign in to see what your agents remember.">
      <Stack>
        {(providers ?? []).map((provider) => (
          <Button
            key={provider}
            variant="primary"
            disabled={busy !== null}
            onClick={() => void social(provider)}
          >
            {busy === provider
              ? `Opening ${SIGN_IN_PROVIDER_NAMES[provider]}…`
              : `Continue with ${SIGN_IN_PROVIDER_NAMES[provider]}`}
            {last === provider ? <ButtonNote>Last used</ButtonNote> : null}
          </Button>
        ))}
        <Button disabled={busy !== null} onClick={() => void passkey()}>
          {busy === 'passkey' ? 'Waiting for your passkey…' : 'Use a passkey'}
          {last === 'passkey' ? <ButtonNote>Last used</ButtonNote> : null}
        </Button>
        {error ? <Notice error>{error}</Notice> : null}
        {providers ? (
          <Muted>
            New here? Continue with {providerNames(providers)} to create your account. A passkey
            works once you have added one.
          </Muted>
        ) : null}
      </Stack>
    </SignInFrame>
  );
}

/** A plain screen for accounts mode, outside any workspace's sidebar. */
export function AccountFrame({
  title,
  description,
  account,
  signOutTo,
  children,
}: {
  title: string;
  description?: string;
  account?: Account;
  /** Where signing in again leads after Sign out; the person's workspaces by default. */
  signOutTo?: string;
  children: ReactNode;
}) {
  const [signOutError, setSignOutError] = useState('');
  return (
    <main className="min-h-dvh bg-muted/30">
      <header className="flex h-12 items-center gap-2 border-b border-border bg-background px-4">
        <a href="/app/" className="flex items-center gap-2 text-sm font-semibold">
          <BrandMark className="h-6 w-6" />
          Retainer
        </a>
        {account ? (
          <span className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            <a href="/app/account" className="hover:text-foreground">
              {account.user.name || account.user.email}
            </a>
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() =>
                void signOutOfAccount(signOutTo).catch((e: Error) => setSignOutError(e.message))
              }
            >
              Sign out
            </button>
          </span>
        ) : null}
      </header>
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 py-10">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {signOutError ? <Notice error>{signOutError}</Notice> : null}
        {children}
      </section>
    </main>
  );
}

/**
 * A person with no workspace yet: invitations waiting for them, and naming
 * their own workspace. The word organization does not appear (5).
 */
export function FirstRun({ account }: { account: Account }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  // A plain member of an organization cannot create one; their admins can.
  const managedHere = managed(account)[0];
  const canCreate = account.organizations.length === 0 || managedHere !== undefined;
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = (e.currentTarget.elements.namedItem('name') as HTMLInputElement).value.trim();
    if (!name) return;
    setBusy(true);
    setError('');
    try {
      const workspace = await accountApi.createWorkspace({
        name,
        ...(managedHere ? { organizationId: managedHere.id } : {}),
      });
      window.location.assign(workspaceHref(workspace.slug));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <AccountFrame
      title={`Welcome, ${account.user.name.split(' ')[0] || 'there'}`}
      description="A workspace holds the records your agents and your team keep."
      account={account}
    >
      {account.invitations.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">You've been invited</h2>
          {account.invitations.map((invitation) => (
            <InvitationRow key={invitation.id} id={invitation.id}>
              {invitation.invitedBy ? `${invitation.invitedBy} invited you to ` : 'Join '}
              <strong>{invitation.organization}</strong>
            </InvitationRow>
          ))}
        </section>
      ) : null}
      {canCreate ? (
        <form
          onSubmit={(e) => void create(e)}
          className="rounded-lg border border-border bg-card p-5"
        >
          <Stack>
            <Label htmlFor="workspace-name">
              {account.invitations.length ? 'Or name your own workspace' : 'Name your workspace'}
              <Input
                id="workspace-name"
                name="name"
                required
                maxLength={200}
                autoFocus={!account.invitations.length}
                placeholder="Acme sales"
                disabled={busy}
              />
            </Label>
            {error ? <Notice error>{error}</Notice> : null}
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create workspace'}
            </Button>
            <Muted>
              You can rename it later, and add records, people and agents once it exists.
            </Muted>
          </Stack>
        </form>
      ) : (
        <Notice>
          You're not in any workspace yet. Ask an owner or admin of{' '}
          {account.organizations.map((o) => o.name).join(', ')} to add you to one.
        </Notice>
      )}
    </AccountFrame>
  );
}

function InvitationRow({ id, children }: { id: string; children: ReactNode }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true);
    try {
      await accountApi.acceptInvitation(id);
      window.location.assign('/app/');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      <span className="min-w-0 flex-1">{children}</span>
      <Button variant="primary" size="small" disabled={busy} onClick={() => void accept()}>
        Accept
      </Button>
      {error ? (
        <div className="w-full">
          <Notice error>{error}</Notice>
        </div>
      ) : null}
    </div>
  );
}

/** `/app/invite/<token>`: what the invitation gives, and accepting it. */
export function InvitePage({ token, account }: { token: string; account: Account }) {
  const [preview, setPreview] = useState<InvitationPreview | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    accountApi
      .invitation(token)
      .then(setPreview)
      .catch((e: Error) => setError(e.message));
  }, [token]);
  if (error)
    return (
      <AccountFrame title="Invitation" account={account}>
        <Notice error>{error}</Notice>
        <a className="text-sm underline" href="/app/">
          Go to your workspaces
        </a>
      </AccountFrame>
    );
  if (!preview)
    return (
      <AccountFrame title="Invitation" account={account}>
        <Notice>Loading the invitation…</Notice>
      </AccountFrame>
    );
  return (
    <AccountFrame
      title={`Join ${preview.organization.name}`}
      description={preview.invitedBy ? `${preview.invitedBy} invited ${preview.email}.` : undefined}
      account={account}
      // Signed in as someone else: signing in again comes back to this invitation.
      signOutTo={window.location.pathname}
    >
      {preview.workspaces.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {preview.workspaces.map((w) => (
            <li key={w.id}>
              <strong>{w.name}</strong> — {roleWords(w.role)}
            </li>
          ))}
        </ul>
      ) : null}
      {preview.forYou ? (
        <InvitationRow id={token}>
          Accept to join {preview.organization.name} and open its workspaces.
        </InvitationRow>
      ) : (
        <Notice error>
          This invitation is for {preview.email}, and you're signed in as {account.user.email}. Sign
          out, then sign in with the {providerNames(account.providers)} account for that address to
          accept it.
        </Notice>
      )}
    </AccountFrame>
  );
}

/** A workspace the person cannot open: it does not exist, or they have no role in it. */
export function NoAccess({ account }: { account: Account }) {
  const reachable = allWorkspaces(account);
  return (
    <AccountFrame
      title="You can't open this workspace"
      description="It doesn't exist, or you don't have a role in it. Ask one of its admins to add you."
      account={account}
    >
      {reachable.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {reachable.map(({ workspace }) => (
            <li key={workspace.id}>
              <a className="underline" href={workspaceHref(workspace.slug)}>
                {workspace.name}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <a className="text-sm underline" href="/app/">
          Create a workspace
        </a>
      )}
    </AccountFrame>
  );
}
