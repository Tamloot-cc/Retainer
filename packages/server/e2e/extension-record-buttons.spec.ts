import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ recordButtonFixture: true });

test('shows an extension button in the record sheet and full page and runs it on the current record', async ({
  page,
  retainer: r,
}) => {
  const installation = await r.installRecordButton();
  const { record: company } = await r.request('/objects/company/records', {
    values: { name: 'Acme Systems', domain: 'acme.example' },
  });

  await signIn(page, r.url, r.keys.writer);
  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  await page.getByRole('link', { name: 'Acme Systems', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Acme Systems' });
  const button = sheet.getByRole('button', { name: 'Enrich now' });
  await expect(button).toBeEnabled();
  await button.focus();
  await button.press('Space');
  await expect(button).toBeDisabled();
  await expect(button).toBeFocused();
  await expect(sheet.getByText('Started “Enrich now” on this record.')).toBeVisible();
  await r.finishRecordButton(installation, company.id);
  await expect(
    sheet.getByRole('status').filter({ hasText: '“Enrich now” finished.' }),
  ).toBeVisible();
  await expect(button).toBeEnabled();

  await sheet.getByRole('link', { name: 'Open full page' }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${company.id}$`));
  await expect(page.getByRole('button', { name: 'Enrich now' })).toBeEnabled();
});
