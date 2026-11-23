import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ mappingFixture: true });

test('reviews and approves binding choices, then replans one output', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: 'Set up browser-enrichment', exact: true }).click();
  const screen = page.getByRole('main');
  const companies = screen.getByRole('listitem', { name: 'Companies' });
  // The fields are folded under a one-line summary until opened.
  await expect(companies).toContainText('Headquarters → Not imported');
  await companies.getByText('Fields', { exact: true }).click();
  await expect(
    screen.getByText('Employees the provider finds, mostly from public profiles.'),
  ).toBeVisible();
  await companies.getByRole('button', { name: /^Headquarters/ }).click();
  await page.getByRole('option', { name: 'Address', exact: true }).click();
  await screen.getByRole('button', { name: 'Review installation' }).click();
  const planned = screen.getByRole('listitem', { name: 'Companies' });
  await expect(planned).toContainText('Headquarters to Address');
  await expect(planned).toContainText('Employee count to New field “Employee Count”');
  expect((await r.request('/extensions', undefined, r.keys.user)).installations).toHaveLength(0);
  await screen.getByRole('button', { name: 'Approve installation' }).click();
  await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
  const [installed] = (await r.request('/extensions', undefined, r.keys.user)).installations;
  await page.getByRole('button', { name: 'Destinations', exact: true }).click();
  const summary = page.getByRole('region', { name: /saves data$/ });
  await expect(summary.getByRole('listitem', { name: 'Companies' })).toContainText(
    'Headquarters to Address',
  );
  await summary.getByRole('link', { name: 'Change destinations' }).click();
  await companies.getByText('Fields', { exact: true }).click();
  await companies.getByRole('button', { name: /^Headquarters/ }).click();
  await page.getByRole('option', { name: 'Don’t import' }).click();
  await screen.getByRole('button', { name: 'Review new plan' }).click();
  await expect(screen.getByRole('listitem', { name: 'Companies' })).toContainText(
    'Headquarters to Not imported',
  );
  await screen.getByRole('button', { name: 'Approve new plan' }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/${installed.id}$`));
  const detail = await r.request(`/extensions/${installed.id}`, undefined, r.keys.user);
  expect(detail.generation).toBe(installed.generation + 1);
});

test('an agent can preview bindings but cannot approve them', async ({ retainer: r }) => {
  const body = {
    registrationId: 'c3b4d6e2-6a53-4b8c-9f1e-2d7a8b9c0e14',
    version: '1.0.0',
    settings: {},
    bindings: { company: { action: 'existing', objects: ['company'] } },
  };
  const plan = await r.request('/extensions/preview', body, r.keys.agent);
  expect(plan.bindings.company).toMatchObject({ action: 'existing', objects: ['company'] });
  await expect(
    r.request('/extensions', { ...body, planDigest: plan.planDigest }, r.keys.agent),
  ).rejects.toThrow(/forbidden/);
  expect((await r.request('/extensions', undefined, r.keys.user)).installations).toHaveLength(0);
});
