import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('explains all four review categories and keeps their cards and actions usable on a phone', async ({
  page,
  retainer: r,
}) => {
  const record = (
    await r.request(
      '/objects/person/records',
      {
        values: {
          name: 'Sarah Cohen',
          jobTitle: 'Chief operating officer for international customer operations',
        },
      },
      r.keys.user,
    )
  ).record;
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'Vice president of strategy and business development for Acme Labs' } },
    r.keys.agent,
    'PATCH',
  );
  await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
  });
  for (const name of ['Yael Mizrahi', 'Yael Mizrachi'])
    await r.request('/objects/person/records', { values: { name } });
  await r.consolidate();
  const removed = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Former contact', emails: 'former@acme.test' } },
      r.keys.user,
    )
  ).record;
  await r.request(`/records/${removed.id}`, undefined, r.keys.user, 'DELETE');
  await r.request('/events', {
    type: 'conversation',
    channel: 'gmail',
    title: 'Conversation needing a contact',
    occurredAt: new Date().toISOString(),
    participants: [{ handle: 'former@acme.test' }],
  });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await expect(page.getByRole('link', { name: 'Review inbox' })).toContainText('4');
  const categories = page.getByRole('navigation', { name: 'Review categories' });
  for (const label of [
    'Proposed updates',
    'Structure changes',
    'Possible duplicates',
    'Participant issues',
  ])
    await expect(categories.getByRole('button', { name: `${label} (1)` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keep the details right.' })).toBeInViewport();
  await expect(page.getByText('Current value', { exact: true })).toBeVisible();
  await expect(page.getByText('Proposed value', { exact: true })).toBeVisible();
  if (process.env.RETAINER_CAPTURE_REVIEW)
    await page.screenshot({ path: '/tmp/retainer-review-desktop.png', animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass('dark');
  if (process.env.RETAINER_CAPTURE_REVIEW)
    await page.screenshot({ path: '/tmp/retainer-review-dark.png', animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass('dark');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('Keyboard:', { exact: false })).not.toBeVisible();
  const current = await page.getByText('Current value', { exact: true }).boundingBox();
  const proposed = await page.getByText('Proposed value', { exact: true }).boundingBox();
  expect(current && proposed && proposed.y > current.y).toBe(true);
  if (process.env.RETAINER_CAPTURE_REVIEW)
    await page.screenshot({ path: '/tmp/retainer-review-mobile.png', animations: 'disabled' });
  for (const label of [
    'Proposed updates',
    'Structure changes',
    'Possible duplicates',
    'Participant issues',
  ]) {
    await categories.getByRole('button', { name: `${label} (1)` }).click();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(
      true,
    );
  }
  await expect(
    page.getByText('We couldn’t link this participant to an active record.'),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Open activity: Conversation needing a contact/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await categories.getByRole('button', { name: 'Proposed updates (1)' }).click();
  const accept = page.getByRole('button', { name: 'Accept', exact: true });
  const bounds = await accept.boundingBox();
  expect(bounds?.height).toBeGreaterThanOrEqual(44);
  await accept.click();
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await expect(categories.getByRole('button', { name: 'Proposed updates (0)' })).toBeVisible();
  await page.reload();
  await expect(categories.getByRole('button', { name: 'Proposed updates (0)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('read-only review and long values fit even a narrow phone', async ({ page, retainer: r }) => {
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'A'.repeat(120), jobTitle: 'B'.repeat(160) } },
      r.keys.user,
    )
  ).record;
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'C'.repeat(160) } },
    r.keys.agent,
    'PATCH',
  );
  await page.setViewportSize({ width: 320, height: 740 });
  await signIn(page, r.url, r.keys.reader);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Review inbox' }).click();
  await expect(page.getByText(/Someone with write access can act on them/)).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(0);
  await expect(page.getByText('C'.repeat(160), { exact: true })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(
    true,
  );
  const overflow = await page
    .locator('[data-review-card]')
    .evaluateAll((cards) => cards.some((card) => card.scrollWidth > card.clientWidth));
  expect(overflow).toBe(false);
});

test('starts on the first category with items, preserves yellow merge reasons, and respects chosen categories', async ({
  page,
  retainer: r,
}) => {
  for (const name of ['Fijoya', 'Wiz'])
    await r.request('/objects/company/records', { values: { name, domain: 'wiz.io' } });
  await r.consolidate();
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  const categories = page.getByRole('navigation', { name: 'Review categories' });
  await expect(categories.getByRole('button', { name: 'Possible duplicates (1)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page).toHaveURL(/tab=mergeSuggestions/);
  await expect(page.getByText('shared domain', { exact: true })).toBeVisible();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass('dark');
  if (process.env.RETAINER_CAPTURE_REVIEW)
    await page.screenshot({ path: '/tmp/retainer-review-merge-dark.png', animations: 'disabled' });
  // An explicitly chosen empty category stays selected, including after reload.
  await categories.getByRole('button', { name: 'Proposed updates (0)' }).click();
  await page.reload();
  await expect(categories.getByRole('button', { name: 'Proposed updates (0)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText("You're all caught up")).toBeVisible();
  // An earlier category with items takes priority on the next fresh inbox visit.
  await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
  });
  await page.goto(`${r.url}/app/review`);
  await expect(categories.getByRole('button', { name: 'Structure changes (1)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await categories.getByRole('button', { name: 'Possible duplicates (1)' }).click();
  await page.getByRole('button', { name: 'Compare and merge', exact: false }).click();
  await page.getByRole('button', { name: 'Not duplicates' }).click();
  await expect(categories.getByRole('button', { name: 'Possible duplicates (0)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByText('No possible duplicates')).toBeVisible();
});

test('an assertion link stays on its proposal and an empty inbox has a stable default', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Review inbox' }).click();
  const categories = page.getByRole('navigation', { name: 'Review categories' });
  await expect(page).toHaveURL(/tab=pendingAssertions/);
  await expect(categories.getByRole('button', { name: 'Proposed updates (0)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const record = (
    await r.request(
      '/objects/person/records',
      { values: { name: 'Dana', jobTitle: 'CTO' } },
      r.keys.user,
    )
  ).record;
  await r.request(`/records/${record.id}`, { values: { jobTitle: 'CEO' } }, r.keys.agent, 'PATCH');
  const queue = await r.request('/review');
  const assertion = queue.pendingAssertions.find(
    (item: { recordId: string }) => item.recordId === record.id,
  );
  await r.request('/schema/changes', {
    operations: [{ op: 'update_field', object: 'person', field: 'jobTitle', isUnique: true }],
  });
  await page.goto(`${r.url}/app/review?assertion=${assertion.id}`);
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText("You're all caught up")).toBeVisible();
  await expect(categories.getByRole('button', { name: 'Proposed updates (0)' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(categories.getByRole('button', { name: 'Structure changes (1)' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`assertion=${assertion.id}`));
});
