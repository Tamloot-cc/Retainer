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
