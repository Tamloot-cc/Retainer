import { BROWSER_OAUTH_AUTHORIZE, expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

// Tamloot connect spec 9, "Web": only what needs a real browser and server.
// The screens' states (declined, needs reconnect, the release notice, the
// admin reasons) are web unit tests; this is the round trip and where the
// callback may finish. One test, so one database clone.
test.use({ oauthMemberFixture: true });
test('a member connects through the provider and back; the callback finishes only for them', async ({
  page,
  browser,
  retainer: r,
}) => {
  await r.installOAuthMember();
  // The provider's authorize page: record where Retainer sent the member.
  let authorize: URL | undefined;
  await page.context().route(`${BROWSER_OAUTH_AUTHORIZE}?*`, (route) => {
    authorize = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<h1>Provider approval</h1>' });
  });
  await signIn(page, r.url, r.keys.writer);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: /^oauth-browser/ }).click();
  const own = page.getByRole('region', { name: 'Your Oauth-browser connection' });
  await expect(own.getByLabel('History days (required)')).toHaveValue('31');
  await own.getByRole('button', { name: 'Connect with Oauth-browser' }).click();
  await expect(page.getByRole('heading', { name: 'Provider approval' })).toBeVisible();
  if (!authorize) throw new Error('Retainer never reached the authorize page');
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${r.url}/app/connect/callback`);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const state = authorize.searchParams.get('state') ?? '';
  const callback = (s: string) =>
    `${r.url}/app/connect/callback?${new URLSearchParams({ state: s, code: 'provider-code' })}`;

  // A browser with no Retainer session asks to sign in and never posts the code.
  const elsewhere = await browser.newContext();
  const stranger = await elsewhere.newPage();
  const completions: string[] = [];
  stranger.on('request', (request) => {
    if (request.url().includes('/authorize/complete')) completions.push(request.url());
  });
  await stranger.goto(callback(state));
  await expect(stranger.getByRole('heading', { name: 'Sign in to Retainer' })).toBeVisible();
  // Signed in as another member: the generic message. The server refuses it,
  // and the first member's attempt is untouched (it completes below).
  await signIn(stranger, r.url, r.keys.user);
  await stranger.goto(callback(state));
  await expect(stranger.getByRole('heading', { name: "Connecting didn't finish" })).toBeVisible();
  expect(completions).toHaveLength(1);
  await elsewhere.close();

  // A new page of the member's own browser has empty sessionStorage, as when
  // the provider opens the callback in a new tab. A malformed state can't finish;
  // the real one completes from the state alone and lands on the Connections tab.
  const returned = await page.context().newPage();
  await returned.goto(callback('not-a-state'));
  await expect(returned.getByRole('heading', { name: "Connecting didn't finish" })).toBeVisible();
  await returned.goto(callback(state));
  // The connection's region shows only on the Connections tab.
  await expect(returned).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
  await expect(
    returned.getByRole('region', { name: 'Your Oauth-browser connection' }).getByText(/Connecting/),
  ).toBeVisible();
});
