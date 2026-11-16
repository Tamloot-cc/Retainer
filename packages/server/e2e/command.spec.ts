import { expect, test } from './fixtures.js';
import { signIn, signOut } from './helpers.js';

const shortcut = process.platform === 'darwin' ? 'Meta+k' : 'Control+k';

test('keyboard search, contextual results, fact navigation, recent validation and create actions', async ({
  page,
  retainer: r,
}) => {
  const dana = (
    await r.request(
      '/objects/person/records',
      {
        values: { name: 'Dana Levi', emails: 'dana@acme.test' },
      },
      r.keys.user,
    )
  ).record;
  const event = await r.request(
    '/events',
    {
      type: 'conversation',
      channel: 'zoom',
      title: 'Acme renewal call',
      summary: 'Renewal timing with Dana',
      occurredAt: '2026-11-16T10:00:00Z',
      participants: [{ recordId: dana.id }],
      about: [],
    },
    r.keys.user,
  );
  const fact = await r.request(
    `/records/${dana.id}/facts`,
    { text: 'Acme requires quarterly invoices', source: event.id },
    r.keys.user,
  );
  await signIn(page, r.url, r.keys.user);
  await page.keyboard.press(shortcut);
  const dialog = page.getByRole('dialog', { name: 'Search and commands' });
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  await input.fill('dana');
  const person = dialog.getByRole('option').filter({ hasText: 'dana@acme.test' });
  await expect(person).toBeVisible();
  await expect(person).toContainText('Person');
  await input.press('ArrowDown');
  await input.press('ArrowUp');
  if (process.env.RETAINER_CAPTURE_COMMAND) {
    await input.fill('acme');
    await expect(
      dialog.getByRole('option').filter({ hasText: 'Acme requires quarterly invoices' }),
    ).toBeVisible();
    await page.screenshot({ path: '/tmp/retainer-command-desktop.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: '/tmp/retainer-command-dark.png', animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'light' });
    await input.fill('dana');
    await expect(person).toBeVisible();
  }
  // Pointer selection and keyboard selection both use the same destination.
  await person.click();
  await expect(page).toHaveURL(new RegExp(`/app/r/${dana.id}$`));
  await expect(page.getByRole('heading', { name: 'Dana Levi', exact: true })).toBeVisible();
  await page.keyboard.press(shortcut);
  await expect(dialog.getByText('Recent', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('option').filter({ hasText: 'Dana Levi' })).toBeVisible();
  await expect(input).toHaveValue('');
  await input.fill('quarterly');
  await dialog.getByRole('option').filter({ hasText: 'Acme requires quarterly invoices' }).click();
  await expect(page).toHaveURL(new RegExp(`fact=${fact.fact.id}`));
  await expect(page.locator(`#fact-${fact.fact.id}`)).toBeFocused();
  await page.keyboard.press(shortcut);
  await input.fill('Acme renewal');
  await expect(dialog.getByRole('option').filter({ hasText: 'Acme renewal call' })).toContainText(
    'Dana Levi',
  );
  await dialog.getByRole('option').filter({ hasText: 'Acme renewal call' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/e/${event.id}$`));
  await page.keyboard.press(shortcut);
  await input.fill('create person');
  await input.press('ArrowDown');
  await input.press('Enter');
  const form = page.getByRole('dialog', { name: 'New person', exact: true });
  await expect(form).toBeVisible();
  await form.getByLabel('First name', { exact: true }).fill('Avi');
  await form.getByLabel('Last name', { exact: true }).fill('Cohen');
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Avi Cohen', exact: true })).toBeVisible();
  // Delete a visited record outside the browser; recents must re-check before showing its label.
  await r.request(`/records/${dana.id}`, undefined, r.keys.user, 'DELETE');
  await page.keyboard.press(shortcut);
  await expect(dialog.getByRole('option').filter({ hasText: 'Dana Levi' })).toHaveCount(0);
  await input.fill('review');
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(`${r.url}/app/review`);
});

test('new-tab navigation, empty/error states, query races, mobile layout and read-only permissions', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.reader);
  await page.keyboard.press(shortcut);
  const dialog = page.getByRole('dialog', { name: 'Search and commands' });
  const input = dialog.getByRole('combobox');
  await expect(dialog.getByRole('option').filter({ hasText: 'Create person' })).toHaveCount(0);
  await expect(dialog.getByRole('option').filter({ hasText: 'Settings' })).toHaveCount(0);
  await input.fill('companies');
  await input.press('ArrowDown');
  const popupPromise = page.waitForEvent('popup');
  await input.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  const popup = await popupPromise;
  await expect(popup).toHaveURL(`${r.url}/app/o/company`);
  await popup.close();
  await expect(dialog).toBeVisible();
  await input.fill('zzzznothingmatches');
  await expect(dialog.getByText('No results for “zzzznothingmatches”')).toBeVisible();
  await page.route('**/v1/search', async (route) => {
    const body = route.request().postDataJSON();
    if (body.query === 'broken')
      await route.fulfill({
        status: 500,
        json: { error: { code: 'internal_error', message: 'Unavailable' } },
      });
    else await route.continue();
  });
  await input.fill('broken');
  await expect(dialog.getByRole('alert')).toContainText('Search couldn’t load');
  await input.fill('activity');
  await expect(dialog.getByRole('option').filter({ hasText: 'Activity' })).toBeVisible();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill('');
  if (process.env.RETAINER_CAPTURE_COMMAND) {
    await expect
      .poll(async () => (await dialog.getByRole('listbox').boundingBox())?.height ?? 0)
      .toBeGreaterThan(400);
    await page.screenshot({ path: '/tmp/retainer-command-mobile.png', animations: 'disabled' });
  }
  const box = await dialog.boundingBox();
  if (!box) throw new Error('Command dialog is not visible');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await input.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await signOut(page);
  await signIn(page, r.url, r.keys.agent);
  await page.keyboard.press(shortcut);
  await expect(dialog.getByRole('option').filter({ hasText: 'Create person' })).toHaveCount(0);
});

test('expands bounded results and removes old hits immediately when the query changes', async ({
  page,
  retainer: r,
}) => {
  for (let i = 0; i < 7; i++) {
    await r.request('/objects/person/records', { values: { name: `Palette person ${i}` } });
  }
  await signIn(page, r.url, r.keys.user);
  await page.keyboard.press(shortcut);
  const dialog = page.getByRole('dialog', { name: 'Search and commands' });
  const input = dialog.getByRole('combobox');
  await input.fill('Palette');
  const hits = dialog.getByRole('option').filter({ hasText: 'Palette person' });
  await expect(hits).toHaveCount(5);
  await dialog.getByRole('option').filter({ hasText: 'Show more results' }).click();
  await expect(hits).toHaveCount(7);
  await expect(dialog.getByRole('option').filter({ hasText: 'Show more results' })).toHaveCount(0);
  // Hold the next server response. Local navigation remains usable, old hits cannot be selected.
  let release: () => void = () => {};
  const response = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/v1/search', async (route) => {
    await response;
    await route.continue().catch(() => {});
  });
  await input.fill('review');
  await expect(hits).toHaveCount(0);
  await expect(dialog.getByRole('option').filter({ hasText: 'Review' })).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(`${r.url}/app/review`);
  release();
});
