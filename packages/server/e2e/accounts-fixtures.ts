import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { type BrowserContext, test as base, expect } from '@playwright/test';
import postgres from 'postgres';
import { createAccountsServer } from '../src/accounts/index.js';
import { createApp } from '../src/api/app.js';
import { CONTROL_ROLE, loadConfig } from '../src/config.js';
import { createSql, RUNTIME_ROLE } from '../src/db/client.js';
import { ExtensionCatalog } from '../src/extensions/catalog.js';
import { extensionFixture } from '../test/helpers/extensions.js';
import {
  type FakeMicrosoft,
  MICROSOFT_SETTINGS,
  startFakeMicrosoft,
} from '../test/helpers/microsoft.js';
import { fetchClientMetadata } from '../test/helpers/oauth.js';

/**
 * Accounts mode in the browser (accounts spec 8: Browser layer): the API,
 * /account and the built web app on one origin, with a fake Google that
 * trusts the ID token, which is the profile as JSON, and a fake Microsoft
 * the browser really goes to and comes back from (test/helpers/microsoft.ts).
 * The origin is `localhost`, because passkeys refuse an IP address.
 */

const AUTH_SECRET = 'browser-auth-secret-0123456789abcdef0123456789';

export type Profile = { sub?: string; email: string; name: string };

export const test = base.extend<{
  /** False runs the server with Google alone, as before Microsoft sign-in. */
  withMicrosoft: boolean;
  standaloneOAuth: boolean;
  accounts: {
    url: string;
    owner: ReturnType<typeof createSql>;
    /** Signs a browser context in with Google, as the web app's redirect would. */
    signIn: (context: BrowserContext, profile: Profile) => Promise<void>;
    /** The fake Microsoft, when it is on. */
    microsoft: FakeMicrosoft | null;
    standalone: { clientId: string; registrationId: string; redirectUri: string } | null;
  };
}>({
  withMicrosoft: [true, { option: true }],
  standaloneOAuth: [false, { option: true }],
  accounts: async ({ browserName: _browserName, withMicrosoft, standaloneOAuth }, use) => {
    const microsoft = withMicrosoft ? await startFakeMicrosoft() : null;
    const adminUrl = process.env.DATABASE_URL;
    if (!adminUrl) throw new Error('DATABASE_URL is required');
    const name = `retainer_browser_${randomBytes(6).toString('hex')}`;
    const admin = postgres(adminUrl, { max: 1, onnotice: false });
    await admin.unsafe(
      `create database "${name}" template "${process.env.RETAINER_BROWSER_TEMPLATE}"`,
    );
    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${name}`;
    const owner = createSql(dbUrl.toString()),
      runtime = createSql(dbUrl.toString(), { role: RUNTIME_ROLE }),
      control = createSql(dbUrl.toString(), { role: CONTROL_ROLE }),
      // One connection, as on Lambda, so a Better Auth hook that waits on its
      // own pool inside a transaction hangs here too.
      authControl = createSql(dbUrl.toString(), { role: CONTROL_ROLE, max: 1 });

    // The origin needs the port, so the server listens before the app exists.
    let handle: (request: Request) => Response | Promise<Response> = () =>
      new Response('starting', { status: 503 });
    const server = serve({ fetch: (request) => handle(request), port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listening address');
    const url = `http://localhost:${address.port}`;

    const config = loadConfig({
      DATABASE_URL: dbUrl.toString(),
      RETAINER_AUTH_SECRET: AUTH_SECRET,
      RETAINER_GOOGLE_CLIENT_ID: 'browser-test-client',
      RETAINER_GOOGLE_CLIENT_SECRET: 'browser-test-secret',
      ...(microsoft ? MICROSOFT_SETTINGS : {}),
      RETAINER_PUBLIC_ORIGIN: url,
      LOG_LEVEL: 'error',
    });
    const authOptions = {
      config,
      sql: control,
      authSql: authControl,
      clientIp: () => '127.0.0.1',
      rateLimit: false,
      // Claude's client metadata document, without the internet.
      fetchClientMetadata: fetchClientMetadata as never,
      ...(microsoft ? { microsoftAuthority: microsoft.authority } : {}),
      google: {
        verifyIdToken: async () => true,
        getUserInfo: async (token: { idToken?: string }) => {
          const profile = JSON.parse(token.idToken ?? '{}') as Required<Profile>;
          return {
            user: {
              id: profile.sub,
              email: profile.email,
              name: profile.name,
              emailVerified: true,
            },
            data: profile,
          } as never;
        },
      },
    };
    let accountsApp = createAccountsServer(authOptions);
    let catalog: ExtensionCatalog | undefined;
    let standalone: { clientId: string; registrationId: string; redirectUri: string } | null = null;
    if (standaloneOAuth) {
      const redirectUri = 'https://workspace-app.example/callback';
      const response = await accountsApp.request(`${url}/account/auth/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Browser workspace app',
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: 'read write offline_access',
          resources: [`${url}/v1`],
        }),
      });
      if (response.status !== 201)
        throw new Error(`fixture client failed: ${await response.text()}`);
      const { client_id: clientId } = (await response.json()) as { client_id: string };
      const manifest = extensionFixture({
        name: 'browser-workspace-app',
        execution: 'standalone',
        scopes: ['read', 'write'],
        oauthClientId: clientId,
      });
      catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
      standalone = { clientId, registrationId: manifest.universalId, redirectUri };
      accountsApp = createAccountsServer({
        ...authOptions,
        config: {
          ...config,
          RETAINER_EXTENSION_CATALOG: JSON.stringify(
            catalog.list().map(({ digest: _digest, ...release }) => release),
          ),
        },
      });
    }
    const api = createApp({
      sql: runtime,
      publicOrigin: url,
      accountsSecret: AUTH_SECRET,
      ...(catalog ? { extensionCatalog: catalog } : {}),
      webDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
    });
    handle = (request) => {
      const path = new URL(request.url).pathname;
      return path === '/account' ||
        path.startsWith('/account/') ||
        path.startsWith('/.well-known/oauth-authorization-server')
        ? accountsApp.fetch(request)
        : api.fetch(request);
    };

    async function signIn(context: BrowserContext, profile: Profile) {
      const response = await context.request.post(`${url}/account/auth/sign-in/social`, {
        headers: { origin: url },
        data: {
          provider: 'google',
          idToken: { token: JSON.stringify({ sub: profile.sub ?? randomUUID(), ...profile }) },
        },
      });
      if (!response.ok()) throw new Error(`sign-in failed: ${await response.text()}`);
    }

    try {
      await use({ url, owner, signIn, microsoft, standalone });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      await Promise.all([runtime.end(), control.end(), authControl.end(), owner.end()]);
      await microsoft?.close();
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
    }
  },
});
export { expect };
