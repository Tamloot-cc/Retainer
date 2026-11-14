import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ mappingFixture: true });

test('imports an agent draft, edits it, approves the reviewed mapping and remaps it later', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: 'Set up browser-enrichment', exact: true }).click();
  const dialog = page.getByRole('main');
  await expect(
    dialog.getByText('Employees the provider finds, mostly from public profiles.'),
  ).toBeVisible();

  // An agent's draft fills the form; a field it names that does not exist stays visible.
  await dialog.getByRole('button', { name: 'Import draft' }).click();
  const importer = page.getByRole('dialog', { name: 'Import a mapping draft' });
  await importer.getByLabel('Draft').fill(
    JSON.stringify({
      employee_count: { action: 'create' },
      headquarters: { action: 'existing', field: 'office' },
    }),
  );
  await importer.getByRole('button', { name: 'Import' }).click();
  await expect(importer).not.toBeVisible();
  await expect(
    dialog.getByText('The draft names “office”, which does not exist here.'),
  ).toBeVisible();

  // The admin corrects it before review.
  await dialog.getByRole('button', { name: /^Headquarters destination/ }).click();
  await page.getByRole('option', { name: 'Address' }).click();
  await dialog.getByRole('button', { name: 'Review installation' }).click();
  const bindings = dialog.getByRole('list', { name: 'Field mapping' });
  await expect(bindings.getByText('Employee count → Employee Count')).toBeVisible();
  await expect(bindings.getByText('New field')).toBeVisible();
  // The new field shows once, on its mapping line, not again as a raw schema operation.
  await expect(dialog.getByText('Unknown change')).toHaveCount(0);
  await expect(dialog.getByText(/^Add field /)).toHaveCount(0);
  await expect(bindings.getByText('Headquarters → Address')).toBeVisible();
  await expect(dialog.getByText(/made by an agent/)).toBeVisible();
  expect((await r.request('/extensions', undefined, r.keys.user)).installations).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Approve installation' }).click();
  await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);

  const [installed] = (await r.request('/extensions', undefined, r.keys.user)).installations;
  let detail = await r.request(`/extensions/${installed.id}`, undefined, r.keys.user);
  expect(detail.mapping.outputs.map((o: any) => [o.output, o.field?.name])).toEqual([
    ['employee_count', 'employeeCount'],
    ['headquarters', 'address'],
  ]);
  await page.getByRole('button', { name: 'Field mapping', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Approved field mapping' });
  await expect(summary.getByText('Headquarters → Address')).toBeVisible();

  // A later remap goes through its own review and keeps the installation's settings.
  await summary.getByRole('link', { name: 'Edit mapping' }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit browser-enrichment mapping' }),
  ).toBeVisible();
  await expect(
    dialog.getByText('Changing the mapping does not fill in existing companies.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: /^Headquarters destination/ }).click();
  await page.getByRole('option', { name: 'Skip' }).click();
  await dialog.getByRole('button', { name: 'Review mapping' }).click();
  await expect(dialog.getByText('Headquarters → skipped')).toBeVisible();
  await dialog.getByRole('button', { name: 'Approve mapping' }).click();
  await expect(page).toHaveURL(new RegExp(`/extensions/${installed.id}$`));
  detail = await r.request(`/extensions/${installed.id}`, undefined, r.keys.user);
  expect(detail.mapping.revision).toBe(1);
  expect(detail.generation).toBe(installed.generation + 1);
  await page.getByRole('button', { name: 'Field mapping', exact: true }).click();
  await expect(summary.getByText('Headquarters → skipped')).toBeVisible();
});

test('an agent can preview a mapping draft but cannot approve it', async ({ retainer: r }) => {
  const body = {
    registrationId: 'c3b4d6e2-6a53-4b8c-9f1e-2d7a8b9c0e14',
    version: '1.0.0',
    settings: {},
    mapping: { employee_count: { action: 'create' }, headquarters: { action: 'skip' } },
  };
  const plan = await r.request('/extensions/preview', body, r.keys.agent);
  expect(plan.mapping[0]).toMatchObject({ output: 'employee_count', action: 'create' });
  await expect(
    r.request('/extensions', { ...body, planDigest: plan.planDigest }, r.keys.agent),
  ).rejects.toThrow(/forbidden/);
  expect((await r.request('/extensions', undefined, r.keys.user)).installations).toHaveLength(0);
});
