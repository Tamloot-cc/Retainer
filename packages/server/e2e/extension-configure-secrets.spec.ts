import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ configureSecretFixture: true });

test('restores target credentials on resume and allows restaging after expiry', async ({
  page,
  retainer: r,
}) => {
  const id = await r.previousConfiguration();
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/extensions/${id}/upgrade`);
  const key = page.getByLabel('Provider key (required)');
  await expect(key).toBeEnabled();
  await key.fill('target-key');
  await page.getByRole('button', { name: 'Review upgrade' }).click();
  await page.getByRole('button', { name: 'Approve access', exact: true }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  await page.getByRole('button', { name: 'Continue later' }).click();
  await r.finishConfigure();
  await page.getByRole('link', { name: 'Upgrade to 2.0.0' }).click();
  await expect(key).toHaveAttribute('placeholder', 'Provided for approval');
  await expect(key).toBeEnabled();
  expect(
    (await r.request(`/extensions/${id}`, undefined, r.keys.user)).secrets.providerKey,
  ).toBeUndefined();
  await r.expireConfigurationSecrets();
  await page.reload();
  // Expired approval material needs a fresh access review; no phantom Connected key.
  await expect(key).toBeEnabled();
  await key.fill('replacement-key');
  await page.getByRole('button', { name: 'Review upgrade' }).click();
  await page.getByRole('button', { name: 'Approve access', exact: true }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  await r.finishConfigure();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Review upgrade' }).click();
  await page.getByRole('button', { name: 'Approve upgrade', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/${id}$`));
  const upgraded = await r.request(`/extensions/${id}`, undefined, r.keys.user);
  expect(upgraded.version).toBe('2.0.0');
  expect(upgraded.secrets.providerKey).toBe(true);
});
