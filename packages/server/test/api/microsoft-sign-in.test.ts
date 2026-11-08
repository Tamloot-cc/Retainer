import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization, setOrganizationMember } from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { type AccountsTestApp, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';
import {
  type FakeMicrosoft,
  type MicrosoftAccount,
  personalAccount,
  startFakeMicrosoft,
  WORK_TENANT,
  workAccount,
} from '../helpers/microsoft.js';

// Microsoft sign-in (accounts spec 4.4, 4.5, 9.1, 9.2), against a local fake
// of Microsoft's sign-in service and real Postgres. The guarantee: nobody
// reaches another person's account, or accepts their invitation, with an
// address Microsoft never verified.

const db = useTestDatabase();
let microsoft: FakeMicrosoft;
let app: AccountsTestApp;

beforeAll(async () => {
  microsoft = await startFakeMicrosoft();
  app = startAccountsApp(db, { microsoft });
});
afterAll(() => microsoft.close());

const unique = (name: string) => `${name}-${Math.random().toString(16).slice(2, 8)}`;

/** Signs in with a Microsoft ID token; returns the person and their cookie. */
async function signInWithMicrosoft(account: MicrosoftAccount) {
  const res = await app.microsoftIdToken(account);
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.getSetCookie().find((c) => c.includes('.session_token='));
  const body = (await res.json()) as { user: { id: string } };
  return { cookie: setCookie?.split(';')[0] ?? '', userId: body.user.id };
}

const linksOf = (userId: string) =>
  db.owner<{ provider_id: string; account_id: string }[]>`
    select provider_id, account_id from auth_accounts where user_id = ${userId} order by provider_id`;

/** An organization whose owner invites `email` into its workspace. */
async function invitationFor(email: string) {
  const organizationId = (await createOrganization(db.owner, { name: unique('Org') })).id;
  const workspaceId = (
    await createWorkspace(db.owner, {
      name: 'CRM',
      slug: unique('crm'),
      organization: organizationId,
    })
  ).id;
  const ownerEmail = `${unique('owner')}@acme.test`;
  const owner = await app.signIn({ email: ownerEmail, name: 'Owner' });
  await setOrganizationMember(db.owner, {
    organization: organizationId,
    email: ownerEmail,
    role: 'owner',
  });
  const res = await app.account(`/account/organizations/${organizationId}/invitations`, {
    cookie: owner.cookie,
    method: 'POST',
    body: { email, role: 'member', workspaces: [{ workspaceId, role: 'editor' }] },
  });
  expect(res.status).toBe(201);
  const { id, link } = (await res.json()) as { id: string; link: string };
  return { id, token: link.split('/').at(-1) as string, organizationId, workspaceId };
}

const accept = (token: string, cookie: string) =>
  app.account(`/account/invitations/${token}/accept`, { cookie, method: 'POST' });

describe('signing in with Microsoft', () => {
  it('makes a personal account a person, keyed by tenant and object ID, not email', async () => {
    const account = personalAccount('Pat.Personal@Outlook.TEST', 'Pat Personal');
    const first = await app.microsoftRedirect(account);
    expect(first).toMatchObject({ path: '/app/', error: null });
    expect(first.cookie).toMatch(/^retainer\.session_token=/);

    const again = await signInWithMicrosoft(account);
    const [user] =
      await db.owner`select id, name, email, email_verified from users where id = ${again.userId}`;
    expect(user).toEqual({
      id: again.userId,
      name: 'Pat Personal',
      email: 'pat.personal@outlook.test',
      email_verified: true,
    });
    expect(await linksOf(again.userId)).toEqual([
      { provider_id: 'microsoft', account_id: `${account.tid}:${account.oid}` },
    ]);

    // The same object ID in another tenant is another account.
    const elsewhere = { ...account, tid: WORK_TENANT, xms_edov: true, email: 'pat@elsewhere.test' };
    const other = await signInWithMicrosoft(elsewhere);
    expect(other.userId).not.toBe(again.userId);

    // A changed address on the same account is still the same person.
    const renamed = await signInWithMicrosoft({ ...account, email: 'pat.new@outlook.test' });
    expect(renamed.userId).toBe(again.userId);
  });

  it('makes a work account a person when its tenant proved it owns the domain', async () => {
    const email = `${unique('nina')}@fabrikam.test`;
    const { userId } = await signInWithMicrosoft(workAccount(email, { verified: true }));
    const [user] = await db.owner`select email_verified from users where id = ${userId}`;
    expect(user).toEqual({ email_verified: true });
  });

  it('refuses a work account whose address Microsoft has not verified, saying so', async () => {
    const email = `${unique('unproven')}@contoso.test`;
    const landed = await app.microsoftRedirect(workAccount(email, { verified: false }));
    expect(landed).toEqual({ path: '/app/', error: 'email_not_verified', cookie: null });
    const res = await app.microsoftIdToken(workAccount(email, { verified: false }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'email_not_verified' });
    expect(await db.owner`select 1 from users where email = ${email}`).toHaveLength(0);
  });

  it('refuses a token signed by anyone but Microsoft', async () => {
    const forged = await startFakeMicrosoft();
    try {
      const res = await app.accounts.request('http://localhost:8787/account/auth/sign-in/social', {
        method: 'POST',
        headers: { origin: 'http://localhost:8787', 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'microsoft',
          idToken: { token: await forged.idToken(personalAccount('x@outlook.test')) },
        }),
      });
      expect(res.status).toBe(401);
      expect(await db.owner`select 1 from users where email = 'x@outlook.test'`).toHaveLength(0);
    } finally {
      await forged.close();
    }
  });
});

describe('a Microsoft sign-in with the address of an existing person', () => {
  it('does not reach them when Microsoft has not verified the address', async () => {
    const email = `${unique('victim')}@acme.test`;
    const victim = await app.signIn({ email, name: 'Victim' });

    // A tenant admin puts the victim's address on a user of their own.
    const impostor = workAccount(email, { verified: false });
    const landed = await app.microsoftRedirect(impostor);
    expect(landed.cookie).toBeNull();
    expect(landed.error).toBe('account_not_linked');
    const res = await app.microsoftIdToken(impostor);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie().some((c) => c.includes('.session_token='))).toBe(false);

    expect(await linksOf(victim.userId)).toEqual([
      { provider_id: 'google', account_id: expect.any(String) },
    ]);
    expect(await db.owner`select 1 from users where email = ${email}`).toHaveLength(1);
  });

  it('joins them when Microsoft verified it: personal, or a work account with proof', async () => {
    for (const account of [
      (email: string) => personalAccount(email),
      (email: string) => workAccount(email, { verified: true }),
    ]) {
      const email = `${unique('dana')}@acme.test`;
      const sub = unique('dana-sub');
      const dana = await app.signIn({ email, sub, name: 'Dana' });
      const viaMicrosoft = await signInWithMicrosoft(account(email.toUpperCase()));
      expect(viaMicrosoft.userId).toBe(dana.userId);
      expect((await linksOf(dana.userId)).map((l) => l.provider_id)).toEqual([
        'google',
        'microsoft',
      ]);
      // Their name and address stay as they were.
      const [user] = await db.owner`select name, email from users where id = ${dana.userId}`;
      expect(user).toEqual({ name: 'Dana', email });
      // Either way in is the same person from now on.
      expect((await app.signIn({ email, sub })).userId).toBe(dana.userId);
    }
  });

  it('works the other way round: Google joins a person who started with Microsoft', async () => {
    const email = `${unique('mo')}@outlook.test`;
    const mo = await signInWithMicrosoft(personalAccount(email));
    expect((await app.signIn({ email })).userId).toBe(mo.userId);
    // An address Google has not verified does not join them either.
    const other = `${unique('mo2')}@outlook.test`;
    await signInWithMicrosoft(personalAccount(other));
    await expect(app.signIn({ email: other, email_verified: false })).rejects.toThrow(
      'account not linked',
    );
  });

  it('keeps one Google and one Microsoft account per person', async () => {
    const email = `${unique('two')}@acme.test`;
    const first = await signInWithMicrosoft(personalAccount(email));
    // Another verified Microsoft account with the same address is refused,
    // as another Google account with it is.
    const second = await app.microsoftIdToken(workAccount(email, { verified: true }));
    expect(second.status).toBe(401);
    expect(await second.json()).toMatchObject({ code: 'account_not_linked' });
    const viaRedirect = await app.microsoftRedirect(workAccount(email, { verified: true }));
    expect(viaRedirect).toMatchObject({ error: 'account_not_linked', cookie: null });
    const sub = unique('google-sub');
    await expect(app.signIn({ email, sub })).resolves.toMatchObject({ userId: first.userId });
    await expect(app.signIn({ email, sub })).resolves.toMatchObject({ userId: first.userId });
    const otherGoogle = app.signIn({ email, sub: unique('second-google-sub') });
    await expect(otherGoogle).rejects.toThrow('account_not_linked');
    expect((await linksOf(first.userId)).map((l) => l.provider_id)).toEqual([
      'google',
      'microsoft',
    ]);
  });
});

describe('invitations and Microsoft', () => {
  it('cannot be accepted with an address Microsoft has not verified', async () => {
    const email = `${unique('invited')}@contoso.test`;
    const invitation = await invitationFor(email);
    // No person can be made from the unverified address, so there is no
    // session to accept with.
    const landed = await app.microsoftRedirect(workAccount(email, { verified: false }));
    expect(landed).toMatchObject({ error: 'email_not_verified', cookie: null });
    // Nor can someone signed in with another address use the link.
    const other = await signInWithMicrosoft(personalAccount(`${unique('other')}@outlook.test`));
    const res = await accept(invitation.token, other.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { message: expect.stringContaining(`This invitation is for ${email}`) },
    });
    const [row] = await db.owner`select accepted_at from invitations where id = ${invitation.id}`;
    expect(row).toEqual({ accepted_at: null });
  });

  it('cannot be taken over through an existing person with an unverified address', async () => {
    const email = `${unique('ben')}@acme.test`;
    const invitation = await invitationFor(email);
    await app.signIn({ email, name: 'Ben' });
    const impostor = await app.microsoftRedirect(workAccount(email, { verified: false }));
    expect(impostor.cookie).toBeNull();
    const [row] = await db.owner`select accepted_at from invitations where id = ${invitation.id}`;
    expect(row).toEqual({ accepted_at: null });
  });

  it('is accepted with a verified Microsoft address, work or personal', async () => {
    for (const account of [
      (email: string) => workAccount(email, { verified: true }),
      (email: string) => personalAccount(email),
    ]) {
      const email = `${unique('nina')}@fabrikam.test`;
      const invitation = await invitationFor(email);
      const nina = await signInWithMicrosoft(account(email));
      const res = await accept(invitation.token, nina.cookie);
      expect(res.status).toBe(200);
      const me = await app.v1('/v1/me', { cookie: nina.cookie, workspace: invitation.workspaceId });
      expect(await me.json()).toMatchObject({ scopes: ['read', 'write'] });
    }
  });

  it('is accepted by a Google person who signed in with Microsoft this time', async () => {
    const email = `${unique('gil')}@acme.test`;
    const invitation = await invitationFor(email);
    const gil = await app.signIn({ email, name: 'Gil' });
    const viaMicrosoft = await signInWithMicrosoft(personalAccount(email));
    expect(viaMicrosoft.userId).toBe(gil.userId);
    expect((await accept(invitation.token, viaMicrosoft.cookie)).status).toBe(200);
  });
});

describe('simultaneous Microsoft sign-ins (9.2, concurrent)', () => {
  /** Slows linking a provider account, so racing sign-ins overlap. */
  async function slowLinks<T>(run: () => Promise<T>): Promise<T> {
    await db.owner.unsafe(`
      create function slow_link() returns trigger language plpgsql
        as $$ begin perform pg_sleep(0.3); return new; end $$;
      create trigger slow_link before insert on auth_accounts
        for each row execute function slow_link();`);
    return run().finally(() =>
      db.owner.unsafe('drop trigger slow_link on auth_accounts; drop function slow_link();'),
    );
  }

  it('signs every first sign-in for one account in as the one person they make', async () => {
    const account = personalAccount(`${unique('race')}@outlook.test`);
    const results = await slowLinks(() =>
      Promise.all([1, 2, 3, 4, 5, 6].map(() => signInWithMicrosoft(account))),
    );
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect(await db.owner`select 1 from users where email = ${account.email ?? ''}`).toHaveLength(
      1,
    );
    expect(await linksOf(results[0]?.userId ?? '')).toHaveLength(1);
  });

  it('signs in as the person every sign-in that joins them at once', async () => {
    const email = `${unique('join-race')}@acme.test`;
    const dana = await app.signIn({ email });
    const account = personalAccount(email);
    const results = await slowLinks(() =>
      Promise.all([1, 2, 3, 4].map(() => signInWithMicrosoft(account))),
    );
    expect(results.map((r) => r.userId)).toEqual([
      dana.userId,
      dana.userId,
      dana.userId,
      dana.userId,
    ]);
    expect((await linksOf(dana.userId)).map((l) => l.provider_id)).toEqual(['google', 'microsoft']);
  });

  it('makes one person of first sign-ins through Google and Microsoft at once', async () => {
    const email = `${unique('both')}@acme.test`;
    const sub = unique('both-sub');
    const microsoftAccount = personalAccount(email);
    const results = await slowLinks(() =>
      Promise.all([
        app.signIn({ email, sub }),
        signInWithMicrosoft(microsoftAccount),
        app.signIn({ email, sub }),
        signInWithMicrosoft(microsoftAccount),
      ]),
    );
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect((await linksOf(results[0]?.userId ?? '')).map((l) => l.provider_id)).toEqual([
      'google',
      'microsoft',
    ]);
    expect(await db.owner`select 1 from users where email = ${email}`).toHaveLength(1);
  });

  it('sends a tab that loses a simultaneous redirect back to sign in again', async () => {
    const account = personalAccount(`${unique('redirect-race')}@outlook.test`);
    const landed = await slowLinks(() =>
      Promise.all([1, 2].map(() => app.microsoftRedirect(account))),
    );
    expect(landed.some((l) => l.cookie !== null)).toBe(true);
    for (const l of landed) {
      expect(l.path).toBe('/app/');
      expect([null, 'unable_to_create_user']).toContain(l.error);
    }
    expect(await db.owner`select 1 from users where email = ${account.email ?? ''}`).toHaveLength(
      1,
    );
  });
});

describe('which providers are on', () => {
  it('tells the sign-in page, with no session', async () => {
    const res = await app.account('/account/providers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: ['google', 'microsoft'] });
  });

  it('runs with Microsoft alone, where Google is not offered', async () => {
    const alone = startAccountsApp(db, { microsoft, google: false });
    expect(await (await alone.account('/account/providers')).json()).toEqual({
      providers: ['microsoft'],
    });
    const res = await alone.microsoftIdToken(personalAccount(`${unique('solo')}@outlook.test`));
    expect(res.status).toBe(200);
    await expect(alone.signIn()).rejects.toThrow('sign-in failed: 404');
  });

  it('offers only Google where Microsoft is not set up, as before', async () => {
    const before = startAccountsApp(db);
    expect(await (await before.account('/account/providers')).json()).toEqual({
      providers: ['google'],
    });
  });

  it('sends Microsoft sign-in to the common tenant, asking only who the person is', async () => {
    const res = await app.account('/account/auth/sign-in/social', {
      method: 'POST',
      body: { provider: 'microsoft', callbackURL: '/app/' },
    });
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([
      'email',
      'openid',
      'profile',
    ]);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8787/account/auth/callback/microsoft',
    );
  });

  it('has no routes to link or unlink provider accounts by hand', async () => {
    const dana = await app.signIn();
    for (const path of ['/account/auth/link-social', '/account/auth/unlink-account']) {
      const res = await app.account(path, {
        cookie: dana.cookie,
        method: 'POST',
        body: { provider: 'microsoft', providerId: 'microsoft' },
      });
      expect(res.status, path).toBe(404);
    }
  });
});
