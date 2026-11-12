import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('sign in, accept and reject values, browse records, and inspect provenance', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Dana Levi', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await r.request(`/records/${record.id}`, { values: { jobTitle: 'CEO' } }, r.keys.agent, 'PATCH');
  await signIn(page, r.url, r.keys.user);
  await expect(page.getByText('CEO', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'President' } },
    r.keys.agent,
    'PATCH',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('link', { name: 'Dana Levi' }).click();
  const sheet = page.getByRole('dialog', { name: 'Dana Levi' });
  await expect(sheet.getByRole('heading', { name: 'Dana Levi' })).toBeVisible();
  await expect(sheet.getByText('CEO', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'History of Job title' }).click();
  const history = page.getByRole('dialog', { name: 'History of Job title' });
  await expect(history.getByText('rejected', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(history).not.toBeVisible();
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: '/tmp/retainer-web-record.png', fullPage: true });
  expect(
    await page.evaluate(() => Object.values(localStorage).some((v) => v.includes('rtn_'))),
  ).toBe(false);
});

test('preserves a draft after a stale edit and retries only with explicit action', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Dana Levi', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${record.id}`);
  await page.getByRole('button', { name: 'Edit Job title', exact: true }).click();
  await page.getByRole('textbox', { name: 'Job title', exact: true }).fill('My draft');
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'Changed elsewhere' } },
    r.keys.user,
    'PATCH',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('This record changed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Job title', exact: true })).toHaveValue(
    'My draft',
  );
  await expect(page.getByText('Changed elsewhere', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry with latest version' }).click();
  await expect(page.getByRole('textbox', { name: 'Job title', exact: true })).not.toBeVisible();
  await expect(page.getByText('My draft', { exact: true })).toBeVisible();
  expect((await r.request(`/records/${record.id}`)).fields.jobTitle).toBe('My draft');

  // Clicking away from a stale draft leaves it, rather than retrying unasked.
  await page.getByRole('button', { name: 'Edit Job title', exact: true }).click();
  await page.getByRole('textbox', { name: 'Job title', exact: true }).fill('Second draft');
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'Changed again' } },
    r.keys.user,
    'PATCH',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('This record changed.', { exact: false })).toBeVisible();
  await page.getByRole('heading', { name: 'Dana Levi' }).click();
  await expect(page.getByRole('textbox', { name: 'Job title', exact: true })).not.toBeVisible();
  expect((await r.request(`/records/${record.id}`)).fields.jobTitle).toBe('Changed again');
});

test('bulk review reports individual failures and keeps only failed items selected', async ({
  page,
  retainer: r,
}) => {
  const holder = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Claim holder', emails: 'taken@acme.test' } },
      r.keys.user,
    )
  ).record;
  const blocked = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Blocked person', emails: 'other@acme.test' } },
      r.keys.user,
    )
  ).record;
  const valid = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Valid person', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await r.request(
    `/records/${blocked.id}`,
    { values: { emails: 'taken@acme.test' } },
    r.keys.agent,
    'PATCH',
  );
  await r.request(`/records/${valid.id}`, { values: { jobTitle: 'CEO' } }, r.keys.agent, 'PATCH');
  await signIn(page, r.url, r.keys.user);
  await page.getByLabel('Select Blocked person emails').check();
  await page.getByLabel('Select Valid person jobTitle').check();
  await page.getByRole('button', { name: 'Accept selected' }).click();
  await expect(page.getByRole('link', { name: 'View conflicting record' })).toHaveAttribute(
    'href',
    `/app/r/${holder.id}`,
  );
  await expect(page.getByText('Value accepted', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Select Blocked person emails')).toBeChecked();
  await expect(page.getByLabel('Select Valid person jobTitle')).not.toBeVisible();
});

test('supports keyboard review and system dark mode on a narrow screen', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Keyboard person', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await r.request(`/records/${record.id}`, { values: { jobTitle: 'CEO' } }, r.keys.agent, 'PATCH');
  await signIn(page, r.url, r.keys.user);
  await expect(page.getByLabel('Select Keyboard person jobTitle')).toBeVisible();
  await page.locator('body').click({ position: { x: 1000, y: 30 } });
  await page.keyboard.press('x');
  await expect(page.getByLabel('Select Keyboard person jobTitle')).toBeChecked();
  await page.keyboard.press('a');
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveClass('dark');
  await page.screenshot({ path: '/tmp/retainer-web-dark-mobile.png', fullPage: true });
});
