import { cappedScopes, OAUTH_SCOPES } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type Account, account as accountApi } from '../api/account.js';
import { Button, Muted, Notice, Stack } from '../ui/index.js';
import { allWorkspaces } from './context.js';
import { APP_SCOPE_WORDS, capital, withoutSignInError } from './format.js';
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
  const reachable = allWorkspaces(account);
  const [picked, setPicked] = useState(reachable.length === 1 ? reachable[0]?.workspace.id : '');
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
  return (
    <AccountFrame
      title={`Connect ${name} to Retainer`}
      description={`${name} will work in one workspace, as ${account.user.name || account.user.email}.`}
      account={account}
    >
      {reachable.length === 0 ? (
        <Stack>
          <Notice>
            You have no workspace yet. <a href="/app/">Create one</a>, then connect {name} again.
          </Notice>
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
              <label
                key={workspace.id}
                className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-background p-3 text-sm has-[:checked]:border-primary"
              >
                <input
                  type="radio"
                  name="workspace"
                  value={workspace.id}
                  checked={picked === workspace.id}
                  onChange={() => setPicked(workspace.id)}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium">
                    {workspace.name}
                    {account.organizations.length > 1 ? (
                      <span className="font-normal text-muted-foreground">
                        {' '}
                        · {organization.name}
                      </span>
                    ) : null}
                  </span>
                  <span className="block text-muted-foreground">
                    Your role: {capital(workspace.role)}
                  </span>
                </span>
              </label>
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
            <Button
              variant="primary"
              disabled={!picked || busy || !client.data}
              onClick={() => void answer(true)}
            >
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
