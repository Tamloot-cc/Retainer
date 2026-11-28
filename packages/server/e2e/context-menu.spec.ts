import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

// The right-click menu for records (docs/specs/context-menu.md).

const menu = (page: Page) => page.getByRole('menu');

async function people(page: Page, url: string, key: string) {
  await signIn(page, url, key);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  return page.getByRole('region', { name: 'People' });
}

test('right-clicks a row to delete it', async ({ page, retainer: r }) => {
  for (const name of ['Dana Levi', 'Avi Katz'])
    await r.request('/objects/person/records', { values: { name } });
  const grid = await people(page, r.url, r.keys.user);
  await grid.getByRole('link', { name: 'Dana Levi' }).click({ button: 'right' });
  await expect(menu(page)).toHaveAccessibleName('Actions for Dana Levi');
  await menu(page).getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Dana Levi?' });
  await confirm.getByRole('button', { name: 'Delete record' }).click();
  await expect(page.getByText('Deleted Dana Levi.')).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Dana Levi' })).toHaveCount(0);
  await expect(grid.getByRole('link', { name: 'Avi Katz' })).toBeVisible();
});

test('right-clicking a selected row acts on all of them; another row is selected alone', async ({
  page,
  retainer: r,
}) => {
  for (const name of ['Dana Levi', 'Avi Katz', 'Noa Cohen', 'Yael Mizrahi'])
    await r.request('/objects/person/records', { values: { name } });
  const grid = await people(page, r.url, r.keys.user);

  // An unselected row: it alone becomes the selection.
  await grid.getByRole('checkbox', { name: 'Select Dana Levi' }).check();
  await grid.getByRole('checkbox', { name: 'Select Avi Katz' }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await grid.getByRole('link', { name: 'Yael Mizrahi' }).click({ button: 'right' });
  await expect(menu(page)).toHaveAccessibleName('Actions for Yael Mizrahi');
  await expect(page.getByText('1 selected')).toBeVisible();
  await expect(grid.getByRole('checkbox', { name: 'Select Yael Mizrahi' })).toBeChecked();
  await expect(grid.getByRole('checkbox', { name: 'Select Dana Levi' })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);

  // A selected row: the menu acts on every selected row.
  await grid.getByRole('checkbox', { name: 'Select Dana Levi' }).check();
  await grid.getByRole('checkbox', { name: 'Select Avi Katz' }).check();
  await expect(page.getByText('3 selected')).toBeVisible();
  await grid.getByRole('link', { name: 'Avi Katz' }).click({ button: 'right' });
  await expect(menu(page)).toHaveAccessibleName('Actions for 3 people');
  await menu(page).getByRole('menuitem', { name: 'Delete 3 people…' }).click();
  await page
    .getByRole('dialog', { name: 'Delete 3 people?' })
    .getByRole('button', { name: 'Delete 3 people', exact: true })
    .click();
  await expect(page.getByText('Deleted 3 people.')).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Noa Cohen' })).toBeVisible();
  await expect(grid.getByRole('link')).toHaveCount(1);
  await expect(page.getByText(/selected$/)).toHaveCount(0);
});

test('right-clicks a cell to see where its value came from', async ({ page, retainer: r }) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } });
  const grid = await people(page, r.url, r.keys.user);
  await grid.getByRole('cell', { name: 'CTO' }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'History of Job title' }).click();
  const history = page.getByRole('dialog', { name: 'History of Job title' });
  await expect(history.getByText('CTO')).toBeVisible();
});

test('the browser’s menu stays outside a record', async ({ page, retainer: r }) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi' } });
  const grid = await people(page, r.url, r.keys.user);
  await expect(grid.getByRole('link', { name: 'Dana Levi' })).toBeVisible();
  await page.getByRole('heading', { name: 'People' }).click({ button: 'right' });
  await grid.getByRole('columnheader', { name: 'Name' }).click({ button: 'right' });
  await expect(menu(page)).toHaveCount(0);
});

test('a read-only person sees no actions that change records', async ({ page, retainer: r }) => {
  await r.request('/objects/person/records', { values: { name: 'Dana Levi' } });
  const grid = await people(page, r.url, r.keys.reader);
  await grid.getByRole('link', { name: 'Dana Levi' }).click({ button: 'right' });
  await expect(menu(page).getByRole('menuitem', { name: 'Open in new tab' })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
  for (const name of [/Delete/, /Merge/, /Erase/])
    await expect(menu(page).getByRole('menuitem', { name })).toHaveCount(0);
});

test.describe('with a routine button', () => {
  test.use({ routineFixture: true });

  test('runs a routine on two selected records', async ({ page, retainer: r }) => {
    const ids: string[] = [];
    for (const name of ['Dana Levi', 'Avi Katz'])
      ids.push((await r.request('/objects/person/records', { values: { name } })).record.id);
    // An approved manual routine needs the sandbox to build; its button list is what matters here.
    await page.route('**/v1/routines/buttons*', (route) =>
      route.fulfill({
        json: { buttons: [{ routineId: 'routine-1', name: 'Send welcome', label: 'Welcome' }] },
      }),
    );
    let pressed: unknown;
    await page.route('**/v1/routines/routine-1/run', async (route) => {
      pressed = route.request().postDataJSON();
      await route.fulfill({ status: 202, json: { runs: ['run-1', 'run-2'] } });
    });
    const grid = await people(page, r.url, r.keys.user);
    await grid.getByRole('checkbox', { name: 'Select all rows on this page' }).check();
    await grid.getByRole('link', { name: 'Dana Levi' }).click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Welcome on 2 people' }).click();
    await expect(page.getByText('Started “Welcome” on 2 records.')).toBeVisible();
    expect((pressed as { recordIds: string[] }).recordIds.sort()).toEqual([...ids].sort());
  });
});
