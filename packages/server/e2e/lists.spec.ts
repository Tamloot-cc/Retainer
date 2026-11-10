import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn, signOut } from './helpers.js';

const usd = (dollars: number) => ({ currency: 'USD', amountMicros: dollars * 1_000_000 });

/** What a drag announces to screen readers. */
const announced = (page: Page, text: string) => page.getByRole('status').filter({ hasText: text });

/** Space picks an item up, an arrow carries it to the next target that way, Space drops it. */
async function moveByKeyboard(
  page: Page,
  item: Locator,
  arrow: 'ArrowLeft' | 'ArrowRight',
  from: string,
  to: string,
) {
  const name = await item.getAttribute('aria-label');
  await item.focus();
  await page.keyboard.press('Space');
  await expect(announced(page, `${name} is over ${from}.`)).toHaveCount(1);
  // The drag listens for keys from the task after the pick-up; a person
  // can't press that fast, but a test can.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
  await page.keyboard.press(arrow);
  await expect(announced(page, `${name} is over ${to}.`)).toHaveCount(1);
  await page.keyboard.press('Space');
}

test('searches the workspace with the command palette and keeps list filters in the URL', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } });
  await r.request('/objects/person/records', { values: { name: 'Other person', jobTitle: 'CEO' } });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('combobox', { name: 'Filter by' }).fill('job');
  await page.getByRole('option', { name: 'Job title' }).click();
  await page.getByLabel('Job title', { exact: true }).fill('CTO');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByRole('link', { name: 'Dana Levi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Other person' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove filter Job title' })).toBeVisible();
  expect(page.url()).toContain('filter=');
  await page.reload();
  await expect(page.getByRole('link', { name: 'Dana Levi' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByLabel('Search the workspace').fill('Other');
  await page.getByRole('dialog').getByRole('button', { name: 'Other person', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Other person' })).toBeVisible();
});

test('sorts from column headers, resizes columns, and collapses the sidebar', async ({
  page,
  retainer: r,
}) => {
  for (const [name, jobTitle] of [
    ['Bravo person', 'B title'],
    ['Alpha person', 'C title'],
    ['Charlie person', 'A title'],
  ])
    await r.request('/objects/person/records', { values: { name, jobTitle } });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const grid = page.getByRole('region', { name: 'People' });
  const header = grid.getByRole('columnheader', { name: 'Job title' });
  await header.getByRole('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await expect(grid.getByRole('link', { name: / person$/ })).toHaveText([
    'Charlie person',
    'Bravo person',
    'Alpha person',
  ]);
  await header.getByRole('button').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  await expect(grid.getByRole('link', { name: / person$/ }).first()).toHaveText('Alpha person');
  await header.getByRole('button').click();
  await expect(header).not.toHaveAttribute('aria-sort', /.+/);
  expect(page.url()).not.toContain('sort=');

  const resize = grid.getByRole('separator', { name: 'Resize Job title' });
  const before = Number(await resize.getAttribute('aria-valuenow'));
  await resize.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(resize).toHaveAttribute('aria-valuenow', String(before + 32));
  await page.reload();
  await expect(page.getByRole('separator', { name: 'Resize Job title' })).toHaveAttribute(
    'aria-valuenow',
    String(before + 32),
  );

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
});

test('selects rows in a list to delete them together or merge two', async ({
  page,
  retainer: r,
}) => {
  const change = await r.request('/schema/changes', {
    operations: [
      {
        op: 'create_field',
        object: 'person',
        field: {
          name: 'employer',
          label: 'Employer',
          type: 'relation',
          settings: {
            targetObject: 'company',
            inverseField: 'staff',
            relationCardinality: 'many_to_one',
            onDelete: 'cascade',
          },
        },
      },
    ],
  });
  expect(change.status).toBe('applied');
  const company = async (name: string) =>
    (await r.request('/objects/company/records', { values: { name } })).record.id as string;
  const one = await company('One'),
    two = await company('Two');
  await company('Three');
  for (const [name, employer] of [
    ['Dana Levi', one],
    ['Avi Katz', two],
    ['Noa Cohen', two],
  ])
    await r.request('/objects/person/records', { values: { name, employer } });

  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  const grid = page.getByRole('region', { name: 'Companies' });
  await grid.getByRole('checkbox', { name: 'Select One' }).check();
  await grid.getByRole('checkbox', { name: 'Select Two' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  // Checking a box selects; it does not open the record.
  expect(new URL(page.url()).searchParams.get('record')).toBeNull();
  await expect(
    grid.getByRole('checkbox', { name: 'Select all rows on this page' }),
  ).toHaveJSProperty('indeterminate', true);
  await page.screenshot({ path: '/tmp/retainer-web-list-selection.png' });

  // The warning counts what both deletes cascade to, once each.
  await page.getByRole('button', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete 2 companies?' });
  await expect(
    confirm.getByText('Deleting them also deletes 3 people linked to them.'),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete 2 companies', exact: true }).click();
  await expect(page.getByText('Deleted 2 companies and 3 linked records.')).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Three' })).toBeVisible();
  await expect(grid.getByRole('link', { name: 'One' })).not.toBeVisible();
  await expect(page.getByText('2 selected')).not.toBeVisible();
  expect((await r.request(`/objects/person/query`, {})).records).toHaveLength(0);

  // Exactly two selected offers a merge.
  const older = (await r.request('/objects/person/records', { values: { name: 'Yael Mizrahi' } }))
    .record;
  const newer = (await r.request('/objects/person/records', { values: { name: 'Yael Mizrachi' } }))
    .record;
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const people = page.getByRole('region', { name: 'People' });
  await people.getByRole('checkbox', { name: 'Select all rows on this page' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Merge…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Merge duplicate records' });
  await dialog.getByRole('button', { name: 'Merge into Yael Mizrahi' }).click();
  await expect(page.getByText('Merged Yael Mizrachi into')).toBeVisible();
  await expect(people.getByRole('link', { name: /^Yael/ })).toHaveCount(1);
  expect((await r.request(`/records/${newer.id}`)).id).toBe(older.id);
});

test('totals columns over the whole list and edits a cell from the grid', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } });
  await r.request('/objects/person/records', { values: { name: 'Noa Cohen', jobTitle: 'CFO' } });
  const avi = (await r.request('/objects/person/records', { values: { name: 'Avi Katz' } })).record;
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const grid = page.getByRole('region', { name: 'People' });
  await expect(page.getByText('1–3 of 3')).toBeVisible();

  await grid.getByRole('button', { name: 'Calculate Job title' }).click();
  await page.getByRole('menuitemradio', { name: 'Percent empty' }).click();
  await expect(grid.getByRole('button', { name: 'Calculate Job title' })).toHaveText('Empty 33%');
  await grid.getByRole('button', { name: 'Calculate Name' }).click();
  await page.getByRole('menuitemradio', { name: 'Not empty', exact: true }).click();
  await expect(grid.getByRole('button', { name: 'Calculate Name' })).toHaveText('Not empty 3');

  // The pencil edits in place, without opening the record, and the total follows.
  const row = grid.getByRole('row').filter({ hasText: 'Avi Katz' });
  await row.hover();
  await row.getByRole('button', { name: 'Edit Job title of Avi Katz' }).click();
  const input = page.getByRole('textbox', { name: 'Job title', exact: true });
  await expect(input).toBeFocused();
  await page.screenshot({ path: '/tmp/retainer-web-grid-edit.png' });
  await input.fill('CEO');
  await input.press('Enter');
  await expect(input).not.toBeVisible();
  await expect(row.getByText('CEO', { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('record')).toBeNull();
  expect((await r.request(`/records/${avi.id}`)).fields.jobTitle).toBe('CEO');
  await expect(grid.getByRole('button', { name: 'Calculate Job title' })).toHaveText('Empty 0%');

  // Escape drops a draft; the chosen totals are kept for next time.
  await row.hover();
  await row.getByRole('button', { name: 'Edit Job title of Avi Katz' }).click();
  await input.fill('Discarded');
  await page.keyboard.press('Escape');
  await expect(input).not.toBeVisible();
  await expect(row.getByText('CEO', { exact: true })).toBeVisible();
  await page.reload();
  await expect(grid.getByRole('button', { name: 'Calculate Job title' })).toHaveText('Empty 0%');
  await page.screenshot({ path: '/tmp/retainer-web-list-totals.png', fullPage: true });
});

test('finds records, facts and events across objects with the command palette', async ({
  page,
  retainer: r,
}) => {
  const dana = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  await r.request('/objects/company/records', { values: { name: 'Levi Logistics' } });
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'phone',
    fields: { medium: 'call' },
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Quarterly pricing review',
    participants: [{ recordId: dana.id }],
  });
  await r.request(`/records/${dana.id}/facts`, {
    text: 'Wants quarterly invoices',
    source: event.id,
  });
  await signIn(page, r.url, r.keys.user);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Find anything' });
  await palette.getByLabel('Search the workspace').fill('Levi');
  await expect(
    palette.getByRole('region', { name: 'People' }).getByRole('button', { name: 'Dana Levi' }),
  ).toBeVisible();
  await expect(
    palette
      .getByRole('region', { name: 'Companies' })
      .getByRole('button', { name: 'Levi Logistics' }),
  ).toBeVisible();
  await palette.getByLabel('Search the workspace').fill('quarterly');
  await expect(
    palette
      .getByRole('region', { name: 'Events' })
      .getByRole('button', { name: /Quarterly pricing review/ }),
  ).toBeVisible();
  await palette
    .getByRole('region', { name: 'Facts' })
    .getByRole('button', { name: 'Wants quarterly invoices' })
    .click();
  await expect(page.getByRole('heading', { name: 'Dana Levi' })).toBeVisible();
  expect(page.url()).toContain('tab=facts');
  await expect(page.getByText('Wants quarterly invoices')).toBeVisible();
});

test('saves a board view, totals its columns, and moves a card from the keyboard', async ({
  page,
  retainer: r,
}) => {
  await r.request('/templates/sales/apply', {});
  for (const [name, stage, amount] of [
    ['Acme renewal', 'lead', 10_000],
    ['Globex pilot', 'lead', 5_000],
    ['Hooli platform', 'qualified', 20_000],
  ] as const)
    await r.request('/objects/deal/records', { values: { name, stage, amount: usd(amount) } });
  await r.request('/objects/deal/records', { values: { name: 'Unscoped inbound' } });
  await signIn(page, r.url, r.keys.user);
  // By the plural name, which the address also takes; views are the object's either way.
  await page.goto(`${r.url}/app/o/deals`);

  await page.getByRole('button', { name: 'View: All deals' }).click();
  await page.getByRole('menuitem', { name: 'New view…' }).click();
  const dialog = page.getByRole('dialog', { name: 'New view' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Pipeline');
  await dialog.getByRole('button', { name: 'Board', exact: true }).click();
  // The object's only single select is the default.
  await expect(dialog.getByRole('button', { name: /^Group by/ })).toContainText('Stage');
  await dialog.getByRole('button', { name: 'Create view' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'View: Pipeline' })).toBeVisible();
  const viewId = new URL(page.url()).searchParams.get('view');
  expect(viewId).toBeTruthy();

  await expect(page.getByRole('region', { name: 'Lead, 2' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Qualified, 1' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'No stage, 1' })).toBeVisible();

  // A column total is a view setting, saved for everyone.
  await page.getByRole('button', { name: 'Options' }).click();
  await page.getByRole('button', { name: /^Column total/ }).click();
  await page.getByRole('option', { name: 'Sum of Amount' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Lead, 2' })).toContainText('Sum');
  await expect
    .poll(async () => (await r.request(`/views/${viewId}`)).groupAggregate)
    .toEqual({ field: 'amount', op: 'sum' });

  await moveByKeyboard(
    page,
    page.getByRole('button', { name: 'Globex pilot' }),
    'ArrowRight',
    'the Lead column',
    'the Qualified column',
  );
  await expect(page.getByRole('region', { name: 'Qualified, 2' })).toContainText('Globex pilot');
  await expect(page.getByRole('region', { name: 'Lead, 1' })).toBeVisible();
  // The card moves at once; the write lands just after.
  await expect
    .poll(async () => {
      const found = await r.request('/objects/deal/query', {
        filter: { name: { eq: 'Globex pilot' } },
      });
      return [found.records[0].fields.stage, found.records[0].updatedBy];
    })
    .toEqual(['qualified', { type: 'user', id: 'dana' }]);
  await page.screenshot({ path: '/tmp/retainer-web-board.png' });

  // Coming back to the object opens the view used last.
  await page.getByRole('link', { name: 'People', exact: true }).click();
  await page.getByRole('link', { name: 'Deals', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View: Pipeline' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Qualified, 2' })).toBeVisible();
});

test('places records on a calendar and moves one to another day', async ({ page, retainer: r }) => {
  await r.request('/templates/sales/apply', {});
  await r.request('/objects/deal/records', {
    values: { name: 'Acme renewal', closeDate: '2026-03-11' },
  });
  await r.request('/objects/deal/records', { values: { name: 'Undated deal' } });
  const view = await r.request(
    '/objects/deal/views',
    { name: 'Closing', kind: 'calendar', dateField: 'closeDate' },
    r.keys.user,
  );
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/deal?view=${view.id}&month=2026-03`);
  await expect(page.getByText('March 2026')).toBeVisible();
  await expect(page.getByText('1 without a close date')).toBeVisible();
  const day = (label: string) =>
    page.getByRole('heading', { name: label, exact: true }).locator('..');
  const entry = day('Wednesday, March 11').getByRole('button', { name: 'Acme renewal' });
  await expect(entry).toBeVisible();

  await moveByKeyboard(page, entry, 'ArrowRight', 'Wednesday, March 11', 'Thursday, March 12');
  await expect(
    day('Thursday, March 12').getByRole('button', { name: 'Acme renewal' }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const found = await r.request('/objects/deal/query', {
        filter: { name: { eq: 'Acme renewal' } },
      });
      return found.records[0].fields.closeDate;
    })
    .toBe('2026-03-12');
  await expect(page.getByRole('dialog')).not.toBeVisible();

  // Clicking an entry opens the record; the month is in the address.
  await page.getByRole('button', { name: 'Acme renewal' }).click();
  await expect(page.getByRole('dialog', { name: 'Acme renewal' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.getByText('April 2026')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('month')).toBe('2026-04');
  await page.screenshot({ path: '/tmp/retainer-web-calendar.png' });
});

test('moves a record from a busy day\'s "more" panel', async ({ page, retainer: r }) => {
  await r.request('/templates/sales/apply', {});
  for (const name of ['Alpha deal', 'Beta deal', 'Gamma deal', 'Delta deal']) {
    await r.request('/objects/deal/records', { values: { name, closeDate: '2026-03-11' } });
  }
  const view = await r.request(
    '/objects/deal/views',
    { name: 'Closing', kind: 'calendar', dateField: 'closeDate' },
    r.keys.user,
  );
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/deal?view=${view.id}&month=2026-03`);
  const day = (label: string) =>
    page.getByRole('heading', { name: label, exact: true }).locator('..');
  // Three fit; the day shows two and "2 more".
  await day('Wednesday, March 11').getByRole('button', { name: '2 more' }).click();
  const panel = page.getByRole('dialog', { name: 'Wednesday, March 11' });
  const last = panel.getByRole('button', { name: 'Delta deal' });
  await expect(last).toBeVisible();

  // From the keyboard it starts over its own day, not the days the panel covers.
  await moveByKeyboard(page, last, 'ArrowRight', 'Wednesday, March 11', 'Thursday, March 12');
  await expect(day('Thursday, March 12').getByRole('button', { name: 'Delta deal' })).toBeVisible();
  await expect
    .poll(async () => {
      const found = await r.request('/objects/deal/query', {
        filter: { name: { eq: 'Delta deal' } },
      });
      return found.records[0].fields.closeDate;
    })
    .toBe('2026-03-12');
});

test('keeps a changed filter as unsaved until the view is saved or reset', async ({
  page,
  retainer: r,
}) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } });
  await r.request('/objects/person/records', { values: { name: 'Noa Cohen', jobTitle: 'CFO' } });
  const view = await r.request(
    '/objects/person/views',
    { name: 'Executives', kind: 'table', filter: { jobTitle: { eq: 'CTO' } } },
    r.keys.user,
  );
  const grid = page.getByRole('region', { name: 'People' });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/person?view=${view.id}`);
  await expect(grid.getByText('Dana Levi')).toBeVisible();
  await expect(grid.getByText('Noa Cohen')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Save view' })).not.toBeVisible();

  // A filter in the address runs over the view's, and can be reset or saved.
  // The router writes a JSON string param as a quoted string.
  const changed = `${r.url}/app/o/person?view=${view.id}&filter=${encodeURIComponent(
    JSON.stringify(JSON.stringify({ jobTitle: { eq: 'CFO' } })),
  )}`;
  await page.goto(changed);
  await expect(grid.getByText('Noa Cohen')).toBeVisible();
  await expect(grid.getByText('Dana Levi')).not.toBeVisible();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(grid.getByText('Dana Levi')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('filter')).toBeNull();

  await page.goto(changed);
  await page.getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByRole('button', { name: 'Save view' })).not.toBeVisible();
  await expect(grid.getByText('Noa Cohen')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('filter')).toBeNull();
  expect((await r.request(`/views/${view.id}`)).filter).toEqual({ jobTitle: { eq: 'CFO' } });

  // A reader runs the view but cannot change or save it.
  await signOut(page);
  await signIn(page, r.url, r.keys.reader);
  await page.goto(changed);
  await expect(grid.getByText('Noa Cohen')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save view' })).not.toBeVisible();
  await page.getByRole('button', { name: 'View: Executives' }).click();
  await expect(page.getByRole('menuitem', { name: 'New view…' })).not.toBeVisible();
});

test('fits as many of a list as its column holds, and counts the rest', async ({
  page,
  retainer: r,
}) => {
  const [first, ...additional] = [
    'ada.one@example.test',
    'ada.two@example.test',
    'ada.three@example.test',
  ] as const;
  const emails = [first, ...additional];
  await r.request('/objects/person/records', {
    values: { name: 'Ada person', emails: { primary: first, additional } },
  });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const grid = page.getByRole('region', { name: 'People' });
  const row = grid.getByRole('row').filter({ hasText: 'Ada person' });
  const cell = row.getByRole('cell').filter({ hasText: first });
  const resize = grid.getByRole('separator', { name: 'Resize Emails' });

  // Narrow: one address and a count of the rest, all on one line.
  const narrow = Number(await resize.getAttribute('aria-valuenow'));
  await expect(cell.getByText(additional[0])).toHaveCount(0);
  await expect(cell.getByText('+2', { exact: true })).toBeVisible();
  const lineHeight = (await cell.boundingBox())?.height;

  // Wider: every address, and no count.
  await resize.focus();
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight');
  await expect(resize).not.toHaveAttribute('aria-valuenow', String(narrow));
  for (const email of emails) await expect(cell.getByText(email)).toBeVisible();
  await expect(cell.getByText(/^\+\d+$/)).toHaveCount(0);
  expect((await cell.boundingBox())?.height).toBe(lineHeight);
});
