import { expect, test } from './accounts-fixtures.js';

// Settings → Memory and "This agent works for me" (personal memory spec 4.3,
// 4.8): an agent key that works for its creator writes both memories, and
// the person reviews, removes and clears them in the browser.

test('a person gives an agent their memory, then reviews, removes and clears it', async ({
  page,
  context,
  accounts: a,
}) => {
  await a.signIn(context, { email: 'noa@example.test', name: 'Noa' });
  await page.goto(`${a.url}/app/`);
  await page.getByLabel('Name your workspace').fill('Memory');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/app\/w\/memory-/);
  const settings = `${page.url()}settings`;

  await page.goto(`${settings}?tab=agents`);
  await page.getByRole('button', { name: 'Create key' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('My assistant');
  await page.getByRole('checkbox', { name: 'This agent works for me' }).check();
  await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
  const key = (await page.locator('code').filter({ hasText: 'rtn_' }).textContent())?.trim() ?? '';
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Works for Noa')).toBeVisible();

  const remember = (profile: string, text: string) =>
    fetch(`${a.url}/v1/records/${profile}/facts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  expect((await remember('me', 'Noa prefers short emails')).status).toBe(201);
  expect((await remember('workspace', 'Deals over $50k need the CFO')).status).toBe(201);

  await page.goto(`${settings}?tab=memory`);
  const about = (name: string) => page.getByRole('list', { name });
  await expect(about('About this workspace')).toContainText('Deals over $50k need the CFO');
  await expect(about('About you')).toContainText('Noa prefers short emails');
  await expect(page.getByText('Only you and the agents that work for you see it')).toBeVisible();

  // Row actions show on hover, over the time.
  await about('About this workspace').getByRole('listitem').hover();
  await about('About this workspace').getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Agents add what they learn about this team here.')).toBeVisible();

  await page.getByRole('button', { name: 'Clear all' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear all' }).click();
  await expect(page.getByText('Your memory in this workspace is cleared.')).toBeVisible();
  await expect(page.getByText('Agents that work for you add what they learn')).toBeVisible();
  const left = await fetch(`${a.url}/v1/records/me/facts`, {
    headers: { authorization: `Bearer ${key}` },
  });
  expect(await left.json()).toMatchObject({ profile: 'me', facts: [] });
});
