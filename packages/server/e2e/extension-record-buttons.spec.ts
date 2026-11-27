import { ENRICHMENT } from '@retainer/runner/enrichment-contract';
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

for (const [label, code, message] of [
  ['Enrich now', 'no_domain', 'Enrichment skipped. Add a company domain and try again.'],
  ['Enrich now', 'no_match', 'Enrichment skipped. No confident match was found.'],
  ['Enrich now', 'no_match_model_unavailable', 'Enrichment skipped. No confident match was found.'],
  ['Check company', 'no_match', '“Check company” finished.'],
] as const) {
  test(`shows the ${code} outcome for ${label}`, async ({ page, retainer: r }) => {
    const installation = await r.installRecordButton();
    const { record: company } = await r.request('/objects/company/records', {
      values: { name: 'Acme Systems' },
    });

    await signIn(page, r.url, r.keys.writer);
    await page.getByRole('link', { name: 'Companies', exact: true }).click();
    await page.getByRole('link', { name: 'Acme Systems', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Acme Systems' });
    await sheet.getByRole('button', { name: label }).click();
    await expect(sheet.getByText(`Started “${label}” on this record.`)).toBeVisible();
    await r.finishRecordButton(installation, company.id, code);
    await expect(sheet.getByRole('status')).toHaveText(message);
  });
}

test('filters run history and opens run details on a narrow screen', async ({
  page,
  retainer: r,
}) => {
  const installation = await r.installRecordButton();
  const { record: company } = await r.request('/objects/company/records', {
    values: { name: 'Acme Systems' },
  });
  await r.request(
    `/extensions/${installation}/record-buttons/${ENRICHMENT.enrichCompanyNow}`,
    { recordId: company.id },
    r.keys.writer,
  );

  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/extensions/${installation}?tab=runs`);
  const history = page.getByRole('region', { name: 'Run history' });
  await expect(history.getByText('Queued', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'In progress' }).click();
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history.getByText('Queued', { exact: true })).toBeVisible();
  await r.finishRecordButton(installation, company.id, 'matched_shortcut', {
    employee_count: 42,
    headquarters: { city: 'Springfield' },
  });
  await expect(history.getByText('No runs in progress')).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  const filters = history.getByRole('group', { name: 'Filter by run status' });
  await filters.getByRole('button', { name: 'Succeeded' }).click();
  const row = history.getByRole('listitem').filter({ hasText: 'Enrich company' });
  await expect(row.getByText(/Found a direct match/)).toBeVisible();
  await expect(row.getByRole('button', { name: 'Copy run ID' })).toBeHidden();
  await row.locator(':scope > details > summary').press('Enter');
  await expect(row.getByRole('button', { name: 'Copy run ID' })).toBeHidden();
  const input = row.locator('summary').filter({ hasText: /^Input/ });
  const output = row.locator('summary').filter({ hasText: /^Output/ });
  await expect(input).toContainText('Acme Systems');
  await expect(output).toContainText('2 filled');
  await expect(row.getByRole('link', { name: 'Acme Systems' })).toBeHidden();
  await input.press('Enter');
  await expect(row.getByRole('link', { name: 'Acme Systems' })).toHaveAttribute(
    'href',
    `/app/r/${company.id}`,
  );
  await expect(row.getByText('Employee count, Headquarters', { exact: true })).toBeHidden();
  await output.press('Space');
  await expect(row.getByText('Employee count, Headquarters', { exact: true })).toBeVisible();
  await input.press('Enter');
  await expect(row.getByRole('link', { name: 'Acme Systems' })).toBeHidden();
  await expect(row.getByText('Employee count, Headquarters', { exact: true })).toBeVisible();
  await row
    .locator('summary')
    .filter({ hasText: /^Technical details/ })
    .press('Enter');
  await expect(row.getByRole('button', { name: 'Copy run ID' })).toBeVisible();
  await expect
    .poll(() => history.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true);
});
