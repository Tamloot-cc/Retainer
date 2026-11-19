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
  await expect(
    page.getByText('Conversation · Meeting · Source: calendar', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Activity · Conversation')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Acme Pilot Co' })).toBeVisible();
});

test('draws the objects and relations and opens them from the diagram', async ({
  page,
  retainer: r,
}) => {
  await r.request('/templates/sales/apply', {});
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await page.goto(`${r.url}/app/schema?tab=diagram`);
  const diagram = page.getByRole('figure', { name: 'Objects and their relations' });
  await expect(page.getByText(/^5 relations\./)).toBeVisible();
  // Cards list the label field and the relations, not every field.
  const deals = diagram.locator('.react-flow__node[data-id="deal"]');
  await expect(deals.getByRole('button', { name: /^Point of contact/ })).toBeVisible();
  await expect(deals.getByText('Amount')).toHaveCount(0);
  // A relation row opens its field in the Objects tab.
  await deals.getByRole('button', { name: /^Point of contact/ }).click();
  await expect(page.getByRole('heading', { name: 'Deals', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Point of contact' })).toBeVisible();
  await expect(page).toHaveURL(/object=deal&field=pointOfContact/);
  // A card's header opens the object.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  await diagram.locator('.react-flow__node[data-id="company"]').getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
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
      const intro = page.getByText('Templates and schema basics', { exact: true });
      const templates = page.getByRole('heading', { name: 'Start from a template' });
      await expect(templates).toBeHidden();
      await intro.tap();
      await expect(templates).toBeVisible();
      await intro.tap();
      await expect(templates).toBeHidden();
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
