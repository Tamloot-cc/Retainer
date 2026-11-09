import { expect, test } from './accounts-fixtures.js';

// Accounts mode in the browser (accounts spec 5, 8). Google is faked; the
// web app and the server are the real ones.

test('a new person signs in, names a workspace and lands in it as its admin', async ({
  page,
  context,
  accounts: a,
}) => {
  await page.goto(`${a.url}/app/`);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();

  await a.signIn(context, { email: 'ana@example.test', name: 'Ana Silva' });
  // The app extends the session each time it loads, so active people stay signed in.
  const refresh = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/account/auth/get-session'),
  );
  await page.goto(`${a.url}/app/`);
  await refresh;
  await expect(page.getByRole('heading', { name: 'Welcome, Ana' })).toBeVisible();
  await expect(page.getByText('organization', { exact: false })).not.toBeVisible();
  await page.getByLabel('Name your workspace').fill('Ana Sales');
  await page.getByRole('button', { name: 'Create workspace' }).click();

  await expect(page).toHaveURL(new RegExp(`${a.url}/app/w/ana-sales-[a-z2-9]{4}/$`));
  await expect(page.getByText('Ana Sales').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account: Ana Silva' })).toContainText('Admin');

  // Settings shows only what the person can do; one person, one workspace
  // keeps the Organization tab hidden.
  await page.getByRole('button', { name: 'Account: Ana Silva' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page).toHaveURL(/\/settings/);
  await expect(page.getByRole('button', { name: 'Members', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Organization', exact: true })).not.toBeVisible();
  await expect(page.getByText('Only you have access so far.')).toBeVisible();
});

test('an invited person accepts with the link and gets the role they were given', async ({
  browser,
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, { email: 'olga@example.test', name: 'Olga Owner' });
  await page.goto(`${a.url}/app/`);
  await page.getByLabel('Name your workspace').fill('Acme');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/acme-/);
  const workspaceUrl = page.url();

  await page.goto(`${workspaceUrl}settings`);
  await page.getByRole('button', { name: 'Invite' }).click();
  await page.getByLabel('Email').fill('Ben@Example.test');
  await page.getByRole('button', { name: 'Create invitation link' }).click();
  const link =
    (await page.locator('code').filter({ hasText: '/app/invite/' }).textContent())?.trim() ?? '';
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('ben@example.test')).toBeVisible();

  // Someone signed in as another address cannot use it.
  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  await a.signIn(strangerContext, { email: 'mallory@example.test', name: 'Mallory' });
  await stranger.goto(link);
  await expect(stranger.getByText('This invitation is for ben@example.test')).toBeVisible();
  await strangerContext.close();

  const benContext = await browser.newContext();
  const ben = await benContext.newPage();
  await ben.goto(link);
  await expect(ben.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await a.signIn(benContext, { email: 'ben@example.test', name: 'Ben Editor' });
  await ben.goto(link);
  await expect(ben.getByRole('heading', { name: "Join Olga Owner's organization" })).toBeVisible();
  await expect(ben.getByText('Editor: can also add and change records')).toBeVisible();
  await ben.getByRole('button', { name: 'Accept' }).click();
  await expect(ben).toHaveURL(workspaceUrl);
  await expect(ben.getByRole('button', { name: 'Account: Ben Editor' })).toContainText('Editor');

  // Editors see members but not agents; they are told whom to ask to invite.
  await ben.goto(`${workspaceUrl}settings`);
  await expect(ben.getByRole('button', { name: 'Agents', exact: true })).not.toBeVisible();
  await expect(ben.getByText('To invite someone new, ask Olga Owner.')).toBeVisible();

  // The owner downgrades Ben; it applies at his next request.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Organization', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Role for Ben Editor' }).click();
  await page.getByRole('option', { name: /^Viewer/ }).click();
  // The picker shows the saved role, so this waits for the change to land.
  await expect(page.getByRole('button', { name: 'Role for Ben Editor' })).toContainText('Viewer');
  await ben.goto(workspaceUrl);
  await expect(ben.getByRole('button', { name: 'Account: Ben Editor' })).toContainText('Viewer');
  await benContext.close();
});

test('an admin creates an agent key, sees it once, and revokes it', async ({
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, { email: 'kim@example.test', name: 'Kim' });
  await page.goto(`${a.url}/app/`);
  await page.getByLabel('Name your workspace').fill('Keys');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/keys-/);
  await page.goto(`${page.url()}settings?tab=agents`);
  await page.getByRole('button', { name: 'Create key' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Sales agent');
  await page.getByRole('button', { name: 'Read only' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
  const key = (await page.locator('code').filter({ hasText: 'rtn_' }).textContent())?.trim() ?? '';
  await expect(page.getByText('Connect over MCP')).toBeVisible();

  const me = await fetch(`${a.url}/v1/me`, { headers: { authorization: `Bearer ${key}` } });
  expect(await me.json()).toMatchObject({
    actor: { type: 'agent', name: 'Sales agent' },
    scopes: ['read'],
  });

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: /Sales agent/ })).toBeVisible();
  await expect(page.getByText('Read only')).toBeVisible();
  await expect(page.getByText(key)).not.toBeVisible();
  await page.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke' }).click();
  await expect(page.getByText('No API keys yet')).toBeVisible();
  const after = await fetch(`${a.url}/v1/me`, { headers: { authorization: `Bearer ${key}` } });
  expect(after.status).toBe(401);
});

test('switching workspaces is a page load to the other address', async ({
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, { email: 'sam@example.test', name: 'Sam' });
  await page.goto(`${a.url}/app/`);
  await page.getByLabel('Name your workspace').fill('First');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/first-/);
  await page.getByRole('button', { name: 'Workspace: First' }).click();
  await page.getByRole('menuitem', { name: 'New workspace' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Second');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/second-/);

  await page.getByRole('button', { name: 'Workspace: Second' }).click();
  await page.getByRole('menuitemradio', { name: 'First' }).click();
  await expect(page).toHaveURL(/\/app\/w\/first-/);
  await expect(page.getByRole('button', { name: 'Workspace: First' })).toBeVisible();

  // An address the person cannot open says so, and lists the ones they can.
  await page.goto(`${a.url}/app/w/nobody-here/`);
  await expect(page.getByRole('heading', { name: "You can't open this workspace" })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Second' })).toBeVisible();

  // Your account lists both, with the role in plain words.
  await page.goto(`${a.url}/app/account`);
  await expect(page.getByRole('link', { name: 'First' })).toBeVisible();
  await expect(
    page.getByText('Admin: can also change the workspace', { exact: false }).first(),
  ).toBeVisible();
});

test('a person adds a passkey and signs in with it', async ({
  page,
  context,
  accounts: a,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The virtual authenticator is Chromium only');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  await a.signIn(context, { email: 'pat@example.test', name: 'Pat' });
  await page.goto(`${a.url}/app/`);
  await page.getByLabel('Name your workspace').fill('Passkeys');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/passkeys-/);
  const workspaceUrl = page.url();

  await page.goto(`${a.url}/app/account`);
  await expect(page.getByText('You have no passkeys yet.')).toBeVisible();
  // A day after signing in, adding one asks for a fresh sign-in instead of failing.
  await a.owner`update sessions set created_at = now() - interval '2 days'`;
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText('adding a passkey needs a recent sign-in')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await a.owner`update sessions set created_at = now()`;
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText(/added/)).toBeVisible();
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Test laptop');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Test laptop')).toBeVisible();

  // The sign-in page marks the way this browser last signed in.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toContainText(
    'Last used',
  );
  await expect(page.getByRole('button', { name: 'Use a passkey' })).not.toContainText('Last used');
  await page.goto(workspaceUrl);
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  await expect(page).toHaveURL(workspaceUrl);
  await expect(page.getByRole('button', { name: 'Account: Pat' })).toBeVisible();

  await page.goto(`${a.url}/app/account`);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toContainText('Last used');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).not.toContainText(
    'Last used',
  );
});

test('a sign-out the server refuses says so, and the person stays where they are', async ({
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, { email: 'sam@example.test', name: 'Sam' });
  await page.goto(`${a.url}/app/account`);
  await page.route('**/account/auth/sign-out', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"down"}' }),
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('You are still signed in: signing out failed.')).toBeVisible();
  await expect(page).toHaveURL(`${a.url}/app/account`);

  await page.unroute('**/account/auth/sign-out');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use a passkey' })).toBeVisible();
});

test('adding a passkey that also asks for a session finishes, on a one-connection pool', async ({
  page,
  context,
  accounts: a,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The virtual authenticator is Chromium only');
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await a.signIn(context, { email: 'quinn@example.test', name: 'Quinn' });
  // Better Auth then creates the session inside the registration's
  // transaction; the session hook must read through that transaction.
  await page.route('**/account/auth/passkey/verify-registration', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    await route.continue({ postData: JSON.stringify({ ...body, createSession: true }) });
  });
  await page.goto(`${a.url}/app/account`);
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  await expect(page.getByText(/added/)).toBeVisible({ timeout: 10_000 });
});
