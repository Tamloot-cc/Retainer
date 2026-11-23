import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ configureFixture: true });

test('approves access, prepares suggestions, resumes and turns on the reviewed bindings', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: 'Set up browser-configure', exact: true }).click();
  await page.getByRole('button', { name: 'Approve access', exact: true }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  const installed = (await r.request('/extensions', undefined, r.keys.user)).installations[0];
  expect(installed.state).toBe('configuring');
  expect(installed.grantedScopes).toEqual(['read']);
  await page.getByRole('button', { name: 'Continue later' }).click();
  await expect(page.getByText('Waiting for your review', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /^browser-configure\b/ }).click();
  await page.getByRole('link', { name: 'Continue setup' }).click();
  await r.finishConfigure();
  await page.getByRole('button', { name: /^Fields/ }).click();
  await expect(page.getByText('A dedicated count field.')).toBeVisible();
  await page.getByRole('button', { name: 'Review installation' }).click();
  await page.getByRole('button', { name: 'Review and turn on', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/${installed.id}$`));
  expect((await r.request(`/extensions/${installed.id}`, undefined, r.keys.user)).state).toBe(
    'installing',
  );
  await r.finishConfigure(true);
  await page.reload();
  await page.getByRole('button', { name: 'Destinations', exact: true }).click();
  await page.getByRole('button', { name: 'Get suggestions', exact: true }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  await r.finishConfigure();
  await page.getByRole('button', { name: /^Fields/ }).click();
  await expect(page.getByText('A dedicated count field.')).toBeVisible();
});

test('skips suggestions and cancels an unfinished installation', async ({ page, retainer: r }) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: 'Set up browser-configure', exact: true }).click();
  await page.getByRole('button', { name: 'Approve access', exact: true }).click();
  await page.getByRole('button', { name: 'Skip suggestions' }).click();
  await expect(page.getByRole('list', { name: /saves data$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const installed = (await r.request('/extensions', undefined, r.keys.user)).installations[0];
  await r.request(`/extensions/${installed.id}`, undefined, r.keys.user, 'DELETE');
  expect((await r.request(`/extensions/${installed.id}`, undefined, r.keys.user)).state).toBe(
    'uninstalled',
  );
});

test('keeps the old release active while suggesting upgrade bindings', async ({
  page,
  retainer: r,
}) => {
  const id = await r.previousConfiguration();
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/extensions/${id}/upgrade`);
  await page.getByRole('button', { name: 'Approve access', exact: true }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  expect((await r.request(`/extensions/${id}`, undefined, r.keys.user)).version).toBe('1.0.0');
  await page.getByRole('button', { name: 'Continue later' }).click();
  await page.getByRole('link', { name: 'Upgrade to 2.0.0' }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve access', exact: true })).toHaveCount(0);
  await r.finishConfigure();
  await page.getByRole('button', { name: /^Fields/ }).click();
  await expect(page.getByText('The existing company address.')).toBeVisible();
  await page.getByRole('button', { name: 'Review upgrade' }).click();
  await page.getByRole('button', { name: 'Approve upgrade', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/${id}$`));
  expect((await r.request(`/extensions/${id}`, undefined, r.keys.user)).version).toBe('2.0.0');
});
