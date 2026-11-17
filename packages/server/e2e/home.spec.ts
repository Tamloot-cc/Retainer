import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('Home combines conversations and grouped record updates, preserves filters, and opens details', async ({
  page,
  retainer: r,
}) => {
  await r.request('/templates/sales/apply', {});
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
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass('dark');
  await page.mouse.move(0, 0);
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(
    true,
  );
  if (process.env.RETAINER_CAPTURE_HOME)
    await page.screenshot({ path: '/tmp/retainer-home-mobile.png', animations: 'disabled' });
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
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(400);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.hover();
  await page.mouse.wheel(0, 1200);
  await expect.poll(() => nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(firstCall).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await firstCall.hover();
  await page.mouse.wheel(0, 1200);
  await expect(firstCall).not.toBeInViewport();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
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
