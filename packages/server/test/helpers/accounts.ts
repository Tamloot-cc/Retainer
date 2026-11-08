import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { createAccountsServer } from '../../src/accounts/index.js';
import { createApp } from '../../src/api/app.js';
import { CONTROL_ROLE, loadConfig } from '../../src/config.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import type { TestDatabase } from './db.js';
import {
  type FakeMicrosoft,
  MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET,
  type MicrosoftAccount,
} from './microsoft.js';

/**
 * Accounts mode in-process (accounts spec 8): the API and /account, with a
 * fake Google and, when a test asks, a fake Microsoft. Tests sign in through
 * Better Auth's real endpoints. The Google fake trusts the ID token, which is
 * the profile as JSON; the Microsoft one is a local server that signs real
 * tokens (microsoft.ts), so Retainer's own Microsoft rule runs unchanged.
 */

export const ORIGIN = 'http://localhost:8787';
export const AUTH_SECRET = 'test-auth-secret-0123456789abcdef0123456789';

export type GoogleProfile = {
  sub: string;
  email: string;
  name: string;
  email_verified?: boolean;
};

export type AccountsTestApp = {
  /** /account, as the control function serves it. */
  accounts: Hono;
  /** /v1 and the rest, as the api function serves it. */
  api: ReturnType<typeof createApp>;
  /** Signs in with Google; returns the Cookie header to send. */
  signIn: (profile?: Partial<GoogleProfile>) => Promise<{ cookie: string; userId: string }>;
  /** Signs in with a Microsoft ID token; the response, as Better Auth gives it. */
  microsoftIdToken: (account: MicrosoftAccount) => Promise<Response>;
  /**
   * Signs in through Microsoft's redirect, as the web app does: starts it,
   * then lands on the callback with a code for the account. Returns where the
   * browser is sent, the error it carries, and the session cookie if one was set.
   */
  microsoftRedirect: (
    account: MicrosoftAccount,
  ) => Promise<{ path: string; error: string | null; cookie: string | null }>;
  /** A request to /account with the web app's headers. */
  account: (
    path: string,
    init?: { method?: string; cookie?: string; body?: unknown },
  ) => Promise<Response>;
  /** A request to /v1 with a session cookie, in one workspace. */
  v1: (
    path: string,
    init: { cookie: string; workspace?: string; method?: string; body?: unknown },
  ) => Promise<Response>;
};

export function startAccountsApp(
  db: TestDatabase,
  options: {
    /** Serves client metadata documents, which come from the internet in production. */
    fetchClientMetadata?: (input: string | URL | Request) => Promise<Response>;
    /** Turns Microsoft sign-in on, against this fake. */
    microsoft?: FakeMicrosoft;
    /** False runs with Microsoft alone. */
    google?: boolean;
  } = {},
): AccountsTestApp {
  const config = loadConfig({
    DATABASE_URL: db.url,
    RETAINER_AUTH_SECRET: AUTH_SECRET,
    ...(options.google === false
      ? {}
      : { RETAINER_GOOGLE_CLIENT_ID: 'test-client', RETAINER_GOOGLE_CLIENT_SECRET: 'test-secret' }),
    ...(options.microsoft
      ? {
          RETAINER_MICROSOFT_CLIENT_ID: MICROSOFT_CLIENT_ID,
          RETAINER_MICROSOFT_CLIENT_SECRET: MICROSOFT_CLIENT_SECRET,
        }
      : {}),
    RETAINER_PUBLIC_ORIGIN: ORIGIN,
    LOG_LEVEL: 'error',
  });
  const accounts = createAccountsServer({
    config,
    sql: db.connect({ role: CONTROL_ROLE, max: 4 }),
    authSql: db.connect({ role: CONTROL_ROLE, max: 4 }),
    clientIp: () => '192.0.2.1',
    rateLimit: false,
    ...(options.fetchClientMetadata
      ? { fetchClientMetadata: options.fetchClientMetadata as never }
      : {}),
    ...(options.microsoft ? { microsoftAuthority: options.microsoft.authority } : {}),
    google: {
      verifyIdToken: async () => true,
      getUserInfo: async (token) => {
        const profile = JSON.parse(token.idToken ?? '{}') as GoogleProfile;
        // Better Auth's own type for this is narrower than what it accepts.
        return {
          user: {
            id: profile.sub,
            email: profile.email,
            name: profile.name,
            emailVerified: profile.email_verified ?? true,
          },
          data: profile,
        } as never;
      },
    },
  }) as unknown as Hono;
  const api = createApp({
    sql: db.connect({ role: RUNTIME_ROLE, max: 4 }),
    publicOrigin: ORIGIN,
    accountsSecret: AUTH_SECRET,
  });

  const json = (body: unknown) =>
    body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };

  return {
    accounts,
    api,
    signIn: async (input = {}) => {
      const profile: GoogleProfile = {
        sub: input.sub ?? randomUUID(),
        email: input.email ?? `${randomUUID().slice(0, 8)}@example.test`,
        name: input.name ?? 'Test Person',
        email_verified: input.email_verified ?? true,
      };
      const res = await accounts.request(`${ORIGIN}/account/auth/sign-in/social`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google', idToken: { token: JSON.stringify(profile) } }),
      });
      if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
      const setCookie = res.headers.getSetCookie().find((c) => c.includes('.session_token='));
      if (!setCookie) throw new Error('sign-in set no session cookie');
      const body = (await res.json()) as { user: { id: string } };
      return { cookie: setCookie.split(';')[0] ?? '', userId: body.user.id };
    },
    microsoftIdToken: async (account) => {
      if (!options.microsoft) throw new Error('start the app with a fake Microsoft');
      return accounts.request(`${ORIGIN}/account/auth/sign-in/social`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'microsoft',
          idToken: { token: await options.microsoft.idToken(account) },
        }),
      });
    },
    microsoftRedirect: async (account) => {
      const microsoft = options.microsoft;
      if (!microsoft) throw new Error('start the app with a fake Microsoft');
      const started = await accounts.request(`${ORIGIN}/account/auth/sign-in/social`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'microsoft',
          callbackURL: '/app/',
          errorCallbackURL: '/app/',
        }),
      });
      if (!started.ok) throw new Error(`could not start: ${started.status}`);
      const { url } = (await started.json()) as { url: string };
      const authorize = new URL(url);
      if (!authorize.href.startsWith(`${microsoft.authority}/common/oauth2/v2.0/authorize`)) {
        throw new Error(`sent to ${authorize.origin}${authorize.pathname}`);
      }
      const state = authorize.searchParams.get('state') ?? '';
      const landed = await accounts.request(
        `${ORIGIN}/account/auth/callback/microsoft?code=${microsoft.codeFor(account)}&state=${state}`,
        {
          headers: {
            cookie: started.headers
              .getSetCookie()
              .map((c) => c.split(';')[0])
              .join('; '),
          },
        },
      );
      if (landed.status !== 302) throw new Error(`callback answered ${landed.status}`);
      const place = new URL(landed.headers.get('location') ?? '', ORIGIN);
      const session = landed.headers.getSetCookie().find((c) => c.includes('.session_token='));
      return {
        path: place.pathname,
        error: place.searchParams.get('error'),
        cookie: session ? (session.split(';')[0] ?? null) : null,
      };
    },
    account: async (path, init = {}) => {
      const body = json(init.body);
      return accounts.request(`${ORIGIN}${path}`, {
        method: init.method ?? 'GET',
        ...body,
        headers: {
          origin: ORIGIN,
          'x-retainer-client': 'web',
          ...(init.cookie ? { cookie: init.cookie } : {}),
          ...('headers' in body ? body.headers : {}),
        },
      });
    },
    v1: async (path, init) => {
      const body = json(init.body);
      return api.request(`${ORIGIN}${path}`, {
        method: init.method ?? 'GET',
        ...body,
        headers: {
          origin: ORIGIN,
          'x-retainer-client': 'web',
          cookie: init.cookie,
          ...(init.workspace ? { 'x-retainer-workspace': init.workspace } : {}),
          ...('headers' in body ? body.headers : {}),
        },
      });
    },
  };
}
