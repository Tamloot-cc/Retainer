import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type Account, authClient, signOutOfAccount, workspaceHref } from '../api/account.js';
import { Button, Dialog, Input, Label, Muted, Notice, Panel, Stack } from '../ui/index.js';
import { ConnectedApps } from './connections.js';
import { shortDate as date, roleWords } from './format.js';
import { AccountFrame } from './screens.js';

/** `/app/account`: you, your passkeys and where you have access (accounts spec 5.1). */

type Passkey = { id: string; name?: string | null; createdAt: string | Date };

export function YourAccount({ account }: { account: Account }) {
  return (
    <AccountFrame title="Your account" account={account}>
      <Panel title="You">
        <p className="text-sm font-medium">{account.user.name}</p>
        <p className="text-sm text-muted-foreground">{account.user.email}</p>
        <Muted small>
          Your name and email come from the Google or Microsoft account you first signed in with;
          change them there.
        </Muted>
      </Panel>
      <Passkeys />
      <Panel title="Connected apps">
        <ConnectedApps showWorkspace />
      </Panel>
      <Panel title="Where you have access">
        {account.organizations.length === 0 ? (
          <Muted>You're not in any workspace yet.</Muted>
        ) : (
          <div className="flex flex-col gap-4">
            {account.organizations.map((organization) => (
              <div key={organization.id} className="flex flex-col gap-1.5 text-sm">
                {account.organizations.length > 1 || organization.role !== 'member' ? (
                  <p>
                    <strong>{organization.name}</strong>
                    <span className="text-muted-foreground">
                      {' '}
                      · {roleWords(organization.role, 'organization')}
                    </span>
                  </p>
                ) : null}
                <ul className="flex flex-col gap-1">
                  {organization.workspaces.map((workspace) => (
                    <li key={workspace.id}>
                      <a className="underline" href={workspaceHref(workspace.slug)}>
                        {workspace.name}
                      </a>
                      <span className="text-muted-foreground"> — {roleWords(workspace.role)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>
      <SignOutEverywhere />
    </AccountFrame>
  );
}

function Passkeys() {
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null),
    [error, setError] = useState(''),
    [stale, setStale] = useState(false),
    [renaming, setRenaming] = useState<Passkey | null>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const client = await authClient();
    const result = await client.passkey.listUserPasskeys();
    if (result.error) setError('Your passkeys could not be loaded.');
    else setPasskeys((result.data ?? []) as Passkey[]);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function add() {
    setBusy(true);
    setError('');
    const client = await authClient();
    const result = await client.passkey.addPasskey({ name: defaultName() });
    // Better Auth asks for a sign-in within the last day before adding one,
    // so a stolen session cannot add a passkey of its own.
    if (result.error && 'code' in result.error && result.error.code === 'SESSION_NOT_FRESH')
      setStale(true);
    else if (result.error) setError('The passkey was not added. Try again, or use another device.');
    await load();
    setBusy(false);
  }
  async function remove(passkey: Passkey) {
    const client = await authClient();
    const result = await client.passkey.deletePasskey({ id: passkey.id });
    if (result.error) setError('The passkey was not removed. Try again.');
    await load();
  }
  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!renaming) return;
    const name = (e.currentTarget.elements.namedItem('name') as HTMLInputElement).value.trim();
    const client = await authClient();
    const result = await client.passkey.updatePasskey({ id: renaming.id, name });
    if (result.error) setError('The passkey was not renamed. Try again.');
    setRenaming(null);
    await load();
  }
  return (
    <Panel title="Passkeys">
      <Stack>
        <Muted small>
          A passkey signs you in with your fingerprint, face or device PIN. Signing in with Google
          or Microsoft keeps working either way.
        </Muted>
        {passkeys === null ? null : passkeys.length === 0 ? (
          <Muted>You have no passkeys yet.</Muted>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {passkeys.map((passkey) => (
              <li key={passkey.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {passkey.name || 'Passkey'}
                  <span className="text-muted-foreground"> · added {date(passkey.createdAt)}</span>
                </span>
                <Button size="small" variant="ghost" onClick={() => setRenaming(passkey)}>
                  Rename
                </Button>
                <Button size="small" variant="ghost" onClick={() => void remove(passkey)}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error ? <Notice error>{error}</Notice> : null}
        {stale ? (
          <Notice>
            For your security, adding a passkey needs a recent sign-in.{' '}
            <button
              type="button"
              className="underline"
              onClick={() =>
                void signOutOfAccount('/app/account').catch((e: Error) => setError(e.message))
              }
            >
              Sign in again
            </button>{' '}
            and you'll come back here.
          </Notice>
        ) : null}
        <div>
          <Button disabled={busy} onClick={() => void add()}>
            {busy ? 'Waiting for your device…' : 'Add a passkey'}
          </Button>
        </div>
      </Stack>
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Rename passkey"
      >
        <form onSubmit={(e) => void rename(e)}>
          <Stack>
            <Label htmlFor="passkey-name">
              Name
              <Input
                id="passkey-name"
                name="name"
                required
                maxLength={100}
                defaultValue={renaming?.name ?? ''}
                autoFocus
              />
            </Label>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </Stack>
        </form>
      </Dialog>
    </Panel>
  );
}

/** A name to tell passkeys apart, such as "Mac" or "iPhone". */
function defaultName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return 'iPhone';
  if (/iPad/.test(agent)) return 'iPad';
  if (/Android/.test(agent)) return 'Android';
  if (/Mac OS X/.test(agent)) return 'Mac';
  if (/Windows/.test(agent)) return 'Windows';
  return 'Passkey';
}

function SignOutEverywhere() {
  const [confirm, setConfirm] = useState(false),
    [error, setError] = useState('');
  async function signOut() {
    setError('');
    const client = await authClient();
    const revoked = await client.revokeSessions();
    if (revoked.error) {
      setConfirm(false);
      setError('Your other sessions could not be ended. Nothing changed; try again.');
      return;
    }
    await client.signOut();
    window.location.assign('/app/');
  }
  return (
    <Panel title="Sign out everywhere">
      <Stack>
        <Muted small>Ends every session you have, on every device, including this one.</Muted>
        {error ? <Notice error>{error}</Notice> : null}
        <div>
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            Sign out everywhere
          </Button>
        </div>
      </Stack>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Sign out everywhere?"
        description="You'll need to sign in again on every device. Agent keys keep working."
      >
        <Button variant="destructive" onClick={() => void signOut()}>
          Sign out everywhere
        </Button>
      </Dialog>
    </Panel>
  );
}
