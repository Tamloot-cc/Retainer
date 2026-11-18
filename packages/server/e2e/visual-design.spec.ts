import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ extensionFixture: true });

const screenshots = resolve(import.meta.dirname, '../../../test-results/visual-refresh');
async function capture(page: Page, name: string) {
  await mkdir(screenshots, { recursive: true });
  await page.evaluate('document.fonts.ready');
  await page.waitForFunction(
    'document.documentElement.classList.contains("dark") === matchMedia("(prefers-color-scheme: dark)").matches',
  );
  await page.evaluate(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
  );
  await page.screenshot({ path: resolve(screenshots, `${name}.png`) });
}
async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
}

for (const mode of [
  { name: 'light', colorScheme: 'light', width: 1440, height: 1000 },
  { name: 'dark', colorScheme: 'dark', width: 1440, height: 1000 },
  { name: 'mobile', colorScheme: 'light', width: 320, height: 568 },
] as const) {
  test(`record identity and wide sheet remain usable in ${mode.name}`, async ({
    page,
    retainer: r,
  }) => {
    await page.emulateMedia({ colorScheme: mode.colorScheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: mode.width, height: mode.height });
    const record = (
      await r.request(
        '/objects/person/records',
        { values: { name: 'Alex Morgan', jobTitle: 'Chief Technology Officer' } },
        r.keys.user,
      )
    ).record;
    await r.request(
      '/objects/person/records',
      { values: { name: 'Jordan Lee', jobTitle: 'Operations' } },
      r.keys.user,
    );
    await signIn(page, r.url, r.keys.user);
    await page.goto(`${r.url}/app/o/person`);
    const row = page
      .getByRole('region', { name: 'People' })
      .getByRole('link', { name: 'Alex Morgan', exact: true });
    await expect(row).toBeVisible();
    const avatar = row.locator('[data-initials="AM"]').locator('..');
    const color = await avatar.getAttribute('data-color');
    expect(color).toBeTruthy();
    await page.getByRole('checkbox', { name: 'Select Alex Morgan' }).check();
    await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    if (mode.name !== 'mobile') {
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await capture(page, `${mode.name}-collapsed`);
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
    }
    await row.click();
    const sheet = page.getByRole('dialog', { name: 'Alex Morgan' });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('[data-initials="AM"]').locator('..')).toHaveAttribute(
      'data-color',
      color as string,
    );
    expect(Math.round((await sheet.boundingBox())?.width ?? 0)).toBe(
      mode.name === 'mobile' ? mode.width : 608,
    );
    if (mode.name === 'mobile') {
      const label = await sheet.getByText('Job title', { exact: true }).boundingBox();
      const value = await sheet
        .getByText('Chief Technology Officer', { exact: true })
        .boundingBox();
      expect(label && value && label.y + label.height <= value.y).toBe(true);
    }
    await noHorizontalOverflow(page);
    await capture(page, `${mode.name}-record-sheet`);
    await sheet.getByRole('button', { name: 'Edit Job title', exact: true }).click();
    await sheet.getByRole('textbox', { name: 'Job title', exact: true }).fill('Co-founder');
    await sheet.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(sheet.getByText('Co-founder', { exact: true })).toBeVisible();
    await sheet.getByRole('link', { name: 'Open full page' }).click();
    await expect(page.getByRole('heading', { name: 'Alex Morgan', exact: true })).toBeVisible();
    await expect(page.locator('main [data-initials="AM"]').locator('..')).toHaveAttribute(
      'data-color',
      color as string,
    );
    await noHorizontalOverflow(page);
    await capture(page, `${mode.name}-record-page`);
    expect((await r.request(`/records/${record.id}`)).fields.jobTitle).toBe('Co-founder');
  });
}

test('category identity follows records through tables, boards, calendars and Schema', async ({
  page,
  retainer: r,
}) => {
  await r.request('/templates/sales/apply', {});
  await r.request(
    '/objects/deal/records',
    { values: { name: 'Acme renewal', stage: 'qualified', closeDate: '2026-03-11' } },
    r.keys.user,
  );
  const board = await r.request(
    '/objects/deal/views',
    { name: 'Pipeline', kind: 'board', groupBy: 'stage' },
    r.keys.user,
  );
  const calendar = await r.request(
    '/objects/deal/views',
    { name: 'Closing', kind: 'calendar', dateField: 'closeDate' },
    r.keys.user,
  );
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/deal`);
  const tag = page.getByRole('region', { name: 'Deals' }).getByText('Qualified', { exact: true });
  await expect(tag).toBeVisible();
  const color = await tag.getAttribute('data-color');
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.goto(`${r.url}/app/o/deal?view=${board.id}`);
  const column = page.getByRole('region', { name: 'Qualified, 1' });
  await expect(column).toBeVisible();
  await expect(column.locator('header [data-color]').first()).toHaveAttribute(
    'data-color',
    color as string,
  );
  await capture(page, 'board-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await capture(page, 'board-dark');
  await page.goto(`${r.url}/app/o/deal?view=${calendar.id}&month=2026-03`);
  const entry = page.getByRole('button', { name: 'Acme renewal, Stage: Qualified', exact: true });
  await expect(entry).toBeVisible();
  await expect(entry.getByRole('img', { name: 'Stage: Qualified' })).toHaveAttribute(
    'data-color',
    color as string,
  );
  await capture(page, 'calendar-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await capture(page, 'calendar-light');
  await page.goto(`${r.url}/app/schema?object=deal`);
  await expect(page.getByRole('heading', { name: 'Deals', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('button', { name: /^Deals/ })
      .locator('svg')
      .first(),
  ).toHaveAttribute('data-color', 'coral');
  await capture(page, 'schema-light');
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page);
  await capture(page, 'schema-mobile');
});

test('actor attribution keeps its identity from review into record history', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Alex Morgan', jobTitle: 'Founder' } },
      r.keys.user,
    )
  ).record;
  await r.request(`/records/${record.id}`, { values: { jobTitle: 'CEO' } }, r.keys.agent, 'PATCH');
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  const actor = page.locator('.category-tag').filter({ hasText: 'inbox' }).first();
  await expect(actor).toBeVisible();
  const color = await actor.getAttribute('data-color');
  await capture(page, 'review-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await capture(page, 'review-dark');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.goto(`${r.url}/app/r/${record.id}?tab=history`);
  const historyActor = page.locator('.category-tag').filter({ hasText: 'inbox' }).first();
  await expect(historyActor).toBeVisible();
  await expect(historyActor).toHaveAttribute('data-color', color as string);
  await capture(page, 'history-dark');
});

test.describe('extension identity', () => {
  test('uses a tinted identity tile in the real catalog on desktop and mobile', async ({
    page,
    retainer: r,
  }) => {
    await signIn(page, r.url, r.keys.user);
    await page.goto(`${r.url}/app/extensions`);
    await expect(page.getByRole('heading', { name: 'Extensions', exact: true })).toBeVisible();
    await expect(page.locator('.category-tag[data-color]').first()).toBeVisible();
    await capture(page, 'extensions-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await capture(page, 'extensions-dark');
    await page.setViewportSize({ width: 390, height: 844 });
    await noHorizontalOverflow(page);
    await capture(page, 'extensions-mobile');
  });
});

test('long record names, empty lists and retryable failures fit a narrow screen', async ({
  page,
  retainer: r,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = `Alex ${'Morgan'.repeat(30)}`;
  const record = (await r.request('/objects/person/records', { values: { name } }, r.keys.user))
    .record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${record.id}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await capture(page, 'mobile-long-record');
  await page.goto(
    `${r.url}/app/o/person?filter=${encodeURIComponent(JSON.stringify(JSON.stringify({ jobTitle: { eq: 'Nobody' } })))}`,
  );
  await expect(page.getByRole('heading', { name: 'No records found' })).toBeVisible();
  await noHorizontalOverflow(page);
  await expect(page.getByText('Nobody', { exact: true })).toBeVisible();
  await capture(page, 'mobile-empty-list');
  await page.route('**/v1/records/00000000-0000-4000-8000-000000000000**', (route) =>
    route.abort(),
  );
  await page.goto(`${r.url}/app/r/00000000-0000-4000-8000-000000000000`);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await capture(page, 'mobile-record-error');
});
