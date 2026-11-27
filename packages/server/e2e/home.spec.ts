import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ workspaceTemplate: 'sales' });

test('Home combines conversations and grouped record updates, preserves filters, and opens details', async ({
  page,
  retainer: r,
}) => {
  const acme = (
    await r.request(
      '/objects/company/records',
      { values: { name: 'Acme Labs', industry: 'Software' } },
      r.keys.user,
    )
  ).record;
  const sarah = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Sarah Cohen', jobTitle: 'VP of Operations', company: acme.id } },
      r.keys.user,
    )
  ).record;
  const deal = (
    await r.request(
      '/objects/deal/records',
      { values: { name: 'Acme · Annual plan', stage: 'qualified', company: acme.id } },
      r.keys.user,
    )
  ).record;
  const conversation = await r.request(
    '/events',
    {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: new Date().toISOString(),
      title: 'A next step with Acme',
      fields: { medium: 'call' },
      summary:
        'Sarah is ready to explore the annual plan. We discussed a rollout for the operations team, implementation timing, and the next steps for their pilot.',
      participants: [{ recordId: sarah.id }],
      about: [acme.id, deal.id],
    },
    r.keys.user,
  );
  await r.request(
    `/records/${deal.id}`,
    {
      values: {
        stage: 'negotiation',
        amount: { amountMicros: 24000000000, currency: 'USD' },
        closeDate: '2026-12-15',
      },
      source: conversation.id,
    },
    r.keys.user,
    'PATCH',
  );
  await r.request(`/records/${sarah.id}`, { values: { jobTitle: 'COO' } }, r.keys.agent, 'PATCH');
  await signIn(page, r.url, r.keys.user);
  await expect(page).toHaveURL(`${r.url}/app/`);
  await expect(page.getByRole('link', { name: '1 item needs your review' })).toBeVisible();
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(5);
  await expect(cards.first()).toContainText('Negotiation');
  await expect(cards.first()).toContainText('$24,000');
  await expect(cards.first().getByText('Close date recorded as')).toHaveCount(0);
  await cards.first().getByRole('button', { name: 'Show 1 more update' }).click();
  await expect(cards.first()).toContainText('Close date recorded as');
  await expect(cards.filter({ hasText: 'A next step with Acme' }).last()).toContainText(
    'Sarah Cohen',
  );
  if (process.env.RETAINER_CAPTURE_HOME)
    await page.screenshot({ path: '/tmp/retainer-home-desktop.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Record updates', exact: true }).click();
  await expect(cards).toHaveCount(4);
  await page.getByLabel('Search activity').fill('Acme');
  await expect(cards).toHaveCount(3);
  await page.reload();
  await expect(cards).toHaveCount(3);
  await page.getByLabel('Search activity').fill('');
  await page.getByRole('button', { name: 'Conversations & notes', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await cards.getByRole('button', { name: 'A next step with Acme' }).click();
  await expect(page.getByRole('dialog', { name: 'A next step with Acme' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Everything', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass('dark');
  if (process.env.RETAINER_CAPTURE_HOME)
    await page.screenshot({ path: '/tmp/retainer-home-dark.png', animations: 'disabled' });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass('dark');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  const categories = page.getByRole('navigation', { name: 'Sections' });
  await categories.scrollIntoViewIfNeeded();
  expect(await categories.evaluate((el) => el.scrollWidth)).toBe(
    await categories.evaluate((el) => el.clientWidth),
  );
  await expect(categories.getByRole('button', { name: 'Record updates' })).toBeInViewport();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(
    true,
  );
  if (process.env.RETAINER_CAPTURE_HOME)
    await page.screenshot({ path: '/tmp/retainer-home-mobile.png', animations: 'disabled' });
});

test('a person can cancel or revert an Updated card from Home', async ({ page, retainer: r }) => {
  const { record } = await r.request('/objects/person/records', {
    values: { name: 'Dana Cohen', jobTitle: 'Founder' },
  });
  await r.request(`/records/${record.id}`, { values: { jobTitle: 'CEO' } }, r.keys.user, 'PATCH');
  await signIn(page, r.url, r.keys.user);

  const cards = page.getByRole('article');
  const updated = cards.filter({ hasText: 'Person · Updated' });
  const added = cards.filter({ hasText: 'Person · Added' });
  const trigger = updated.getByRole('button', { name: 'Revert update' });
  await expect(added).toContainText('CEO');
  await expect(added.getByRole('button', { name: 'Revert update' })).toHaveCount(0);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Revert this update?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(trigger).toBeFocused();
  await expect(added).toContainText('CEO');

  await trigger.click();
  await dialog.getByRole('button', { name: 'Revert update' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Update reverted.')).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Update reverted.' }).locator('..'),
  ).toBeFocused();
  await expect(updated).toHaveCount(0);
  await expect(added).toContainText('Founder');
  await page.reload();
  await expect(added).toContainText('Founder');
  await expect(updated).toHaveCount(0);
});

test('the Home feed and sidebar scroll independently of the document', async ({
  page,
  retainer: r,
}) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  const { record } = await r.request('/objects/company/records', { values: { name: 'Acme' } });
  for (let i = 0; i < 4; i++) {
    await r.request('/events', {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: new Date().toISOString(),
      title: `Call ${i + 1}`,
      about: [record.id],
    });
  }
  await signIn(page, r.url, r.keys.user);
  const firstCall = page.getByRole('button', { name: 'Call 4', exact: true });
  await expect(firstCall).toBeInViewport();

  // Linked-record labels below the fold must stay inside the feed's scroll area.
  const documentRoot = page.locator('html');
  expect(await documentRoot.evaluate((el) => el.scrollHeight)).toBe(400);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const divider = page.getByRole('separator', { name: 'Resize sidebar' });
  const navRight = await nav.evaluate((el) => el.getBoundingClientRect().right);
  const dividerLeft = await divider.evaluate((el) => el.getBoundingClientRect().left);
  expect(navRight).toBeLessThanOrEqual(dividerLeft);
  await nav.hover();
  await page.mouse.wheel(0, 1200);
  await expect.poll(() => nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(firstCall).toBeInViewport();
  expect(await documentRoot.evaluate((el) => el.scrollTop)).toBe(0);

  await firstCall.hover();
  await page.mouse.wheel(0, 1200);
  await expect(firstCall).not.toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeInViewport();
  expect(await documentRoot.evaluate((el) => el.scrollTop)).toBe(0);
});

test('the desktop sidebar remembers its dragged width across collapse and reload', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  const sidebar = page.getByRole('complementary');
  const handle = sidebar.getByRole('separator', { name: 'Resize sidebar' });
  await expect(sidebar).toHaveCSS('width', '240px');
  const box = await handle.boundingBox();
  if (!box) throw new Error('Sidebar resize handle is missing');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 96, y, { steps: 4 });
  await expect(sidebar).toHaveCSS('width', '336px');
  await page.mouse.up();
  await sidebar.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar).toHaveCSS('width', '52px');
  await sidebar.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect(sidebar).toHaveCSS('width', '336px');
  await page.reload();
  await expect(sidebar).toHaveCSS('width', '336px');
  await expect(sidebar).toHaveCSS('transition-property', 'width');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(sidebar).toHaveCSS('transition-property', 'none');
  await handle.press('ArrowLeft');
  await expect(sidebar).toHaveCSS('width', '320px');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer).toHaveCSS('width', '256px');
  await expect(drawer.getByRole('separator', { name: 'Resize sidebar' })).toHaveCount(0);
});

test.describe('touch navigation', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 320, height: 568 } });

  test('closes the drawer, restores focus, and keeps navigation usable across the breakpoint', async ({
    page,
    retainer: r,
  }) => {
    await signIn(page, r.url, r.keys.user);
    const opener = page.getByRole('button', { name: 'Open navigation' });
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    const close = drawer.getByRole('button', { name: 'Close navigation' });
    await expect(opener).toHaveAttribute('aria-expanded', 'false');
    await expect(opener).toHaveCSS('width', '44px');
    await opener.tap();
    await expect(close).toBeFocused();
    await expect(close).toHaveCSS('height', '44px');
    await expect(drawer.getByRole('link', { name: 'People' })).toHaveCSS('height', '44px');
    await expect(page.getByRole('main')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();

    await opener.tap();
    await close.tap();
    await expect(opener).toHaveAttribute('aria-expanded', 'false');
    await expect(opener).toBeFocused();

    await opener.tap();
    await page.touchscreen.tap(300, 150);
    await expect(opener).toBeFocused();

    await opener.tap();
    await page.setViewportSize({ width: 800, height: 600 });
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();

    await page.setViewportSize({ width: 667, height: 375 });
    await opener.tap();
    const schema = drawer.getByRole('link', { name: 'Schema' });
    await schema.scrollIntoViewIfNeeded();
    await expect(schema).toBeInViewport();
    await expect(drawer.getByRole('button', { name: /^Account:/ })).toBeInViewport();
    await drawer.getByRole('button', { name: 'Find anything' }).tap();
    const command = page.getByRole('dialog', { name: 'Search and commands' });
    await expect(command.getByRole('combobox')).toBeFocused();
    await expect(command.getByRole('button', { name: 'Close search' })).toHaveCSS('height', '44px');
    await page.keyboard.press('Escape');

    await opener.tap();
    await drawer.getByRole('link', { name: 'People' }).tap();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'People', exact: true })).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  });
});

test('an empty workspace welcomes people, and old activity and review links still work', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await expect(page.getByText('Your workspace story starts here')).toBeVisible();
  await page.goto(`${r.url}/app/activity?tab=events&channel=zoom`);
  await expect(page).toHaveURL(/\/app\/\?tab=events&channel=zoom/);
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await page.goto(`${r.url}/app/?tab=schema`);
  await expect(page).toHaveURL(/\/app\/review\?tab=schema/);
  await expect(page.getByRole('heading', { name: 'Review inbox' })).toBeVisible();
});

test('new activity waits for the person to refresh the feed', async ({ page, retainer: r }) => {
  await page.clock.install();
  await signIn(page, r.url, r.keys.user);
  await expect(page.getByText('Your workspace story starts here')).toBeVisible();
  await r.request('/events', {
    type: 'conversation',
    channel: 'gmail',
    occurredAt: new Date().toISOString(),
    title: 'Just arrived',
  });
  await page.clock.fastForward(31_000);
  await expect(page.getByRole('button', { name: 'Show new updates' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show new updates' }).click();
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Just arrived' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show new updates' })).toHaveCount(0);
});
