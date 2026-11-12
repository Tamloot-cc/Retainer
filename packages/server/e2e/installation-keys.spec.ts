import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ standaloneFixture: true });
test('approves standalone access, displays a key once, revokes it and fences old keys across disable/enable', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Set up', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'browser-app setup' });
  await setup.getByRole('button', { name: 'Review installation' }).click();
  await expect(setup.getByText(/Runtime activation is unavailable/)).toHaveCount(0);
  await setup.getByRole('button', { name: 'Approve installation' }).click();
  await expect(setup).not.toBeVisible();
  await expect(page.getByText('Active · Version 1.0.0')).toBeVisible();
  await page.getByRole('button', { name: 'App credentials', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'App credentials' });
  await dialog.getByLabel('Write workspace data').uncheck();
  await dialog.getByRole('button', { name: 'Create installation key' }).click();
  await expect(dialog.getByLabel('Installation key', { exact: true })).toBeVisible();
  const key = await dialog.getByLabel('Installation key', { exact: true }).inputValue();
  expect(key).toMatch(/^rti_/);
  const me = await r.request('/me', undefined, key);
  expect(me.person).toBe(false);
  expect(me.actor.type).toBe('integration');
  expect(me.scopes).toEqual(['read']);
  const denied = await fetch(`${r.url}/v1/objects/company/records`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ values: { name: 'Denied write' } }),
  });
  expect(denied.status).toBe(403);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'App credentials', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'App credentials' });
  await expect(dialog.getByLabel('Installation key', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: `Revoke ${key.slice(0, 12)}`, exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: `Revoke ${key.slice(0, 12)}`, exact: true }),
  ).toHaveCount(0);
  expect(
    (await fetch(`${r.url}/v1/me`, { headers: { authorization: `Bearer ${key}` } })).status,
  ).toBe(401);
  await dialog.getByRole('button', { name: 'Create installation key' }).click();
  await expect(dialog.getByLabel('Installation key', { exact: true })).toBeVisible();
  const next = await dialog.getByLabel('Installation key', { exact: true }).inputValue();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await expect(page.getByText('Disabled · Version 1.0.0')).toBeVisible();
  expect(
    (await fetch(`${r.url}/v1/me`, { headers: { authorization: `Bearer ${next}` } })).status,
  ).toBe(401);
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await expect(page.getByText('Active · Version 1.0.0')).toBeVisible();
  expect(
    (await fetch(`${r.url}/v1/me`, { headers: { authorization: `Bearer ${next}` } })).status,
  ).toBe(401);
  await page.getByRole('button', { name: 'App credentials', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'App credentials' });
  await dialog.getByRole('button', { name: 'Create installation key' }).click();
  await expect(dialog.getByLabel('Installation key', { exact: true })).toBeVisible();
  const fresh = await dialog.getByLabel('Installation key', { exact: true }).inputValue();
  expect((await r.request('/me', undefined, fresh)).scopes).toEqual(['read', 'write']);
});
