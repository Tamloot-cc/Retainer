import { createHash, randomBytes } from 'node:crypto';
import { personalAccount } from '../test/helpers/microsoft.js';
import { CLAUDE_CLIENT_ID, CLAUDE_REDIRECT } from '../test/helpers/oauth.js';
import { expect, test } from './accounts-fixtures.js';

// Connecting Claude in the browser (accounts spec 4.7, 5, 8): Claude opens
// the authorization page, the person signs in, picks a workspace on the
// consent page and allows it; Claude's callback gets a code it exchanges for
// a token that works on /mcp. Claude's site is stubbed: no internet.

const DANA = { sub: 'google-dana', email: 'dana@example.test', name: 'Dana Cohen' };

test('a person connects Claude to the workspace they pick, then disconnects it', async ({
  page,
  context,
  accounts: a,
}) => {
  // Dana has two workspaces; Claude's callback is answered locally.
  await a.signIn(context, DANA);
  for (const name of ['Dana Sales', 'Dana Support']) {
    const created = await context.request.post(`${a.url}/account/workspaces`, {
      headers: { origin: a.url, 'x-retainer-client': 'web' },
      data: { name },
    });
    expect(created.status()).toBe(201);
  }
  await context.clearCookies();
  await page.route('https://claude.ai/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Claude</p>' }),
  );

  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT,
    state: 'from-claude',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${a.url}/mcp`,
    scope: 'read write offline_access',
  });
  await page.goto(`${a.url}/account/auth/oauth2/authorize?${query}`);

  // Signed out: the sign-in page, which keeps the request's address.
  await expect(page).toHaveURL(/\/app\/oauth\/sign-in\?/);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await a.signIn(context, DANA);
  const continued = page.waitForRequest(
    (r) => r.isNavigationRequest() && r.url().includes('/account/auth/oauth2/authorize'),
  );
  await page.reload();
  // The page continues the request sending only its origin as Referer, so a
  // long OAuth address doesn't count twice toward API Gateway's header limit.
  expect(await (await continued).headerValue('referer')).toBe(`${a.url}/`);

  // Signed in: on to consent, which no other site may frame.
  await expect(page).toHaveURL(/\/app\/oauth\/consent\?/);
  const consentPage = await context.request.get(page.url());
  expect(consentPage.headers()['content-security-policy']).toBe("frame-ancestors 'none'");
  expect(consentPage.headers()['referrer-policy']).toBe('strict-origin');
  await expect(page.getByRole('heading', { name: 'Connect Claude to Retainer' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow' })).toBeDisabled();
  await page.getByRole('radio', { name: /Dana Support/ }).check();
  await expect(page.getByText('See everything in the workspace')).toBeVisible();
  await expect(page.getByText('Add and change records, events and notes')).toBeVisible();
  // Any app can call itself Claude; the page names where Allow really goes.
  await expect(page.getByText(/sends you back to claude\.ai/)).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page).toHaveURL(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?/);
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe('from-claude');
  // Claude's own server calls these, with no browser cookies.
  const exchanged = await fetch(`${a.url}/account/auth/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      redirect_uri: CLAUDE_REDIRECT,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
      resource: `${a.url}/mcp`,
    }),
  });
  expect(exchanged.status).toBe(200);
  const { access_token } = (await exchanged.json()) as { access_token: string };
  const mcp = (token: string) =>
    fetch(`${a.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  expect((await mcp(access_token)).status).toBe(200);
  const [workspace] = await a.owner<{ name: string }[]>`
    select w.name from oauth_consents c join workspaces w on w.id = c.reference_id`;
  expect(workspace?.name).toBe('Dana Support');

  // Your account lists it; disconnecting ends its access.
  await page.goto(`${a.url}/app/account`);
  const row = page.getByRole('row', { name: /Claude for Dana Cohen/ });
  await expect(row).toContainText('Dana Support');
  await row.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('No connected apps')).toBeVisible();
  expect((await mcp(access_token)).status).toBe(401);
});

test('a failed Google sign-in comes back to the connection, not the home page', async ({
  page,
  accounts: a,
}) => {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT,
    state: 'from-claude',
    code_challenge: createHash('sha256').update('verifier').digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${a.url}/mcp`,
  });
  await page.route('https://claude.ai/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Elsewhere</p>' }),
  );
  await page.goto(`${a.url}/account/auth/oauth2/authorize?${query}`);
  await expect(page).toHaveURL(/\/app\/oauth\/sign-in\?/);

  // Google sent the person back with an error: the page says so.
  await page.goto(`${page.url()}&error=access_denied`);
  await expect(page.getByText('Signing in did not work. Try again.')).toBeVisible();

  // Trying again keeps the app's request, both for success and for failure.
  let started: { callbackURL?: string; errorCallbackURL?: string } = {};
  await page.route('**/account/auth/sign-in/social', async (route) => {
    started = route.request().postDataJSON() as typeof started;
    await route.fulfill({ json: { url: 'https://claude.ai/google-stand-in', redirect: true } });
  });
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/google-stand-in/);
  for (const url of [started.callbackURL, started.errorCallbackURL]) {
    expect(url).toMatch(/^\/app\/oauth\/sign-in\?/);
    expect(url).toContain(`client_id=${encodeURIComponent(CLAUDE_CLIENT_ID)}`);
    expect(url).not.toContain('error=');
  }
});

test('someone connecting an app signs in with Microsoft and comes back to consent', async ({
  page,
  accounts: a,
}) => {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT,
    state: 'from-claude',
    code_challenge: createHash('sha256').update('verifier').digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${a.url}/mcp`,
  });
  await page.goto(`${a.url}/account/auth/oauth2/authorize?${query}`);
  await expect(page).toHaveURL(/\/app\/oauth\/sign-in\?/);
  a.microsoft?.signInNextAs(personalAccount('mo@outlook.test', 'Mo Personal'));
  await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
  // Back from Microsoft on the same request, then on to consent.
  await expect(page).toHaveURL(/\/app\/oauth\/consent\?/);
  expect(new URL(page.url()).searchParams.get('client_id')).toBe(CLAUDE_CLIENT_ID);
});

test('someone with no workspace can still say no, so the app stops waiting', async ({
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, { sub: 'google-newcomer', email: 'new@example.test', name: 'New' });
  await page.route('https://claude.ai/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Claude</p>' }),
  );
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: CLAUDE_CLIENT_ID,
    redirect_uri: CLAUDE_REDIRECT,
    state: 'from-claude',
    code_challenge: createHash('sha256').update('verifier').digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${a.url}/mcp`,
  });
  await page.goto(`${a.url}/account/auth/oauth2/authorize?${query}`);
  if (/\/app\/oauth\/sign-in\?/.test(page.url())) await page.reload();
  await expect(page).toHaveURL(/\/app\/oauth\/consent\?/);
  await expect(page.getByText('You have no workspace yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page).toHaveURL(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?/);
  expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied');
});
