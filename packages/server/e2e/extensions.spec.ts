import { browserExtensionManifest, expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ extensionFixture: true });
test('reviews and approves an installation, changes settings, inspects runs and reinstalls retained schema', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'browser-fixture setup' });
  await dialog.getByLabel('Enabled (required)').check();
  await dialog.getByRole('button', { name: 'Review installation' }).click();
  await expect(dialog.getByText(/This service can read workspace CRM data/)).toBeVisible();
  await expect(dialog.getByText(/Runtime activation is unavailable/)).toBeVisible();
  expect((await r.request('/extensions', undefined, r.keys.user)).installations).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Approve installation' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Disabled · Version 1.0.0')).toBeVisible();
  const installed = (await r.request('/extensions', undefined, r.keys.user)).installations[0];
  expect(installed.settings.enabled).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'browser-fixture settings' });
  await dialog.getByLabel('Enabled (required)').uncheck();
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog).not.toBeVisible();
  expect(
    (await r.request(`/extensions/${installed.id}`, undefined, r.keys.user)).settings.enabled,
  ).toBe(false);
  await page.getByRole('button', { name: 'View runs' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Extension runs' }).getByText('No runs yet.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(page.getByText('Uninstalled · Version 1.0.0')).toBeVisible();
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'browser-fixture setup' });
  await dialog.getByRole('button', { name: 'Review installation' }).click();
  await expect(dialog.getByText('No schema changes.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve installation' }).click();
  await expect(dialog).not.toBeVisible();
  const schema = await r.request('/schema');
  expect(
    schema.objects
      .find((o: any) => o.nameSingular === 'company')
      .fields.filter((f: any) => f.name === 'fixtureStatus'),
  ).toHaveLength(1);
  expect((await r.request('/extensions', undefined, r.keys.user)).installations[0].id).toBe(
    installed.id,
  );
});
test('shows the catalog to a reader without installation controls', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.reader);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await expect(page.getByText('A workspace admin can connect this service.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up', exact: true })).toHaveCount(0);
  expect(
    (await r.request('/extensions/catalog', undefined, r.keys.reader)).releases[0].manifest
      .universalId,
  ).toBe(browserExtensionManifest.universalId);
});
