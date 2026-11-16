import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('the top bar breadcrumb leads back to the list a page belongs to', async ({
  page,
  retainer: r,
}) => {
  const dana = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Renewal call',
    participants: [{ recordId: dana.id }],
  });
  const crumbs = page.locator('section > header');
  await signIn(page, r.url, r.keys.user);

  await page.goto(`${r.url}/app/r/${dana.id}`);
  await crumbs.getByRole('link', { name: 'Record · Person' }).click();
  await expect(page).toHaveURL(/\/app\/o\/person/);

  await page.goto(`${r.url}/app/e/${event.id}`);
  await crumbs.getByRole('link', { name: 'Activity · Conversation' }).click();
  await expect(page).toHaveURL(/\/app\/o\/conversation/);
  await crumbs.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(page).toHaveURL(`${r.url}/app/`);
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  // A crumb with nowhere to go stays plain text.
  await expect(crumbs.getByRole('link')).toHaveCount(0);

  await page.goto(`${r.url}/app/o/person`);
  await expect(crumbs.getByText('Records', { exact: true })).toBeVisible();
  await expect(crumbs.getByRole('link')).toHaveCount(0);
});
