import { personalAccount, workAccount } from '../test/helpers/microsoft.js';
import { expect, test } from './accounts-fixtures.js';

// Microsoft sign-in in the browser (accounts spec 4.4, 4.5, 5). The browser
// really goes to the fake Microsoft and comes back through Better Auth's
// callback, as it would with Microsoft's own sign-in page.

test('a new person continues with Microsoft and names their workspace', async ({
  page,
  accounts: a,
}) => {
  await page.goto(`${a.url}/app/`);
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeVisible();
  await expect(page.getByText('New here? Continue with Google or Microsoft')).toBeVisible();

  a.microsoft?.signInNextAs(personalAccount('mia@outlook.test', 'Mia Personal'));
  await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome, Mia' })).toBeVisible();
  await page.getByLabel('Name your workspace').fill('Mia Sales');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/mia-sales-/);
  await expect(page.getByRole('button', { name: 'Account: Mia Personal' })).toContainText('Admin');
});

test('a work account whose address Microsoft has not verified is told why', async ({
  page,
  accounts: a,
}) => {
  await page.goto(`${a.url}/app/`);
  a.microsoft?.signInNextAs(workAccount('wes@contoso.test', { verified: false }));
  await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
  await expect(page).toHaveURL(/error=email_not_verified/);
  await expect(page.getByText('That account has no verified email address')).toBeVisible();
  await expect(page.getByText('your IT admin can verify your email domain')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toBeEnabled();
});

test('an unverified Microsoft address does not reach the Google person who has it', async ({
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, { email: 'vic@acme.test', name: 'Vic Google' });
  await page.goto(`${a.url}/app/`);
  await expect(page.getByRole('heading', { name: 'Welcome, Vic' })).toBeVisible();
  await context.clearCookies();

  await page.goto(`${a.url}/app/`);
  a.microsoft?.signInNextAs(workAccount('vic@acme.test', { verified: false, name: 'Impostor' }));
  await page.getByRole('button', { name: 'Continue with Microsoft' }).click();
  await expect(page).toHaveURL(/error=account_not_linked/);
  await expect(page.getByText('Sign in the way you did before')).toBeVisible();
  const cookies = await context.cookies();
  expect(cookies.some((c) => c.name.endsWith('.session_token'))).toBe(false);
});

test('an invited person signs in with a verified work account and accepts', async ({
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
  await expect(page.getByText('sign in with the Google or Microsoft account')).toBeVisible();
  await page.getByLabel('Email').fill('nina@fabrikam.test');
  await page.getByRole('button', { name: 'Create invitation link' }).click();
  const link =
    (await page.locator('code').filter({ hasText: '/app/invite/' }).textContent())?.trim() ?? '';

  const ninaContext = await browser.newContext();
  const nina = await ninaContext.newPage();
  await nina.goto(link);
  a.microsoft?.signInNextAs(
    workAccount('Nina@Fabrikam.test', { verified: true, name: 'Nina Work' }),
  );
  await nina.getByRole('button', { name: 'Continue with Microsoft' }).click();
  await expect(nina.getByRole('heading', { name: "Join Olga Owner's organization" })).toBeVisible();
  await nina.getByRole('button', { name: 'Accept' }).click();
  await expect(nina).toHaveURL(workspaceUrl);
  await expect(nina.getByRole('button', { name: 'Account: Nina Work' })).toContainText('Editor');
  await ninaContext.close();
});

test.describe('with Google alone', () => {
  test.use({ withMicrosoft: false });

  test('offers no Microsoft button', async ({ page, accounts: a }) => {
    await page.goto(`${a.url}/app/`);
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByText('New here? Continue with Google to create')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Microsoft' })).toHaveCount(0);
  });
});
