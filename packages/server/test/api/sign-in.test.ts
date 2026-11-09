import { createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { verifySessionCookie } from '../../src/auth/account-session.js';
import { createApiKey } from '../../src/auth/keys.js';
import {
  createOrganization,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import {
  type AccountsTestApp,
  AUTH_SECRET,
  lastSignInCookie,
  ORIGIN,
  sessionCookie,
  startAccountsApp,
} from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';

// Signing in and the API's session check (accounts spec 4.4, 8: API and
// Contract layers). Sessions come from Better Auth's real endpoints.

const db = useTestDatabase();
let app: AccountsTestApp;
let organizationId: string;
let workspaceId: string;
let otherWorkspaceId: string;

beforeAll(async () => {
  app = startAccountsApp(db);
  organizationId = (await createOrganization(db.owner, { name: 'Acme' })).id;
  workspaceId = (
    await createWorkspace(db.owner, {
      name: 'Acme CRM',
      template: 'sales',
      organization: organizationId,
    })
  ).id;
  otherWorkspaceId = (await createWorkspace(db.owner, { name: 'Elsewhere' })).id;
});

/** Starts a Google sign-in the way the web app does: the redirect to Google. */
async function startGoogleRedirect(): Promise<{ state: string; cookie: string }> {
  const res = await app.accounts.request(`${ORIGIN}/account/auth/sign-in/social`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'google', callbackURL: '/app/', errorCallbackURL: '/app/' }),
  });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const state = new URL(url).searchParams.get('state') ?? '';
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { state, cookie };
}

/** A person in Acme with `role` in its workspace. */
async function member(
  role: 'viewer' | 'editor' | 'admin',
  email = `${role}-${Math.random().toString(16).slice(2, 8)}@acme.test`,
) {
  const signedIn = await app.signIn({ email, name: `Dana ${role}` });
  await setOrganizationMember(db.owner, { organization: organizationId, email, role: 'member' });
  await setWorkspaceMember(db.owner, { workspace: workspaceId, email, role });
  return { ...signedIn, email };
}

describe('signing in with Google', () => {
  it('creates the person once, keyed by Google subject, with a lowercase email', async () => {
    const first = await app.signIn({ sub: 'google-sub-1', email: 'Mixed.Case@Example.TEST' });
    const again = await app.signIn({ sub: 'google-sub-1', email: 'Mixed.Case@Example.TEST' });
    expect(again.userId).toBe(first.userId);
    const [user] =
      await db.owner`select email, email_verified from users where id = ${first.userId}`;
    expect(user).toEqual({ email: 'mixed.case@example.test', email_verified: true });
    const [link] =
      await db.owner`select provider_id, account_id from auth_accounts where user_id = ${first.userId}`;
    expect(link).toEqual({ provider_id: 'google', account_id: 'google-sub-1' });
  });

  it('signs every simultaneous first sign-in in as the one person they make', async () => {
    const profile = { sub: 'google-race', email: 'race@example.test' };
    // Six at once. Without the retry all but one are refused (9.2). Linking
    // the Google account is slowed down here, so any sign-in that could see
    // the new person before their link would be refused as unlinked.
    await db.owner.unsafe(`
      create function slow_link() returns trigger language plpgsql
        as $$ begin perform pg_sleep(0.3); return new; end $$;
      create trigger slow_link before insert on auth_accounts
        for each row execute function slow_link();`);
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => app.signIn(profile))).finally(
      () => db.owner.unsafe('drop trigger slow_link on auth_accounts; drop function slow_link();'),
    );
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect(await db.owner`select 1 from users where email = 'race@example.test'`).toHaveLength(1);
    expect(
      await db.owner`select 1 from auth_accounts where account_id = 'google-race'`,
    ).toHaveLength(1);
  });

  it('sends a tab that loses a simultaneous Google redirect back to sign in again', async () => {
    const profile = { sub: 'google-redirect-race', email: 'redirect-race@example.test' };
    // Google's code exchange, which a test cannot reach.
    const realFetch = globalThis.fetch;
    const google = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith('https://oauth2.googleapis.com/token')) return realFetch(input, init);
      return Response.json({
        access_token: 'google-access',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: JSON.stringify({ ...profile, name: 'Racer', email_verified: true }),
      });
    });
    try {
      const started = await Promise.all([1, 2].map(() => startGoogleRedirect()));
      const landed = await Promise.all(
        started.map(({ state, cookie }, i) =>
          app.accounts.request(
            `${ORIGIN}/account/auth/callback/google?code=code-${i}&state=${state}`,
            { headers: { cookie } },
          ),
        ),
      );
      const places = landed.map((res) => {
        expect(res.status).toBe(302);
        const place = new URL(res.headers.get('location') ?? '', ORIGIN);
        return `${place.pathname}${place.search}`;
      });
      // At least one tab is signed in; any other comes back with the code
      // the sign-in page turns into "sign in again", not "not verified".
      expect(places).toContain('/app/');
      for (const place of places) {
        expect(['/app/', '/app/?error=unable_to_create_user']).toContain(place);
      }
    } finally {
      google.mockRestore();
    }
    expect(
      await db.owner`select 1 from users where email = 'redirect-race@example.test'`,
    ).toHaveLength(1);
  });

  it('refuses an address Google has not verified, saying so', async () => {
    await expect(
      app.signIn({ email: 'unverified@example.test', email_verified: false }),
    ).rejects.toThrow('"code":"email_not_verified"');
    expect(
      await db.owner`select 1 from users where email = 'unverified@example.test'`,
    ).toHaveLength(0);
  });

  it('sets a Strict, HTTP-only session cookie', async () => {
    const res = await app.accounts.request(`${ORIGIN}/account/auth/sign-in/social`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        idToken: {
          token: JSON.stringify({ sub: 'cookie-sub', email: 'cookie@example.test', name: 'C' }),
        },
      }),
    });
    const cookie = res.headers.getSetCookie().find((c) => c.includes('.session_token='));
    expect(cookie).toMatch(/^retainer\.session_token=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
  });

  it('remembers Google as the last way in, in a cookie the page can read', async () => {
    const res = await app.googleIdToken();
    expect(res.status).toBe(200);
    const last = lastSignInCookie(res);
    expect(last?.value).toBe('google');
    expect(last?.header).not.toMatch(/HttpOnly/i);
    expect(last?.header).toMatch(/SameSite=Strict/i);
    expect(last?.header).toMatch(/Max-Age=31536000/);
  });

  it('remembers nothing when the sign-in is refused', async () => {
    const res = await app.googleIdToken({ email_verified: false });
    expect(res.status).toBe(401);
    expect(lastSignInCookie(res)).toBeNull();
  });

  it('leaves the last way in alone when a session is only extended', async () => {
    const { cookie, userId } = await app.signIn();
    await db.owner`update sessions set expires_at = now() + interval '20 days', updated_at = now() - interval '10 days'
      where user_id = ${userId}`;
    const res = await app.account('/account/auth/get-session', {
      cookie,
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).not.toBeNull();
    expect(lastSignInCookie(res)).toBeNull();
  });

  it("extends an active session on the web app's POST, and never on a read", async () => {
    const dana = await member('viewer');
    const ageSession = () =>
      db.owner`update sessions set expires_at = now() + interval '20 days', updated_at = now() - interval '10 days'
        where user_id = ${dana.userId}`;
    const expiry = async () =>
      (
        await db.owner<{ days: number }[]>`
        select (extract(epoch from expires_at - now()) / 86400)::float8 as days from sessions
        where user_id = ${dana.userId}`
      )[0]?.days ?? 0;
    await ageSession();
    expect((await app.account('/account', { cookie: dana.cookie })).status).toBe(200);
    expect(await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId })).toBeTruthy();
    expect(await expiry()).toBeLessThan(21);

    const res = await app.account('/account/auth/get-session', {
      cookie: dana.cookie,
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(200);
    expect(await expiry()).toBeGreaterThan(29);
  });

  it('refuses a disabled person a new session', async () => {
    await app.signIn({ sub: 'disabled-sub', email: 'disabled@example.test' });
    await db.owner`update users set disabled_at = now() where email = 'disabled@example.test'`;
    await expect(
      app.signIn({ sub: 'disabled-sub', email: 'disabled@example.test' }),
    ).rejects.toThrow('sign-in failed');
  });
});

describe('the API checking a session', () => {
  it('passes a real Better Auth cookie, with the person as the actor (contract)', async () => {
    const dana = await member('editor');
    const res = await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      workspace: { id: workspaceId },
      actor: { type: 'user', id: dana.userId, name: 'Dana editor' },
      scopes: ['read', 'write'],
    });
    // The format the API relies on: <token>.<base64 HMAC-SHA256>.
    const value = decodeURIComponent(dana.cookie.split('=').slice(1).join('='));
    expect(verifySessionCookie(value, AUTH_SECRET)).toMatch(/^\S+$/);
  });

  it('answers 404 for a workspace the person has no role in, existing or not', async () => {
    const dana = await member('viewer');
    for (const workspace of [otherWorkspaceId, '00000000-0000-4000-8000-000000000000']) {
      const res = await app.v1('/v1/me', { cookie: dana.cookie, workspace });
      expect(res.status, workspace).toBe(404);
    }
  });

  it('finds the workspace by ID only, even when another slug is that ID', async () => {
    const dana = await member('viewer');
    const target = (await createWorkspace(db.owner, { name: 'Not Dana’s' })).id;
    // A workspace Dana is in whose slug is the ID of one she isn't in.
    const decoy = (
      await createWorkspace(db.owner, {
        name: 'Decoy',
        slug: target,
        organization: organizationId,
      })
    ).id;
    await setWorkspaceMember(db.owner, { workspace: decoy, email: dana.email, role: 'admin' });
    const token = verifySessionCookie(
      decodeURIComponent(dana.cookie.split('=').slice(1).join('=')),
      AUTH_SECRET,
    );
    // Exactly one row, for the named workspace, and Dana has no role in it.
    expect(
      await db.owner`select workspace_id, role from retainer_session_access(${token}, ${target})`,
    ).toEqual([{ workspace_id: target, role: null }]);
    const res = await app.v1('/v1/me', { cookie: dana.cookie, workspace: target });
    expect(res.status).toBe(404);
  });

  it('needs the workspace header, as an ID', async () => {
    const dana = await member('viewer');
    expect((await app.v1('/v1/me', { cookie: dana.cookie })).status).toBe(400);
    expect((await app.v1('/v1/me', { cookie: dana.cookie, workspace: 'acme-crm' })).status).toBe(
      400,
    );
  });

  it('refuses a forged cookie and a raw token without its signature', async () => {
    const dana = await member('viewer');
    const value = decodeURIComponent(dana.cookie.split('=').slice(1).join('='));
    const token = value.slice(0, value.lastIndexOf('.'));
    const forged = `${token}.${createHmac('sha256', 'not-the-secret-0123456789abcdef01').update(token).digest('base64')}`;
    for (const cookie of [
      `retainer.session_token=${encodeURIComponent(forged)}`,
      `retainer.session_token=${encodeURIComponent(token)}`,
    ]) {
      const res = await app.v1('/v1/me', { cookie, workspace: workspaceId });
      expect(res.status).toBe(401);
    }
  });

  it('applies a downgrade, a removal and a sign-out at the next request', async () => {
    const dana = await member('editor');
    const write = () =>
      app.v1('/v1/objects/company/records', {
        cookie: dana.cookie,
        workspace: workspaceId,
        method: 'POST',
        body: { values: { name: 'Initech' } },
      });
    expect((await write()).status).toBe(201);

    await setWorkspaceMember(db.owner, {
      workspace: workspaceId,
      email: dana.email,
      role: 'viewer',
    });
    const denied = await write();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: { message: expect.stringContaining('Your role in this workspace lets you look') },
    });

    await db.owner`delete from workspace_members where user_id = ${dana.userId}`;
    expect((await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId })).status).toBe(
      404,
    );

    await setWorkspaceMember(db.owner, {
      workspace: workspaceId,
      email: dana.email,
      role: 'viewer',
    });
    await db.owner`delete from sessions where user_id = ${dana.userId}`;
    expect((await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId })).status).toBe(
      401,
    );
  });

  it("ends a disabled person's access at their next request", async () => {
    const dana = await member('viewer');
    await db.owner`update users set disabled_at = now() where id = ${dana.userId}`;
    expect((await app.v1('/v1/me', { cookie: dana.cookie, workspace: workspaceId })).status).toBe(
      401,
    );
    expect((await app.account('/account', { cookie: dana.cookie })).status).toBe(401);
  });

  it('makes organization owners and admins admin in every workspace', async () => {
    const olga = await app.signIn({ email: 'olga@acme.test', name: 'Olga' });
    await setOrganizationMember(db.owner, {
      organization: organizationId,
      email: 'olga@acme.test',
      role: 'admin',
    });
    const res = await app.v1('/v1/me', { cookie: olga.cookie, workspace: workspaceId });
    expect(await res.json()).toMatchObject({ scopes: ['read', 'write', 'schema:write', 'admin'] });
  });

  it('still requires the web header on cookie mutations', async () => {
    const dana = await member('editor');
    const res = await app.api.request(`${ORIGIN}/v1/objects/company/records`, {
      method: 'POST',
      headers: {
        cookie: dana.cookie,
        'x-retainer-workspace': workspaceId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ values: { name: 'No header' } }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a bearer request that names another workspace', async () => {
    const { key } = await createApiKey(db.owner, {
      workspace: workspaceId,
      name: 'Agent',
      actor: { type: 'agent', id: 'sign-in-test' },
      scopes: ['read'],
    });
    const headers = { authorization: `Bearer ${key}` };
    expect((await app.api.request(`${ORIGIN}/v1/me`, { headers })).status).toBe(200);
    const mismatch = await app.api.request(`${ORIGIN}/v1/me`, {
      headers: { ...headers, 'x-retainer-workspace': otherWorkspaceId },
    });
    expect(mismatch.status).toBe(400);
  });

  it('has no key-mode sign-in in accounts mode', async () => {
    const res = await app.api.request(`${ORIGIN}/auth/session`, {
      method: 'POST',
      headers: { 'x-retainer-client': 'web', 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'rtn_anything' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('/account', () => {
  it('refuses an API key', async () => {
    const { key } = await createApiKey(db.owner, {
      workspace: workspaceId,
      name: 'Admin agent',
      actor: { type: 'agent', id: 'admin-agent' },
      scopes: ['admin'],
    });
    const res = await app.accounts.request(`${ORIGIN}/account`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });

  it('needs a session', async () => {
    expect((await app.account('/account')).status).toBe(401);
  });

  it("lists the person's organizations and the workspaces they can reach, with roles", async () => {
    const dana = await member('viewer', 'dana.lists@acme.test');
    await createWorkspace(db.owner, { name: 'Acme Hidden', organization: organizationId });
    const res = await app.account('/account', { cookie: dana.cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: dana.userId, name: 'Dana viewer', email: 'dana.lists@acme.test' },
      organizations: [
        {
          id: organizationId,
          name: 'Acme',
          role: 'member',
          workspaces: [{ id: workspaceId, slug: 'acme-crm', name: 'Acme CRM', role: 'viewer' }],
        },
      ],
      invitations: [],
      providers: ['google'],
    });
  });
});
