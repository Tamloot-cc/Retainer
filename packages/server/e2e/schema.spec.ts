import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('approves a schema proposal and refreshes the schema', async ({ page, retainer: r }) => {
  await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
  });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await page.getByRole('button', { name: /Structure changes/ }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('No structure changes to review')).toBeVisible();
  await page.getByRole('link', { name: 'Schema', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Schema', exact: true })).toBeVisible();
  // Pick an object, filter its fields and open one in the side sheet.
  await page
    .getByRole('navigation', { name: 'Records' })
    .getByRole('button', { name: /^People/ })
    .click();
  await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Filter fields' }).fill('job');
  await page.getByRole('button', { name: 'Job title', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Job title' });
  await expect(sheet.getByText('No two records can share a value')).toBeVisible();
  await expect(page).toHaveURL(/object=person&field=jobTitle/);
  // A relation links to the field on its other side.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Job title', exact: true })).toBeFocused();
  await page.getByRole('searchbox', { name: 'Filter fields' }).fill('company');
  await page.getByRole('button', { name: 'Company', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Company' })
    .getByRole('button', { name: 'Company → People' })
    .click();
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'People' })).toBeVisible();
  // The approved change is in the history, in words.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Change history/ }).click();
  const history = page.getByRole('list', { name: 'Schema changes' });
  await expect(history.getByText('Change Job title on Person')).toBeVisible();
  await page.getByRole('button', { name: 'Status All statuses' }).click();
  await page.getByRole('option', { name: 'Rejected' }).click();
  await expect(page.getByText('No rejected changes')).toBeVisible();
  const schema = await r.request('/schema');
  expect(
    schema.objects
      .find((o: any) => o.nameSingular === 'person')
      .fields.find((f: any) => f.name === 'jobTitle').isUnique,
  ).toBe(true);
});

test('shows why a schema approval failed, with the records in the way', async ({
  page,
  retainer: r,
}) => {
  await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
  });
  // Two records now share the value the change would make unique.
  for (const name of ['Twin One', 'Twin Two']) {
    await r.request('/objects/person/records', { values: { name, jobTitle: 'CTO' } });
  }
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await page.getByRole('button', { name: /Structure changes/ }).click();
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(/^The structure change could not be applied: .+/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Twin One' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Twin Two' })).toBeVisible();
});

test('lists facts as a built-in and event types beside objects, and shows what an event is about', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme Pilot Co' } }))
    .record;
  const meeting = await r.request('/events', {
    type: 'conversation',
    channel: 'calendar',
    fields: { medium: 'meeting' },
    occurredAt: '2026-10-29T12:00:00Z',
    title: 'Pilot review',
    about: [acme.id],
  });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await page.goto(`${r.url}/app/schema`);
  await page
    .getByRole('navigation', { name: 'Built-in' })
    .getByRole('button', { name: /^Facts/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Facts', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/object=fact/);
  // Records and events are explained above the lists, with how each is written.
  await expect(page.getByText('upsert_record', { exact: true })).toBeVisible();
  await expect(page.getByText('log_event', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Activity' })
    .getByRole('button', { name: /^Conversations/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
  await expect(page.getByText('occurredAt', { exact: true })).toBeVisible();
  await page.goto(`${r.url}/app/e/${meeting.id}`);
  await expect(page.getByRole('heading', { name: 'Pilot review' })).toBeVisible();
  await expect(page.getByText('Conversation · Source: calendar', { exact: false })).toBeVisible();
  await expect(page.getByText('Activity · Conversation')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Acme Pilot Co' })).toBeVisible();
});

test.describe('Sales workspace', () => {
  test.use({ workspaceTemplate: 'sales' });

  test('finds objects by keyboard and follows relationships in the diagram', async ({
    page,
    retainer: r,
  }) => {
    await signIn(page, r.url, r.keys.user);
    await page.goto(`${r.url}/app/schema?tab=diagram`);
    const diagram = page.getByRole('figure', { name: 'Objects and their relations' });
    const deals = diagram.locator('.react-flow__node[data-id="deal"]');
    await expect(diagram.getByText('5 relations', { exact: true })).toBeVisible();
    await expect(deals.getByText('Amount', { exact: true })).toHaveCount(0);

    await diagram.getByRole('button', { name: 'Find object…' }).press('Enter');
    const search = diagram.getByRole('combobox', { name: 'Find object' });
    await expect(search).toBeFocused();
    await search.fill('deal');
    await search.press('Enter');

    const inspector = diagram.getByRole('complementary');
    await expect(inspector.getByRole('heading', { name: 'Deals', exact: true })).toBeFocused();
    await expect(deals.getByRole('button', { name: /^Deals/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(diagram.locator('.react-flow__edge[data-id="deal.pointOfContact"]')).toBeVisible();
    await inspector.getByRole('button', { name: 'Focus on related objects' }).click();
    await expect(
      inspector.getByRole('button', { name: 'Focus on related objects' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(diagram.locator('.react-flow__node[data-id="conversation"]')).toHaveCount(0);

    await inspector.getByRole('button', { name: 'Inspect Point of contact' }).click();
    await expect(
      inspector.getByRole('heading', { name: 'Point of contact', exact: true }),
    ).toBeFocused();
    await expect(inspector.getByText(/Each deal has one person/).first()).toBeVisible();
    await inspector.getByRole('button', { name: 'Go to People' }).click();
    await expect(inspector.getByRole('heading', { name: 'People', exact: true })).toBeFocused();
    await expect(page).toHaveURL(/tab=diagram/);

    await inspector.getByRole('button', { name: 'Open in Objects' }).click();
    await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/object=person/);
  });

  test('restores the canvas after full screen and resets dragged cards', async ({
    page,
    retainer: r,
  }) => {
    await signIn(page, r.url, r.keys.user);
    await page.goto(`${r.url}/app/schema?tab=diagram`);
    const diagram = page.getByRole('figure', { name: 'Objects and their relations' });
    const conversation = diagram.locator('.react-flow__node[data-id="conversation"]');
    await expect(conversation).toBeVisible();
    await diagram.getByRole('checkbox', { name: 'Show event types' }).uncheck();
    await expect(conversation).toHaveCount(0);
    await expect(diagram.locator('.react-flow__node[data-id="__any_record"]')).toHaveCount(0);
    await diagram.getByRole('checkbox', { name: 'Show event types' }).check();
    await expect(conversation).toBeVisible();

    await diagram.getByRole('button', { name: /fit view/i }).click();
    const deals = diagram.locator('.react-flow__node[data-id="deal"]');
    const relationRow = deals.getByRole('button', { name: /^Point of contact/ });
    await expect(relationRow).toBeVisible();
    for (let i = 0; i < 4; i++) await diagram.getByRole('button', { name: /zoom out/i }).click();
    await expect(relationRow).toHaveCount(0);
    await expect(deals.getByRole('button', { name: /^Deals/ })).toBeVisible();
    await diagram.getByRole('button', { name: /fit view/i }).click();
    await expect(relationRow).toBeVisible();
    const position = await deals.evaluate((node) => node.style.transform);
    const card = await deals.getByRole('button', { name: /^Deals/ }).boundingBox();
    if (!card) throw new Error('Expected the Deals card to be visible');
    await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2);
    await page.mouse.down();
    await page.mouse.move(card.x + card.width / 2 + 48, card.y + card.height / 2 + 30, {
      steps: 5,
    });
    await page.mouse.up();
    await expect.poll(() => deals.evaluate((node) => node.style.transform)).not.toBe(position);
    await diagram.getByRole('button', { name: 'Reset layout' }).click();
    await expect.poll(() => deals.evaluate((node) => node.style.transform)).toBe(position);

    await deals.getByRole('button', { name: /^Deals/ }).click();
    const inspector = diagram.getByRole('complementary');
    await expect(inspector.getByRole('heading', { name: 'Deals', exact: true })).toBeFocused();
    const viewport = diagram.locator('.react-flow__viewport');
    const original = await viewport.evaluate((pane) => pane.style.transform);
    await diagram.getByRole('button', { name: 'Full screen', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Schema diagram full screen' });
    await expect(modal).toBeVisible();
    await expect(
      modal.getByRole('complementary').getByRole('heading', { name: 'Deals' }),
    ).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Exit full screen' })).toBeFocused();
    expect(await modal.evaluate((el) => el.clientHeight)).toBe(page.viewportSize()?.height);

    await modal.getByRole('button', { name: 'Find object…' }).click();
    const search = modal.getByRole('combobox', { name: 'Find object' });
    await search.press('Escape');
    await expect(search).toHaveCount(0);
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: 'Find object…' }).click();
    await search.fill('Companies');
    await search.press('Enter');
    await expect(
      modal.getByRole('complementary').getByRole('heading', { name: 'Companies' }),
    ).toBeFocused();
    await modal.getByRole('button', { name: /zoom out/i }).click();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(diagram.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();
    await expect(inspector.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
    await expect.poll(() => viewport.evaluate((pane) => pane.style.transform)).toBe(original);
  });
});

test.describe('Schema on touch screens', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 568 } });

  test('keeps objects, diagram controls and change history reachable', async ({
    page,
    retainer: r,
  }) => {
    const reason = 'migration_reference_'.repeat(15);
    await r.request('/schema/changes', {
      reason,
      operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
    });
    await signIn(page, r.url, r.keys.user);
    const tabs = page.getByRole('navigation', { name: 'Sections' });
    const people = page
      .getByRole('navigation', { name: 'Records', exact: true })
      .getByRole('button', { name: /^People/ });
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 667, height: 375 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`${r.url}/app/schema`);
      await expect(people).toBeInViewport();
      const intro = page.getByText('How records and activity work', { exact: true });
      const templates = page.getByRole('heading', { name: 'Start from a template' });
      await expect(templates).toHaveCount(0);
      await intro.tap();
      await expect(intro.locator('..')).toHaveAttribute('open', '');
      await intro.tap();
      await expect(intro.locator('..')).not.toHaveAttribute('open', '');
      expect(await tabs.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await people.tap();
      const heading = page.getByRole('heading', { name: 'People', exact: true });
      await expect(heading).toBeVisible();
      if (viewport.width === 320) {
        const title = await heading.boundingBox();
        const browse = await page.getByRole('link', { name: 'Browse records' }).boundingBox();
        expect(title && browse && browse.y >= title.y + title.height).toBe(true);
      }
      const filter = page.getByRole('searchbox', { name: 'Filter fields' });
      await expect(filter).toHaveCSS('height', '44px');
      await filter.fill('job');
      const field = page.getByRole('button', { name: 'Job title', exact: true });
      await field.tap();
      const sheet = page.getByRole('dialog', { name: 'Job title' });
      await sheet.getByRole('button', { name: 'Close', exact: true }).tap();
      await expect(field).toBeFocused();

      await tabs.getByRole('button', { name: 'Diagram', exact: true }).tap();
      const diagram = page.getByRole('figure', { name: 'Objects and their relations' });
      const zoom = diagram.getByRole('button', { name: /zoom in/i });
      await expect(zoom).toHaveCSS('width', '44px');
      await zoom.tap();
      await diagram.getByRole('button', { name: /fit view/i }).tap();
      await diagram.getByRole('button', { name: 'Full screen', exact: true }).tap();
      const modal = page.getByRole('dialog', { name: 'Schema diagram full screen' });
      await modal.getByRole('button', { name: 'Find object…' }).tap();
      await modal.getByRole('combobox', { name: 'Find object' }).fill('People');
      await modal.getByRole('option', { name: /People/ }).tap();
      const inspector = modal.getByRole('complementary');
      await expect(
        inspector.getByRole('heading', { name: 'People', exact: true }),
      ).toBeInViewport();
      await expect(modal.getByRole('button', { name: /zoom in/i })).toBeInViewport();
      await modal.getByRole('button', { name: 'Exit full screen' }).tap();
      await expect(modal).toBeHidden();
      await expect(diagram.getByRole('button', { name: 'Full screen', exact: true })).toBeFocused();

      await tabs.getByRole('button', { name: /^Change history/ }).tap();
      const status = page.getByRole('button', { name: 'Status All statuses' });
      await expect(status).toHaveCSS('height', '44px');
      await status.tap();
      await page.getByRole('option', { name: 'Proposed', exact: true }).tap();
      const history = page.getByRole('list', { name: 'Schema changes' });
      await expect(history.getByText(reason, { exact: false })).toBeVisible();
      expect(await history.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    }
  });
});
