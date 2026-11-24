import { browserExaMappingManifest, expect, test } from './fixtures.js';
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
  for (const count of ['1 existing', '1 new', '1 skipped']) {
    await expect(companies.getByText(count, { exact: true })).toBeVisible();
  }
  await expect(companies.getByRole('button', { name: /^Headquarters/ })).toBeHidden();
  const fields = companies.getByText('Adjust fields', { exact: true });
  await fields.locator('..').focus();
  await page.keyboard.press('Enter');
  const description = companies.getByText(
    'Employees the provider finds, mostly from public profiles.',
  );
  await expect(description).toBeHidden();
  await companies.getByText('About these fields', { exact: true }).click();
  await expect(description).toBeVisible();
  await companies.getByRole('button', { name: /^Headquarters/ }).click();
  await page.getByRole('option', { name: 'Address', exact: true }).click();
  await expect(companies.getByText('2 existing', { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Review installation' }).click();
  const planned = screen.getByRole('listitem', { name: 'Companies' });
  await expect(screen.getByRole('heading', { name: 'Review setup' })).toBeFocused();
  await expect(planned.getByText('2 existing', { exact: true })).toBeVisible();
  await expect(planned.getByText('1 new', { exact: true })).toBeVisible();
  await expect(planned.getByText('Address', { exact: true })).toBeHidden();
  await planned.getByText('Field mappings', { exact: true }).click();
  await expect(planned.getByText('Address', { exact: true })).toBeVisible();
  await expect(planned.getByText('New field “Employee Count”')).toBeVisible();
  await screen.getByText('List and field changes', { exact: true }).click();
  await expect(screen.getByText(/Add field Employee Count/)).toBeVisible();
  expect((await r.request('/extensions', undefined, r.keys.user)).installations).toHaveLength(0);
  await screen.getByRole('button', { name: 'Install browser-enrichment' }).click();
  await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
  const [installed] = (await r.request('/extensions', undefined, r.keys.user)).installations;
  await page.getByRole('button', { name: 'Destinations', exact: true }).click();
  const summary = page.getByRole('region', { name: /saves data$/ });
  await expect(summary.getByRole('listitem', { name: 'Companies' })).toContainText(
    'Headquarters to Address',
  );
  await summary.getByRole('link', { name: 'Change destinations' }).click();
  await companies.getByText('Adjust fields', { exact: true }).click();
  await companies.getByRole('button', { name: /^Headquarters/ }).click();
  await page.getByRole('option', { name: 'Don’t import' }).click();
  await screen.getByRole('button', { name: 'Review new plan' }).click();
  await expect(planned.getByText('1 skipped', { exact: true })).toBeVisible();
  await planned.getByText('Field mappings', { exact: true }).click();
  await expect(planned.getByText('Not imported', { exact: true })).toBeVisible();
  await screen.getByRole('button', { name: 'Approve new plan' }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/${installed.id}$`));
  const detail = await r.request(`/extensions/${installed.id}`, undefined, r.keys.user);
  expect(detail.generation).toBe(installed.generation + 1);
});

test('keeps review and approval within reach on mobile with Exa’s full field list', async ({
  page,
  retainer: r,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/extensions/new/${browserExaMappingManifest.universalId}`);
  const companies = page.getByRole('listitem', { name: 'Companies' });
  await expect(companies.getByText('12 new')).toBeVisible();
  await expect(companies.getByRole('button', { name: /^Employee count/ })).toBeHidden();
  const review = page.getByRole('button', { name: 'Review installation' });
  await expect(review).toBeInViewport();
  await review.click();
  const planned = page
    .getByRole('region', { name: 'Workspace changes' })
    .getByRole('listitem', { name: 'Companies' });
  await expect(planned.getByText('12 new')).toBeVisible();
  const employeeCount = planned.getByText('Employee count', { exact: true });
  const approve = page.getByRole('button', { name: 'Install Exa' });
  await expect(employeeCount).toBeHidden();
  await expect(approve).toBeInViewport({ ratio: 1 });
  await planned.getByText('Field mappings', { exact: true }).click();
  await expect(employeeCount).toBeVisible();
  await expect(approve).toBeInViewport({ ratio: 1 });
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
