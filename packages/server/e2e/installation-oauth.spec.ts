import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from './accounts-fixtures.js';

test.use({ standaloneOAuth: true });
test('reviews workspace app OAuth in the browser and disconnects it from Extensions', async ({
  page,
  context,
  accounts: a,
}) => {
  const app = a.standalone;
  if (!app) throw new Error('standalone fixture missing');
  await a.signIn(context, {
    sub: 'workspace-admin',
    email: 'admin@workspace.example',
    name: 'Workspace admin',
  });
  const created = await context.request.post(`${a.url}/account/workspaces`, {
    headers: { origin: a.url, 'x-retainer-client': 'web' },
    data: { name: 'App workspace', template: 'sales' },
  });
  expect(created.status()).toBe(201);
  const workspace = (await created.json()) as { id: string; slug: string };
  const extensionsUrl = `${a.url}/app/w/${workspace.slug}/extensions`;
  await page.goto(extensionsUrl);
  await page.getByRole('link', { name: 'Set up browser-workspace-app', exact: true }).click();
  await page.getByRole('button', { name: 'Approve installation' }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await page.route('https://workspace-app.example/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Workspace app</p>' }),
  );
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    state: 'workspace-app-state',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${a.url}/v1`,
    scope: 'read write offline_access',
  });
  await page.goto(`${a.url}/account/auth/oauth2/authorize?${query}`);
  if (/\/app\/oauth\/sign-in\?/.test(page.url())) await page.reload();
  await expect(page).toHaveURL(/\/app\/oauth\/consent\?/);
  await expect(
    page.getByRole('heading', { name: 'Connect Browser workspace app to this workspace' }),
  ).toBeVisible();
  await expect(page.getByText(/will act as an integration/)).toBeVisible();
  await expect(page.getByText(/continues if you leave/)).toBeVisible();
  await expect(page.getByText(/cannot read your personal memory/)).toBeVisible();
  await expect(page.getByText(/sends you back to/)).toContainText('workspace-app.example');
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(page).toHaveURL(/^https:\/\/workspace-app\.example\/callback\?/);
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe('workspace-app-state');
  const exchanged = await fetch(`${a.url}/account/auth/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      client_id: app.clientId,
      redirect_uri: app.redirectUri,
      code_verifier: verifier,
      resource: `${a.url}/v1`,
    }),
  });
  expect(exchanged.status).toBe(200);
  const tokens = (await exchanged.json()) as { access_token: string; refresh_token: string };
  const me = () =>
    fetch(`${a.url}/v1/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
  expect(await (await me()).json()).toMatchObject({
    person: false,
    actor: { type: 'integration' },
  });
  await page.goto(extensionsUrl);
  await page.getByRole('link', { name: /^browser-workspace-app/ }).click();
  await page.getByRole('button', { name: 'App credentials', exact: true }).click();
  const credentials = page.getByRole('main');
  await expect(credentials.getByRole('button', { name: 'Create installation key' })).toHaveCount(0);
  await credentials.getByRole('button', { name: 'Revoke connection', exact: true }).click();
  await expect(credentials.getByText('OAuth connection · Inactive')).toBeVisible();
  expect((await me()).status).toBe(401);
  const refresh = await fetch(`${a.url}/account/auth/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: app.clientId,
      resource: `${a.url}/v1`,
    }),
  });
  expect(refresh.status).toBeGreaterThanOrEqual(400);
});
