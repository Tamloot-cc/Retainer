import { browserExtensionManifest, expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ extensionFixture: true });
test('reviews and approves an installation, changes settings, inspects runs and reinstalls retained schema', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: 'Set up browser-fixture', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up browser-fixture' })).toBeVisible();
  await expect(page.getByLabel('Generated signing secret')).toHaveCount(0);
  await page.getByLabel('Enabled (required)').check();
  await page.getByRole('button', { name: 'Review installation' }).click();
  await expect(page.getByText(/It can read workspace CRM data/)).toBeVisible();
  await expect(page.getByText(/Runtime activation is unavailable/)).toBeVisible();
  expect((await r.request('/extensions', undefined, r.keys.user)).installations).toHaveLength(0);
  await page.getByRole('button', { name: 'Approve installation' }).click();
  await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
  const installed = (await r.request('/extensions', undefined, r.keys.user)).installations[0];
  expect(page.url()).toMatch(new RegExp(`/extensions/${installed.id}$`));
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
  expect(installed.settings.enabled).toBe(true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Generated signing secret')).toHaveCount(0);
  await page.getByLabel('Enabled (required)').uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  expect(
    (await r.request(`/extensions/${installed.id}`, undefined, r.keys.user)).settings.enabled,
  ).toBe(false);
  await page.getByRole('button', { name: 'Runs', exact: true }).click();
  await expect(page.getByText('No runs yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Extension actions' }).click();
  await page.getByRole('menuitem', { name: 'Uninstall' }).click();
  const confirm = page.getByRole('dialog', { name: 'Uninstall browser-fixture?' });
  await confirm.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await expect(page).toHaveURL(/\/extensions$/);
  await page.getByRole('link', { name: 'Set up browser-fixture', exact: true }).click();
  await page.getByRole('button', { name: 'Review installation' }).click();
  await expect(page.getByText('No schema changes.')).toBeVisible();
  await page.getByRole('button', { name: 'Approve installation' }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/${installed.id}$`));
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
test('reviews a reconnect before changing account settings or revoking the current generation', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: 'Set up browser-fixture', exact: true }).click();
  await page.getByLabel('Provider account').fill('original-account');
  await page.getByRole('button', { name: 'Review installation' }).click();
  await page.getByRole('button', { name: 'Approve installation' }).click();
  await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
  const initial = (await r.request('/extensions', undefined, r.keys.user)).installations[0];
  await page.getByRole('button', { name: 'Extension actions' }).click();
  await page.getByRole('menuitem', { name: 'Reconnect' }).click();
  await expect(page.getByRole('heading', { name: 'Reconnect browser-fixture' })).toBeVisible();
  await page.getByLabel('Provider account').fill('reconnected-account');
  await page.getByRole('button', { name: 'Review reconnect' }).click();
  await expect(page.getByText(/Reconnect stops current runs/)).toBeVisible();
  expect((await r.request(`/extensions/${initial.id}`, undefined, r.keys.user)).generation).toBe(
    initial.generation,
  );
  await page.getByRole('button', { name: 'Approve reconnect' }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/${initial.id}$`));
  const reconnected = await r.request(`/extensions/${initial.id}`, undefined, r.keys.user);
  expect(reconnected.settings.account).toBe('reconnected-account');
  expect(reconnected.generation).toBe(initial.generation + 1);
});
test('shows the catalog to a reader without installation controls', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.reader);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await expect(page.getByText('A workspace admin can set up these extensions.')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Set up/ })).toHaveCount(0);
  expect(
    (await r.request('/extensions/catalog', undefined, r.keys.reader)).releases[0].manifest
      .universalId,
  ).toBe(browserExtensionManifest.universalId);
});
