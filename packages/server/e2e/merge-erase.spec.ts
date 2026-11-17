import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('merges a suggested duplicate, choosing the value to keep', async ({ page, retainer: r }) => {
  const older = (
    await r.request('/objects/person/records', {
      values: { name: 'Yael Mizrahi', jobTitle: 'CTO', emails: 'yael@acme.test' },
    })
  ).record;
  const newer = (
    await r.request('/objects/person/records', {
      values: { name: 'Yael Mizrachi', jobTitle: 'VP Engineering', emails: 'yael@gmail.test' },
    })
  ).record;
  await r.consolidate();
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await page.getByRole('button', { name: /Possible duplicates/ }).click();
  await expect(page.getByText('similar names')).toBeVisible();
  await page
    .getByRole('button', { name: /^Compare and merge Yael Mizra.*hi and Yael Mizra.*hi$/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Merge duplicate records' });
  // The older record survives by default; emails are combined unless chosen.
  await expect(dialog.getByRole('radio')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Value for Emails' })).toHaveText('Combine both');
  await dialog.getByRole('button', { name: 'Value for Job title' }).click();
  await page.getByRole('option', { name: 'Newer record’s' }).click();
  await expect(dialog.getByRole('button', { name: 'Value for Job title' })).toHaveText(
    'Newer record’s',
  );
  await dialog.getByRole('button', { name: 'Merge records' }).click();
  await expect(page.getByText('Merged Yael Mizrachi into')).toBeVisible();
  await expect(page.getByText('No possible duplicates')).toBeVisible();
  expect(await r.request(`/records/${newer.id}`)).toMatchObject({
    id: older.id,
    fields: {
      jobTitle: 'VP Engineering',
      emails: { primary: 'yael@acme.test', additional: ['yael@gmail.test'] },
    },
  });
});

test('dismisses a suggestion, and merges a duplicate found from the record', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Yael Mizrahi' } });
  await r.request('/objects/person/records', { values: { name: 'Yael Mizrachi' } });
  const keep = (await r.request('/objects/person/records', { values: { name: 'Avi Cohen' } }))
    .record;
  const away = (
    await r.request('/objects/person/records', { values: { name: 'Avi Cohen', jobTitle: 'CFO' } })
  ).record;
  await r.consolidate();
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/?tab=mergeSuggestions`);
  await page
    .getByRole('button', { name: /^Compare and merge Yael Mizra.*hi and Yael Mizra.*hi$/ })
    .click();
  await page.getByRole('button', { name: 'Not duplicates' }).click();
  await expect(page.getByText('Suggestion dismissed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Yael Mizrachi' })).not.toBeVisible();

  await page.goto(`${r.url}/app/r/${away.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('menuitem', { name: 'Merge a duplicate…' }).click();
  const picker = page.getByRole('dialog', { name: 'Merge a duplicate with Avi Cohen' });
  // Start from the newer record: the older one must still survive.
  // The search starts from the record's own name, and the record itself is not offered.
  await expect(picker.getByRole('button', { name: 'Avi Cohen' })).toHaveCount(1);
  await picker.getByRole('button', { name: 'Avi Cohen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge duplicate records' });
  await expect(dialog.getByText('Keeps the only value')).toBeVisible();
  await dialog.getByRole('button', { name: 'Merge records' }).click();
  await expect(page.getByText('Merged Avi Cohen into')).toBeVisible();
  await expect(page.getByText('CFO', { exact: true })).toBeVisible();
  expect((await r.request(`/records/${away.id}`)).id).toBe(keep.id);
});

test('erases a person for a privacy request after typed confirmation', async ({
  page,
  retainer: r,
}) => {
  const person = (
    await r.request('/objects/person/records', {
      values: { name: 'Avi Erased', emails: 'avi@erased.test' },
    })
  ).record;
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Intro call',
    participants: [{ recordId: person.id }],
  });
  await r.request(`/records/${person.id}/facts`, { text: 'Prefers email', source: event.id });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${person.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('menuitem', { name: 'Erase for privacy…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Erase Avi Erased permanently?' });
  const erase = confirm.getByRole('button', { name: 'Erase permanently' });
  await expect(erase).toBeDisabled();
  await confirm.getByLabel('Confirmation').fill('Avi');
  await expect(erase).toBeDisabled();
  await confirm.getByLabel('Confirmation').fill('Avi Erased');
  await erase.click();
  await expect(
    page.getByText(/Erased Avi Erased: 1 record, 1 event, 1 fact and \d+ values\./),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await expect(r.request(`/records/${person.id}`)).rejects.toThrow(/not_found/);
  await expect(
    r.request('/objects/person/records', { values: { name: 'Avi', emails: 'avi@erased.test' } }),
  ).rejects.toThrow(/suppressed/);
});

test('offers erasing only to admin user keys', async ({ page, retainer: r }) => {
  const person = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  await signIn(page, r.url, r.keys.writer);
  await page.goto(`${r.url}/app/r/${person.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Delete…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Erase for privacy…' })).not.toBeVisible();
});

for (const width of [1440, 390]) {
  test(`long duplicate task titles wrap in cards and comparisons at ${width}px`, async ({
    page,
    retainer: r,
  }, testInfo) => {
    const olderTitle =
      "Schedule Orchid's presentation of its AI-security solution and internal AI use to Team8 (Matt to present)";
    const newerTitle =
      "Schedule Orchid's presentation of its AI-security solution and internal AI use to Team8 (Matt and the AI team to present)";
    for (const title of [olderTitle, newerTitle]) {
      await r.request('/objects/task/records', { values: { title, status: 'todo' } });
    }
    await r.consolidate();
    await page.setViewportSize({ width, height: 1000 });
    await signIn(page, r.url, r.keys.user);
    await page.goto(`${r.url}/app/?tab=mergeSuggestions`);
    const card = page.locator('[data-review-card]').filter({ hasText: olderTitle });
    for (const title of [olderTitle, newerTitle]) {
      const link = card.getByRole('link', { name: title, exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveCSS('white-space', 'normal');
      expect(await link.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(
        await link.evaluate(
          (el) =>
            el.getBoundingClientRect().height > Number.parseFloat(getComputedStyle(el).lineHeight),
        ),
      ).toBe(true);
    }
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const cardImage = testInfo.outputPath(`duplicate-card-${width}.png`);
    await card.screenshot({ path: cardImage });
    await testInfo.attach('Suggestion card', { path: cardImage, contentType: 'image/png' });
    await card.getByRole('button', { name: /^Compare and merge/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Merge duplicate records' });
    const titleComparison = dialog.getByRole('region', { name: 'Title', exact: true });
    for (const title of [olderTitle, newerTitle]) {
      await expect(titleComparison.getByText(title, { exact: true })).toBeVisible();
    }
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await titleComparison.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const comparisonImage = testInfo.outputPath(`duplicate-comparison-${width}.png`);
    await dialog.screenshot({ path: comparisonImage });
    await testInfo.attach('Merge comparison', { path: comparisonImage, contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Value for Title' }).click();
    await page.getByRole('option', { name: 'Newer record’s' }).click();
    await dialog.getByRole('button', { name: 'Merge records' }).click();
    await expect(dialog).not.toBeVisible();
  });
}
