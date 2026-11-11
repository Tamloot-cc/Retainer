import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ sourceFixture: true });
test('shows current provider evidence once and preserves immutable historical revisions', async ({
  page,
  retainer: r,
}) => {
  const source = await r.sourceEvidence();
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${source.personId}?tab=events`);
  await expect(page.getByRole('link', { name: 'Edited provider note', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Original provider note', exact: true })).toHaveCount(
    0,
  );
  await page.goto(`${r.url}/app/r/${source.previousEventId}`);
  await expect(page.getByText(/This provider revision was superseded/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit Title', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add participant…', exact: true })).toHaveCount(0);
  await page.goto(`${r.url}/app/r/${source.currentEventId}`);
  await expect(page.getByText(/This is the current provider revision/)).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Original provider note', exact: true }),
  ).toBeVisible();
});
