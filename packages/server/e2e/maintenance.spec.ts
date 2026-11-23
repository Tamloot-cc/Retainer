import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('keeps a draft mounted while a restricted save retries itself', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'New person', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New person' });
  await form.getByLabel('First name').fill('Quiet');
  await form.getByLabel('Last name').fill('Deploy');
  let attempts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/v1/objects/person/records'))
      attempts++;
  });
  r.restrictReads(true);
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saving is paused' })).toBeVisible();
  await expect(form.getByLabel('First name')).toHaveValue('Quiet');
  await expect(page.getByText('Something went wrong', { exact: true })).not.toBeVisible();
  r.restrictReads(false);
  await expect(page.getByRole('dialog', { name: 'Quiet Deploy' })).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText('Saving is paused', { exact: false })).not.toBeVisible();
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

test('opens an existing session and reads records during a write pause', async ({
  page,
  retainer: r,
}) => {
  const existing = await r.request('/objects/person/records', { values: { name: 'Quiet Reader' } });
  await signIn(page, r.url, r.keys.user);
  r.restrictReads(true);
  await page.reload();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await expect(page.getByText('Quiet Reader', { exact: true })).toBeVisible();
  const detail = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/v1/records/${existing.id}`,
  );
  await page.getByText('Quiet Reader', { exact: true }).click();
  expect((await detail).status()).toBe(200);
  await expect(page.getByRole('dialog', { name: 'Quiet Reader' })).toBeVisible();
});
