import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { createAccountsServer } from '../../src/accounts/index.js';
import { createApp } from '../../src/api/app.js';
import { CONTROL_ROLE, loadConfig } from '../../src/config.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import type { TestDatabase } from './db.js';

/**
 * Accounts mode in-process (accounts spec 8): the API and /account, with a
 * fake Google. Tests sign in through Better Auth's real endpoints; the fake
 * trusts the ID token, which is the profile as JSON.
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
  } = {},
): AccountsTestApp {
  const config = loadConfig({
    DATABASE_URL: db.url,
    RETAINER_AUTH_SECRET: AUTH_SECRET,
    RETAINER_GOOGLE_CLIENT_ID: 'test-client',
    RETAINER_GOOGLE_CLIENT_SECRET: 'test-secret',
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
