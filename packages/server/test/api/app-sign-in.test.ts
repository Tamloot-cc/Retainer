import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ExtensionAppLink, ExtensionInstallation } from '@retainer/extension';
import { decodeJwt } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { setOrganizationMember, setWorkspaceMember } from '../../src/workspaces/organizations.js';
import { type AccountsTestApp, ORIGIN, startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';
import { authorize, token } from '../helpers/oauth.js';

/**
 * Signing in to a standalone app from Retainer's sidebar (extensions spec
 * 8), with real Better Auth, PKCE and Postgres: a member passes straight
 * through with no consent page and gets an ID token naming the workspace,
 * role and installation; nobody else, and no other client, does.
 */
const db = useTestDatabase(),
  appOrigin = 'https://app.example',
  redirectUri = `${appOrigin}/auth/callback`;
let app: AccountsTestApp, clientId: string, otherClient: string;
let manifest: ReturnType<typeof extensionFixture>;

async function register(redirect: string) {
  const response = await startAccountsApp(db).accounts.request(
    `${ORIGIN}/account/auth/oauth2/register`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Planner',
        redirect_uris: [redirect],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'read write offline_access openid email profile',
        resources: [`${ORIGIN}/v1`],
      }),
    },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

beforeAll(async () => {
  clientId = await register(redirectUri);
  otherClient = await register('https://other.example/callback');
  // The client ID differs on every deployment, so the release is built with it.
  manifest = extensionFixture({
    execution: 'standalone',
    scopes: ['read', 'write'],
    oauthClientId: clientId,
    sidebarLink: { label: 'Planner', icon: 'calendar', path: '/start' },
  });
  const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
  app = startAccountsApp(db, { extensionCatalog: catalog });
});

async function json<T = unknown>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body as T;
}

async function setup() {
  const admin = await app.signIn({ name: 'Ada Admin' });
  const workspace = await json<{ id: string; organizationId: string }>(
    await app.account('/account/workspaces', {
      cookie: admin.cookie,
      method: 'POST',
      body: { name: `Sign-in ${randomUUID()}`, template: 'sales' },
    }),
    201,
  );
  const v1 = (cookie: string, path: string, method = 'GET', body?: unknown) =>
    app.api.request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        'x-retainer-client': 'web',
        'x-retainer-workspace': workspace.id,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await json<{ planDigest: string; notices: string[] }>(
    await v1(admin.cookie, '/v1/extensions/preview', 'POST', input),
  );
  expect(preview.notices).toContain(
    'Members can open this app signed in with their Retainer account.',
  );
  const installation = await json<ExtensionInstallation>(
    await v1(admin.cookie, '/v1/extensions', 'POST', { ...input, planDigest: preview.planDigest }),
    201,
  );
  const editor = await app.signIn({ name: 'Eli Editor' });
  const [person] = await db.owner<{ email: string }[]>`
    select email from users where id=${editor.userId}`;
  const email = person?.email ?? '';
  await setOrganizationMember(db.owner, {
    organization: workspace.organizationId,
    email,
    role: 'member',
  });
  await setWorkspaceMember(db.owner, { workspace: workspace.id, email, role: 'editor' });
  return { admin, editor, workspace, installation, v1 };
}

/** The app's authorization request, as its sign-in page builds it from the link. */
function signInQuery(input: {
  installationId: string;
  client?: string;
  redirect?: string;
  scope?: string;
  extra?: Record<string, string>;
}) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: input.client ?? clientId,
    redirect_uri: input.redirect ?? redirectUri,
    scope: input.scope ?? 'openid email profile',
    state: randomBytes(8).toString('hex'),
    nonce: randomBytes(8).toString('hex'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    retainer_installation: input.installationId,
    ...input.extra,
  });
  return { query, verifier };
}
const authorizeAs = (cookie: string | undefined, query: URLSearchParams) =>
  app.accounts.request(`${ORIGIN}/account/auth/oauth2/authorize?${query}`, {
    headers: cookie ? { cookie } : {},
  });

describe('sidebar link', () => {
  it('names the installation on the origin of the app’s registered redirect', async () => {
    const s = await setup();
    const { links } = await json<{ links: ExtensionAppLink[] }>(
      await s.v1(s.editor.cookie, '/v1/extensions/links'),
    );
    expect(links).toEqual([
      {
        installationId: s.installation.id,
        name: manifest.name,
        label: 'Planner',
        icon: 'calendar',
        url: `${appOrigin}/start?retainer_installation=${s.installation.id}`,
      },
    ]);
  });
});

describe('app sign-in', () => {
  it('signs a member in with no consent page and an ID token naming the installation', async () => {
    const s = await setup();
    const { query, verifier } = signInQuery({ installationId: s.installation.id });
    // The app's own request comes from its site, without Retainer's cookie:
    // Better Auth sends it to the sign-in page, which keeps the installation.
    const away = await authorizeAs(undefined, query);
    expect(away.status).toBe(302);
    const signInPage = new URL(away.headers.get('location') ?? '', ORIGIN);
    expect(signInPage.pathname).toBe('/app/oauth/sign-in');
    expect(signInPage.searchParams.get('retainer_installation')).toBe(s.installation.id);

    // Back from that page with the cookie: straight to the app, no consent.
    const response = await authorizeAs(s.editor.cookie, query);
    expect(response.status, await response.clone().text()).toBe(302);
    const callback = new URL(response.headers.get('location') ?? '');
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get('state')).toBe(query.get('state'));
    const tokens = await json<{ id_token: string; access_token: string; refresh_token?: string }>(
      await token(app.accounts, {
        grant_type: 'authorization_code',
        code: callback.searchParams.get('code') ?? '',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    );
    expect(tokens.refresh_token).toBeUndefined();
    const claims = decodeJwt(tokens.id_token);
    expect(claims).toMatchObject({
      sub: s.editor.userId,
      aud: clientId,
      name: 'Eli Editor',
      nonce: query.get('nonce'),
      workspace_id: s.workspace.id,
      workspace_role: 'editor',
      installation_id: s.installation.id,
    });
    expect(claims.email).toEqual(expect.any(String));
    // The sign-in grants no API access.
    const me = await app.api.request(`${ORIGIN}/v1/me`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(me.status).toBe(401);
    // And it is not a connected app.
    const connections = await json<{ connections: unknown[] }>(
      await app.account(`/account/workspaces/${s.workspace.id}/connections`, {
        cookie: s.admin.cookie,
      }),
    );
    expect(connections.connections).toEqual([]);
  });

  it('refuses a person who is not a member', async () => {
    const s = await setup();
    const stranger = await app.signIn();
    const { query } = signInQuery({ installationId: s.installation.id });
    expect((await authorizeAs(stranger.cookie, query)).status).toBe(403);
  });

  it('refuses another client naming the installation, with or without consent', async () => {
    const s = await setup();
    const { query } = signInQuery({
      installationId: s.installation.id,
      client: otherClient,
      redirect: 'https://other.example/callback',
    });
    expect((await authorizeAs(s.editor.cookie, query)).status).toBe(403);
    // Asking for identity any other way is refused before any consent page.
    const mixed = signInQuery({
      installationId: s.installation.id,
      client: otherClient,
      redirect: 'https://other.example/callback',
      scope: 'openid email profile read',
    });
    expect((await authorizeAs(s.editor.cookie, mixed.query)).status).toBe(400);
    const flow = await authorize(app.accounts, {
      cookie: s.editor.cookie,
      clientId: otherClient,
      redirectUri: 'https://other.example/callback',
      scope: 'read',
      resource: `${ORIGIN}/v1`,
    });
    const consented = await app.account('/account/oauth/consent', {
      cookie: s.admin.cookie,
      method: 'POST',
      body: {
        oauth_query: flow.consentUrl.search
          .slice(1)
          .replace('scope=read', 'scope=openid+email+profile'),
        accept: true,
        workspaceId: s.workspace.id,
      },
    });
    expect(consented.status).toBe(400);
  });

  it('ends when the installation is disabled or the person leaves', async () => {
    const s = await setup();
    const { query, verifier } = signInQuery({ installationId: s.installation.id });
    const response = await authorizeAs(s.editor.cookie, query);
    const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
    // Removed between the code and the token: no ID token.
    await db.owner`delete from workspace_members where workspace_id=${s.workspace.id}
      and user_id=${s.editor.userId}`;
    const exchanged = await token(app.accounts, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(400);
    await json(
      await s.v1(s.admin.cookie, `/v1/extensions/${s.installation.id}/disable`, 'POST', {}),
    );
    const again = signInQuery({ installationId: s.installation.id });
    expect((await authorizeAs(s.admin.cookie, again.query)).status).toBe(403);
  });
});
