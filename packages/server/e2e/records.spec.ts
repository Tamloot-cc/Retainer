import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('edits schema-driven scalar and composite fields through the real API', async ({
  page,
  retainer: r,
}) => {
  await r.request(
    '/schema/changes',
    {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'score', label: 'Score', type: 'number' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'active', label: 'Active', type: 'boolean' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'renewal', label: 'Renewal date', type: 'date' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'meetingAt', label: 'Meeting at', type: 'date_time' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'budget', label: 'Budget', type: 'money' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: {
            name: 'stage',
            label: 'Stage',
            type: 'select',
            settings: {
              options: [
                { value: 'new', label: 'New' },
                { value: 'ready', label: 'Ready' },
              ],
            },
          },
        },
        {
          op: 'create_field',
          object: 'person',
          field: {
            name: 'topics',
            label: 'Topics',
            type: 'multi_select',
            settings: {
              options: [
                { value: 'security', label: 'Security' },
                { value: 'billing', label: 'Billing' },
              ],
            },
          },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'sites', label: 'Sites', type: 'links' },
        },
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'metadata', label: 'Metadata', type: 'json' },
        },
      ],
    },
    r.keys.user,
  );
  const company = (
    await r.request('/objects/company/records', { values: { name: 'Acme Company' } })
  ).record;
  const record = (
    await r.request('/objects/person/records', {
      values: { name: 'Dana Levi', metadata: { source: 'test' } },
    })
  ).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${record.id}`);
  async function edit(label: string, change: () => Promise<unknown>) {
    await page.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
    await change();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    // The button reads "Saving…" while in flight; the editor closes once the write lands.
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  }
  // Fields chosen from a list save on the pick and close; the list goes away.
  async function pick(label: string, option: string) {
    await page.getByRole('button', { name: `Edit ${label}`, exact: true }).click();
    await page.getByRole('option', { name: option, exact: true }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
  }
  await edit('Score', () => page.getByLabel('Score', { exact: true }).fill('42.5'));
  await pick('Active', 'Yes');
  await edit('Renewal date', () =>
    page.getByLabel('Renewal date', { exact: true }).fill('2026-12-01'),
  );
  await edit('Meeting at', () =>
    page.getByLabel('Meeting at', { exact: true }).fill('2026-12-01T14:30'),
  );
  await edit('Budget', async () => {
    await page.getByLabel('Amount', { exact: true }).fill('0.000001');
    await page.getByRole('button', { name: 'Currency USD' }).click();
    await page.getByRole('combobox', { name: 'Search currency' }).fill('shekel');
    await page.getByRole('option', { name: 'ILS', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Currency ILS' })).toBeVisible();
  });
  await pick('Stage', 'Ready');
  // Several choices are kept until the list is left: here with ⌘/Ctrl+Enter.
  await page.getByRole('button', { name: 'Edit Topics', exact: true }).click();
  await page.getByRole('option', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Security', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await edit('Emails', async () => {
    await page.getByRole('button', { name: 'Add email' }).click();
    await page.getByLabel('Email 1', { exact: true }).fill('Dana@acme.test');
  });
  await edit('Phones', async () => {
    await page.getByRole('button', { name: 'Add phone' }).click();
    await page.getByLabel('Phone 1', { exact: true }).fill('+972501234567');
    await page.getByLabel('Country code 1', { exact: true }).fill('IL');
  });
  await edit('Sites', async () => {
    await page.getByRole('button', { name: 'Add link' }).click();
    await page.getByLabel('URL 1', { exact: true }).fill('https://acme.test');
    await page.getByLabel('Link label 1', { exact: true }).fill('Website');
  });
  await edit('Address', () => page.getByLabel('City', { exact: true }).fill('Tel Aviv'));
  await edit('Name', () => page.getByLabel('First name', { exact: true }).fill('Danielle'));
  await page.getByRole('button', { name: 'Edit Company', exact: true }).click();
  await page.getByRole('combobox', { name: 'Company', exact: true }).fill('Acme');
  await expect(page.getByRole('option', { name: 'Acme Company' })).toHaveCount(1);
  await page.getByRole('option', { name: 'Acme Company' }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Metadata', exact: true })).not.toBeVisible();
  const updated = await r.request(`/records/${record.id}`);
  expect(updated.fields).toMatchObject({
    name: { first: 'Danielle', last: 'Levi' },
    score: 42.5,
    active: true,
    renewal: '2026-12-01',
    budget: { amountMicros: 1, currency: 'ILS' },
    stage: 'ready',
    topics: ['security'],
    emails: { primary: 'dana@acme.test' },
    phones: { primary: { number: '+972501234567', countryCode: 'IL' } },
    sites: { primary: { url: 'https://acme.test', label: 'Website' } },
    address: { city: 'Tel Aviv' },
    company: company.id,
    metadata: { source: 'test' },
  });
});

test('opens records from the list in a side sheet and edits fields inline', async ({
  page,
  retainer: r,
}) => {
  const dana = (
    await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } })
  ).record;
  await r.request('/objects/person/records', { values: { name: 'Noa Cohen', jobTitle: 'CFO' } });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const grid = page.getByRole('region', { name: 'People' });
  const danaLink = grid.getByRole('link', { name: 'Dana Levi' });
  const noaLink = grid.getByRole('link', { name: 'Noa Cohen' });

  // The name link opens the sheet and records it in the URL.
  await danaLink.click();
  const sheet = page.getByRole('dialog', { name: 'Dana Levi' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toBeFocused();
  expect(new URL(page.url()).searchParams.get('record')).toBe(dana.id);

  // Click the value, type, Enter: saved through the API and shown in the grid behind.
  await sheet.getByText('CTO', { exact: true }).click();
  const input = sheet.getByRole('textbox', { name: 'Job title', exact: true });
  await expect(input).toBeFocused();
  await input.fill('Chief Technology Officer');
  await input.press('Enter');
  await expect(input).not.toBeVisible();
  await expect(sheet.getByText('Chief Technology Officer', { exact: true })).toBeVisible();
  await expect(grid.getByText('Chief Technology Officer', { exact: true })).toBeVisible();
  expect((await r.request(`/records/${dana.id}`)).fields.jobTitle).toBe('Chief Technology Officer');

  // Escape cancels an edit without closing the sheet; the next Escape closes it.
  await sheet.getByRole('button', { name: 'Edit Job title', exact: true }).click();
  await input.fill('Discarded draft');
  await page.keyboard.press('Escape');
  await expect(input).not.toBeVisible();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Chief Technology Officer', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).not.toBeVisible();
  await expect(danaLink).toBeFocused();
  expect(new URL(page.url()).searchParams.get('record')).toBeNull();

  // Back reopens it; clicking another row while open swaps the record.
  await page.goBack();
  await expect(sheet).toBeVisible();
  await noaLink.click();
  const noaSheet = page.getByRole('dialog', { name: 'Noa Cohen' });
  await expect(noaSheet).toBeVisible();
  await expect(sheet).not.toBeVisible();
  await noaSheet.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(noaLink).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(noaSheet).toBeVisible();

  // The full page is one click away and edits the same way.
  await page.getByRole('link', { name: 'Open full page' }).click();
  await expect(page.getByRole('heading', { name: 'Noa Cohen', level: 1 })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.screenshot({ path: '/tmp/retainer-web-sheet.png', fullPage: true });
});

test('creates a record from the list with a schema-driven form', async ({ page, retainer: r }) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'People', exact: true }).click();
  const newPerson = page.getByRole('button', { name: 'New person', exact: true });
  await newPerson.click();
  const form = page.getByRole('dialog', { name: 'New person' });
  await expect(form.getByLabel('First name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(newPerson).toBeFocused();
  await newPerson.press('Enter');
  await form.getByLabel('First name').fill('Noa');
  await form.getByLabel('Last name').fill('Peretz');
  await form.getByRole('button', { name: 'Job title', exact: true }).click();
  await form.getByRole('textbox', { name: 'Job title', exact: true }).fill('Head of Sales');
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  // The new record opens in the sheet over the list, which already shows it.
  const sheet = page.getByRole('dialog', { name: 'Noa Peretz' });
  await expect(sheet.getByText('Head of Sales', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Noa Peretz' })).toBeVisible();
  const id = new URL(page.url()).searchParams.get('record');
  expect(await r.request(`/records/${id}`)).toMatchObject({
    fields: { name: { first: 'Noa', last: 'Peretz' }, jobTitle: 'Head of Sales' },
    createdBy: { type: 'user', id: 'dana' },
  });
});

test.describe('touch composer', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 568 } });

  test('keeps property controls tappable and the submit action visible', async ({
    page,
    retainer: r,
  }) => {
    await signIn(page, r.url, r.keys.user);
    await page.goto(`${r.url}/app/o/task`);
    await page.getByRole('button', { name: 'New task', exact: true }).tap();
    const composer = page.getByRole('dialog', { name: 'New task', exact: true });
    const dueDate = composer.getByRole('button', { name: 'Due date', exact: true });
    await expect(dueDate).toHaveCSS('min-height', '44px');
    await dueDate.tap();
    const dateInput = composer
      .getByLabel('Due date', { exact: true })
      .and(composer.locator('input'));
    await expect(dateInput).toBeFocused();
    await expect(dateInput).toHaveCSS('min-height', '44px');
    await expect(dateInput).toHaveCSS('font-size', '16px');
    await page.setViewportSize({ width: 320, height: 380 });
    await expect(composer.getByRole('button', { name: 'Create task' })).toBeInViewport();
  });
});

test('checks required fields and shows a unique conflict on the field', async ({
  page,
  retainer: r,
}) => {
  const holder = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Claim holder', emails: 'taken@acme.test', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  const change = await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isNullable: false }],
  });
  await r.request(`/schema/changes/${change.change.id}/approve`, {}, r.keys.user);
  expect(holder.fields.jobTitle).toBe('CTO');
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/person`);
  await page.getByRole('button', { name: 'New person', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'New person' });
  await form.getByLabel('First name').fill('Second');
  await form.getByRole('button', { name: 'Emails', exact: true }).click();
  await form.getByRole('button', { name: 'Add email' }).click();
  await form.getByRole('textbox', { name: 'Email 1' }).fill('taken@acme.test');
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  await expect(form.getByText('Job title is required')).toBeVisible();
  await form.getByRole('textbox', { name: 'Job title', exact: true }).fill('CFO');
  await form.getByRole('button', { name: /^Emails/ }).click();
  await expect(form.getByRole('textbox', { name: 'Email 1' })).toBeHidden();
  await form.getByRole('button', { name: 'Create person', exact: true }).click();
  await expect(form.getByText('Emails already belongs to another record')).toBeVisible();
  const email = form.getByRole('textbox', { name: 'Email 1' });
  await expect(email).toHaveValue('taken@acme.test');
  await expect(email).toHaveAccessibleDescription('Emails already belongs to another record');
  await expect(form.getByRole('link', { name: 'View that record' })).toBeVisible();
  expect((await r.request('/objects/person/query', {})).records).toHaveLength(1);
});

test('deletes a record from its sheet and reports it', async ({ page, retainer: r }) => {
  const record = (
    await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }, r.keys.user)
  ).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/o/person?record=${record.id}`);
  const sheet = page.getByRole('dialog', { name: 'Dana Levi' });
  await sheet.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Dana Levi?' });
  await confirm.getByRole('button', { name: 'Delete record', exact: true }).click();
  await expect(page.getByText('Deleted Dana Levi.')).toBeVisible();
  await expect(sheet).not.toBeVisible();
  await expect(page.getByText('No records found')).toBeVisible();
  await expect(r.request(`/records/${record.id}`)).rejects.toThrow(/record_deleted/);
});

test('warns before a delete that cascades to linked records', async ({ page, retainer: r }) => {
  const change = await r.request('/schema/changes', {
    operations: [
      {
        op: 'create_field',
        object: 'person',
        field: {
          name: 'employer',
          label: 'Employer',
          type: 'relation',
          settings: {
            targetObject: 'company',
            inverseField: 'staff',
            relationCardinality: 'many_to_one',
            onDelete: 'cascade',
          },
        },
      },
    ],
  });
  expect(change.status).toBe('applied');
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  await r.request('/objects/person/records', { values: { name: 'Dana Levi', employer: acme.id } });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${acme.id}`);
  await page.getByRole('button', { name: 'Record actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Acme?' });
  await expect(confirm.getByText('Deleting it also deletes 1 person linked to it.')).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete record', exact: true }).click();
  await expect(page.getByText('Deleted Acme and 1 linked record.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
});

test('shows Linked even on an entity with no relations', async ({ page, retainer: r }) => {
  await r.request(
    '/schema/changes',
    {
      reason: 'An object without relations',
      operations: [
        {
          op: 'create_object',
          object: {
            nameSingular: 'site',
            namePlural: 'sites',
            labelSingular: 'Site',
            labelPlural: 'Sites',
            labelField: 'name',
            fields: [{ name: 'name', label: 'Name', type: 'text' }],
          },
        },
      ],
    },
    r.keys.user,
  );
  const site = (await r.request('/objects/site/records', { values: { name: 'Haifa' } })).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${site.id}?tab=linked`);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('button')).toHaveText([
    'Comments',
    'Facts',
    'Activity',
    'History',
    'Linked',
  ]);
  await expect(page.getByText('No linked records')).toBeVisible();
});

test('the record sheet keeps long text inside it, and its tabs still as they change', async ({
  page,
  retainer: r,
}) => {
  const unbroken = 'Averyveryveryverylongunbrokenword'.repeat(12);
  const acme = (
    await r.request('/objects/company/records', { values: { name: 'Acme' } }, r.keys.user)
  ).record;
  await r.request(`/records/${acme.id}/comments`, { body: unbroken }, r.keys.user);
  await r.request(`/records/${acme.id}/facts`, { text: unbroken });
  for (let i = 0; i < 25; i++) {
    await r.request('/events', {
      type: 'conversation',
      channel: 'zoom',
      externalId: `long-${i}`,
      occurredAt: new Date(Date.UTC(2026, 9, 1 + i, 10)).toISOString(),
      title: `Call ${i}`,
      summary: unbroken,
      about: [acme.id],
    });
  }
  await signIn(page, r.url, r.keys.user);
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 760 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${r.url}/app/o/company?record=${acme.id}`);
    const sheet = page.getByRole('dialog');
    const nav = sheet.getByRole('navigation', { name: 'Sections' });
    const scroller = sheet.locator('.overflow-y-auto').first();
    const place = async () => ({
      top: Math.round((await nav.boundingBox())?.y ?? -1),
      overflow: await scroller.evaluate((el) => el.scrollWidth - el.clientWidth),
    });
    // Scrolled down a long tab, every other tab starts right under the row.
    await nav.getByRole('button', { name: 'Activity' }).click();
    await expect(sheet.getByRole('list', { name: 'Activity' })).toBeVisible();
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const stuck = (await place()).top;
    for (const tab of [/^Comments/, /^Facts/, 'History', /^Linked/, 'Activity']) {
      await nav.getByRole('button', { name: tab }).click();
      await page.waitForLoadState('networkidle');
      const now = await place();
      expect(now.top).toBe(stuck);
      expect(now.overflow).toBe(0);
    }
  }
});

test('shows API names, IDs, write paths and JSON in developer view, remembered per browser', async ({
  page,
  retainer: r,
}) => {
  const dana = (
    await r.request('/objects/person/records', { values: { name: 'Dana Levi', jobTitle: 'CTO' } })
  ).record;
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    externalId: 'zoom-42',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Intro call',
    participants: [{ recordId: dana.id }],
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${dana.id}`);
  await expect(page.getByText('Record · Person')).toBeVisible();
  await expect(page.getByText('upsert_record')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'JSON' })).toHaveCount(0);

  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Developer view' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('upsert_record', { exact: true })).toBeVisible();
  await expect(page.getByText(`PATCH /v1/records/${dana.id}`)).toBeVisible();
  await expect(page.getByText(dana.id, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy ID' })).toBeVisible();
  await expect(page.getByText('jobTitle', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Record JSON' })).toContainText(
    `"id": "${dana.id}"`,
  );
  // Event rows show how they are attached and their raw identity.
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByText('via {"kind":"participant"}')).toBeVisible();
  await expect(page.getByText('externalId "zoom-42"')).toBeVisible();
  // An event names its own write path.
  await page.goto(`${r.url}/app/e/${event.id}`);
  await expect(page.getByText('log_event', { exact: true })).toBeVisible();
  await expect(page.getByText('POST /v1/events', { exact: true })).toBeVisible();
  // Column headers show API names too, and the switch survives a reload.
  await page.reload();
  await page.goto(`${r.url}/app/o/person`);
  await expect(
    page.getByRole('columnheader', { name: /Job title/ }).getByText('jobTitle'),
  ).toBeVisible();

  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Developer view' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByText('jobTitle', { exact: true })).toHaveCount(0);
  await page.goto(`${r.url}/app/r/${dana.id}`);
  await expect(page.getByText('upsert_record')).toHaveCount(0);
});

test('Linked groups pages by object and agrees with context and the tab count', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  await r.request('/objects/person/records', { values: { name: 'Dana', company: acme.id } });
  const add = (title: string, status: string) =>
    r.request('/objects/task/records', { values: { title, status, company: acme.id } });
  await add('Book room', 'done');
  await add('Send deck', 'todo');
  const pack = await r.request(`/records/${acme.id}/context`);
  expect(
    pack.linkedRecords.map((group: { object: string; total: number }) => [
      group.object,
      group.total,
    ]),
  ).toEqual([
    ['task', 2],
    ['person', 1],
  ]);

  // Use smaller real pages to exercise the second request with a compact fixture.
  await page.route('**/v1/records/*/linked*', async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', '2');
    await route.continue({ url: url.toString() });
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${acme.id}?tab=linked`);
  const tasks = page.getByRole('list', { name: 'Tasks' });
  await expect(tasks.getByRole('listitem')).toHaveCount(2);
  await expect(tasks.getByRole('link', { name: 'Book room' })).toBeVisible();
  await expect(tasks.getByText('Done', { exact: true })).toBeVisible();
  await expect(tasks.getByText('Via Company on the linked record', { exact: true })).toHaveCount(2);
  await expect(tasks.getByText('company', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Linked/ })).toContainText('3');
  await expect(page.getByRole('list', { name: 'People' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(
    page.getByRole('list', { name: 'People' }).getByRole('link', { name: 'Dana' }),
  ).toBeVisible();
  await expect(tasks.getByRole('listitem')).toHaveCount(2);

  // An address saved when History was called Timeline still opens it.
  await page.goto(`${r.url}/app/r/${acme.id}?tab=timeline`);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('button', { name: 'History', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByText('Name set to')).toBeVisible();
});
