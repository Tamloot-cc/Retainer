import { browserMemberManifest, expect, test } from './fixtures.js';
import { signIn, signOut } from './helpers.js';

test.use({ memberFixture: true });
test('a member connects and disconnects; an admin sees and disconnects every owner', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: 'Set up member-browser', exact: true }).click();
  await expect(page.getByLabel('Member API key (required)')).toHaveCount(0);
  await page.getByLabel('Share member data (required)').check();
  await page.getByRole('button', { name: 'Review installation' }).click();
  await page.getByRole('button', { name: 'Approve installation' }).click();
  await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
  await r.activateMembers();
  const installed = (await r.request('/extensions', undefined, r.keys.user)).installations.find(
    (i: { registrationId: string }) => i.registrationId === browserMemberManifest.universalId,
  );
  expect(installed.state).toBe('active');
  await signOut(page);
  await signIn(page, r.url, r.keys.writer);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: /^member-browser/ }).click();
  const own = page.getByRole('region', { name: 'Your Member-browser connection' });
  await own.getByRole('button', { name: 'Connect account', exact: true }).click();
  const dialog = page.getByRole('form', { name: 'Connect your Member-browser account' });
  await expect(dialog.getByLabel('Share member data (required)')).toHaveCount(0);
  await expect(dialog.getByLabel('History days (required)')).toHaveValue('31');
  await dialog.getByLabel('Member API key (required)').fill('fixture-member-key');
  await dialog.getByRole('button', { name: 'Connect account', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(own.getByText('Connecting · Ok')).toBeVisible();
  await r.activateMembers();
  await expect(own.getByText('Active · Ok')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Member connections' })).toHaveCount(0);
  await own.getByRole('button', { name: 'View your runs' }).click();
  await expect(
    page.getByRole('list', { name: 'Extension runs' }).getByText(/Succeeded/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await own.getByRole('button', { name: 'Disconnect account' }).click();
  await expect(own.getByRole('button', { name: 'Connect account', exact: true })).toBeVisible();
  const base = `/extensions/${installed.id}`;
  const secret = await r.request(
    `${base}/connections/secrets`,
    { name: 'apiKey', value: 'fixture-reader-key' },
    r.keys.reader,
  );
  await r.request(
    `${base}/connections`,
    { settings: { days: 31 }, secretRefs: { apiKey: secret.pendingSecretId } },
    r.keys.reader,
  );
  await r.activateMembers();
  await signOut(page);
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: /^member-browser/ }).click();
  const members = page.getByRole('region', { name: 'Member connections' });
  await expect(members.getByRole('cell', { name: 'writer', exact: true })).toBeVisible();
  await expect(members.getByRole('cell', { name: 'reader', exact: true })).toBeVisible();
  await members.getByRole('button', { name: 'Disconnect reader', exact: true }).click();
  const row = members
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: 'reader', exact: true }) });
  await expect(row.getByRole('cell', { name: 'Disconnected', exact: true })).toBeVisible();
  expect(
    (await r.request(`${base}/connections`, undefined, r.keys.user)).connections.every(
      (c: { state: string }) => c.state === 'disconnected',
    ),
  ).toBe(true);
});
