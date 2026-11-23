import { createHash, randomBytes } from 'node:crypto';
import { CLAUDE_CLIENT_ID, CLAUDE_REDIRECT } from '../test/helpers/oauth.js';
import { expect, test } from './accounts-fixtures.js';

// An address pinned to one workspace (accounts spec 4.7): Claude connects to
// /mcp/w/<ID>, the consent page offers only that workspace, and the token
// works at that address alone. Settings, Agents shows each workspace's
// address. Claude's site is stubbed: no internet.

const DANA = { sub: 'google-dana-pinned', email: 'dana@example.test', name: 'Dana Cohen' };

test('a person connects Claude through a pinned address, to that workspace only', async ({
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, DANA);
  const workspaces: { id: string; slug: string }[] = [];
  for (const name of ['Dana Sales', 'Dana Support']) {
    const created = await context.request.post(`${a.url}/account/workspaces`, {
      headers: { origin: a.url, 'x-retainer-client': 'web' },
      data: { name, template: 'starter' },
    });
    expect(created.status()).toBe(201);
    workspaces.push((await created.json()) as { id: string; slug: string });
  }
  const [sales, support] = workspaces;
  if (!sales || !support) throw new Error('workspaces were not created');
  const pinned = `${a.url}/mcp/w/${support.id}`;

  // Settings, Agents gives the workspace's own address to copy.
  await page.goto(`${a.url}/app/w/${support.slug}/settings?tab=agents`);
  await expect(page.getByText(pinned)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy address' })).toBeVisible();

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
    resource: pinned,
    scope: 'read write offline_access',
  });
  await page.goto(`${a.url}/account/auth/oauth2/authorize?${query}`);

  // Consent offers Dana Support alone: no picker, and Allow is ready.
  await expect(page).toHaveURL(/\/app\/oauth\/consent\?/);
  await expect(page.getByRole('heading', { name: 'Connect Claude to Retainer' })).toBeVisible();
  await expect(page.getByText('Dana Support')).toBeVisible();
  await expect(page.getByText('Dana Sales')).not.toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page).toHaveURL(/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?/);
  const callback = new URL(page.url());
  const exchanged = await fetch(`${a.url}/account/auth/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code') ?? '',
      redirect_uri: CLAUDE_REDIRECT,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
      resource: pinned,
    }),
  });
  expect(exchanged.status).toBe(200);
  const { access_token } = (await exchanged.json()) as { access_token: string };
  const mcp = (path: string) =>
    fetch(`${a.url}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  expect((await mcp(`/mcp/w/${support.id}`)).status).toBe(200);
  expect((await mcp('/mcp')).status).toBe(401);
  expect((await mcp(`/mcp/w/${sales.id}`)).status).toBe(401);
});
