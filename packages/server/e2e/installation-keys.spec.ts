import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ standaloneFixture: true });
test('approves standalone access, displays a key once, revokes it and fences old keys across disable/enable', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: 'Set up browser-app', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve installation' })).toBeVisible();
  await expect(page.getByText(/Runtime activation is unavailable/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve installation' }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'App credentials', exact: true }).click();
  const tab = page.getByRole('main');
  await tab.getByLabel('Write workspace data').uncheck();
  await tab.getByRole('button', { name: 'Create installation key' }).click();
  await expect(tab.getByLabel('Installation key', { exact: true })).toBeVisible();
  const key = await tab.getByLabel('Installation key', { exact: true }).inputValue();
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
  await tab.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(tab.getByLabel('Installation key', { exact: true })).toHaveCount(0);
  await tab.getByRole('button', { name: `Revoke ${key.slice(0, 12)}`, exact: true }).click();
  await expect(
    tab.getByRole('button', { name: `Revoke ${key.slice(0, 12)}`, exact: true }),
  ).toHaveCount(0);
  expect(
    (await fetch(`${r.url}/v1/me`, { headers: { authorization: `Bearer ${key}` } })).status,
  ).toBe(401);
  await tab.getByRole('button', { name: 'Create installation key' }).click();
  await expect(tab.getByLabel('Installation key', { exact: true })).toBeVisible();
  const next = await tab.getByLabel('Installation key', { exact: true }).inputValue();
  await tab.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Extension actions' }).click();
  await page.getByRole('menuitem', { name: 'Disable' }).click();
  await expect(page.getByText('Disabled', { exact: true })).toBeVisible();
  expect(
    (await fetch(`${r.url}/v1/me`, { headers: { authorization: `Bearer ${next}` } })).status,
  ).toBe(401);
  await page.getByRole('button', { name: 'Extension actions' }).click();
  await page.getByRole('menuitem', { name: 'Enable' }).click();
  await expect(page.getByText('Active', { exact: true })).toBeVisible();
  expect(
    (await fetch(`${r.url}/v1/me`, { headers: { authorization: `Bearer ${next}` } })).status,
  ).toBe(401);
  await tab.getByRole('button', { name: 'Create installation key' }).click();
  await expect(tab.getByLabel('Installation key', { exact: true })).toBeVisible();
  const fresh = await tab.getByLabel('Installation key', { exact: true }).inputValue();
  expect((await r.request('/me', undefined, fresh)).scopes).toEqual(['read', 'write']);
});
