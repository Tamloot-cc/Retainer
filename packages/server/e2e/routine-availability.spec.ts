import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('Routines are absent from navigation and direct access when the runner is unavailable', async ({
  page,
  retainer,
}) => {
  await signIn(page, retainer.url, retainer.keys.user);
  await expect(page.getByRole('link', { name: 'Routines', exact: true })).toHaveCount(0);
  await page.goto(`${retainer.url}/app/routines`);
  await expect(page.getByRole('heading', { name: 'Routines are unavailable' })).toBeVisible();
});

test.describe('with a routine runner', () => {
  test.use({ routineFixture: true });

  test('opens Routines from the sidebar', async ({ page, retainer }) => {
    await signIn(page, retainer.url, retainer.keys.user);
    await page.getByRole('link', { name: 'Routines', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No routines yet' })).toBeVisible();
  });
});

test.describe('a routine button', () => {
  test.use({ routineFixture: true });

  test('shows in the side panel of a record opened from a list, as on the full page', async ({
    page,
    retainer: r,
  }) => {
    const dana = (
      await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } })
    ).record;
    // An approved manual routine needs the sandbox to build; its button list is what matters here.
    await page.route('**/v1/routines/buttons*', (route) =>
      route.fulfill({
        json: { buttons: [{ routineId: 'routine-1', name: 'Send welcome', label: 'Welcome' }] },
      }),
    );
    let pressed: unknown;
    await page.route('**/v1/routines/routine-1/run', async (route) => {
      pressed = route.request().postDataJSON();
      await route.fulfill({ status: 202, json: { runs: ['run-1'] } });
    });
    await signIn(page, r.url, r.keys.user);
    await page.getByRole('link', { name: 'People', exact: true }).click();
    const grid = page.getByRole('region', { name: 'People' });
    await grid.getByRole('link', { name: 'Dana Levi' }).click();
    const sheet = page.getByRole('dialog', { name: 'Dana Levi' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Welcome', exact: true }).click();
    await expect(page.getByText('Started “Welcome” on this record.')).toBeVisible();
    expect(pressed).toEqual({ recordIds: [dana.id] });
  });
});
