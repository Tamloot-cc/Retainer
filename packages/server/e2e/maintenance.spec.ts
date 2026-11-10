import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('keeps a draft mounted while a maintenance-rejected save retries itself', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'New person', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New person' });
  await form.getByLabel('First name').fill('Quiet');
  await form.getByLabel('Last name').fill('Deploy');
  let stopped = true;
  let attempts = 0;
  await page.route('**/v1/objects/person/records', async (route) => {
    attempts++;
    if (!stopped) return route.continue();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'retry-after': '1', 'x-retainer-maintenance': 'not-executed' },
      body: JSON.stringify({ error: { code: 'maintenance', message: 'Updating' } }),
    });
  });
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Updating, back in a moment' }),
  ).toBeVisible();
  await expect(form.getByLabel('First name')).toHaveValue('Quiet');
  await expect(page.getByText('Something went wrong', { exact: true })).not.toBeVisible();
  stopped = false;
  await expect(page.getByRole('dialog', { name: 'Quiet Deploy' })).toBeVisible();
  await expect(page.getByText('Updating, back in a moment.', { exact: false })).not.toBeVisible();
  expect(attempts).toBeGreaterThan(1);
});

test('waits through maintenance during account-mode detection', async ({ page, retainer: r }) => {
  let first = true;
  await page.route('**/account', async (route) => {
    if (!first) return route.continue();
    first = false;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'retry-after': '1' },
      body: JSON.stringify({ error: { code: 'maintenance' } }),
    });
  });
  await page.goto(`${r.url}/app`);
  await expect(
    page.getByRole('status').filter({ hasText: 'Updating, back in a moment' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});
