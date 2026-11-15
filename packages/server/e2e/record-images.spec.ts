import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

const iconService = 'https://twenty-icons.com/';
const icon =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="teal"/></svg>';

test('shows a custom object logo beside its name even when the website column is hidden', async ({
  page,
  retainer: r,
}) => {
  const requested: string[] = [];
  await page.route(`${iconService}*`, async (route) => {
    const url = route.request().url();
    requested.push(url);
    if (url === `${iconService}missing-logo.org`) await route.fulfill({ status: 404 });
    else await route.fulfill({ contentType: 'image/svg+xml', body: icon });
  });
  await r.request('/schema/changes', {
    operations: [
      {
        op: 'create_object',
        object: {
          nameSingular: 'organization',
          namePlural: 'organizations',
          labelSingular: 'Organization',
          labelPlural: 'Organizations',
          labelField: 'name',
          fields: [
            { name: 'name', label: 'Name', type: 'text' },
            { name: 'website', label: 'Website', type: 'links' },
          ],
        },
      },
    ],
  });
  const org = (
    await r.request(
      '/objects/organization/records',
      {
        values: {
          name: 'Northwind',
          website: { primary: { url: 'https://www.northwind.org/team?private=1' } },
        },
      },
      r.keys.user,
    )
  ).record;
  await r.request(
    '/objects/organization/records',
    {
      values: { name: 'No icon', website: { primary: { url: 'https://missing-logo.org' } } },
    },
    r.keys.user,
  );
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/schema?object=organization`);
  await page.getByRole('button', { name: 'Record image' }).click();
  await page.getByRole('option', { name: 'Website', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Record image' })).toContainText('Website');
  const browse = page.getByRole('link', { name: 'Browse records' });
  await browse.click();
  const grid = page.getByRole('region', { name: 'Organizations' });
  const logo = grid.getByRole('link', { name: 'Northwind', exact: true }).locator('img');
  await expect(grid.getByRole('link', { name: 'Northwind', exact: true })).toBeVisible();
  await expect(logo).toHaveCount(0);
  expect(requested).toEqual([]);

  await page.goto(`${r.url}/app/schema?object=organization`);
  const enable = page.getByRole('switch', { name: 'Load external record images' });
  await enable.click();
  await expect(enable).toBeChecked();
  await browse.click();
  await expect(logo).toHaveAttribute('src', `${iconService}northwind.org`);
  await expect(logo).toHaveCSS('opacity', '1');
  const missing = grid.getByRole('link', { name: 'No icon', exact: true });
  await expect.poll(() => requested.includes(`${iconService}missing-logo.org`)).toBe(true);
  await expect(missing.locator('img')).toHaveCount(0);
  await expect(missing.locator('svg')).toBeVisible();

  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Website' }).uncheck();
  await page.keyboard.press('Escape');
  await expect(grid.getByRole('columnheader', { name: 'Website' })).toHaveCount(0);
  await expect(logo).toHaveCSS('opacity', '1');

  await r.request(
    '/schema/changes',
    {
      operations: [
        { op: 'rename_field', object: 'organization', field: 'website', name: 'homepage' },
      ],
    },
    r.keys.user,
  );
  await page.reload();
  await expect(logo).toHaveAttribute('src', `${iconService}northwind.org`);
  await r.request(
    `/records/${org.id}`,
    {
      values: { homepage: { primary: { url: 'https://new-northwind.org' } } },
    },
    r.keys.user,
    'PATCH',
  );
  await page.reload();
  await expect(logo).toHaveAttribute('src', `${iconService}new-northwind.org`);
  await grid.getByRole('link', { name: 'Northwind', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Northwind' }).locator('img')).toHaveAttribute(
    'src',
    `${iconService}new-northwind.org`,
  );

  await page.goto(`${r.url}/app/schema?object=organization`);
  await enable.click();
  await expect(enable).not.toBeChecked();
  await browse.click();
  await expect(logo).toHaveCount(0);
});
