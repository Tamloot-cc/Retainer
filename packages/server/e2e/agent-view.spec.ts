import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('agent view shows descriptions, the agent context and what agents are told', async ({
  page,
  retainer: r,
}) => {
  await r.request('/schema/changes', {
    operations: [
      {
        op: 'create_field',
        object: 'company',
        field: {
          name: 'segment',
          label: 'Segment',
          type: 'text',
          description: 'Which market the company sells into, in two or three words.',
        },
      },
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'hunch', label: 'Hunch', type: 'text' },
      },
    ],
  });
  const acme = (
    await r.request('/objects/company/records', {
      values: { name: 'Acme', segment: 'Mid-market SaaS' },
    })
  ).record;
  await r.request(`/records/${acme.id}/facts`, { text: 'Prefers annual billing.' });
  // Long summaries, so the default budget cannot hold every event.
  for (let i = 1; i <= 8; i++) {
    await r.request('/events', {
      type: 'conversation',
      channel: 'zoom',
      externalId: `agent-view-${i}`,
      occurredAt: `2026-10-${String(10 + i).padStart(2, '0')}T10:00:00Z`,
      title: `Weekly sync ${i}`,
      summary: `Sync ${i}. ${'We went through the rollout plan and open questions. '.repeat(30)}`,
      about: [acme.id],
    });
  }

  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${acme.id}`);
  const description = 'Which market the company sells into, in two or three words.';
  await expect(page.getByText('Record · Company')).toBeVisible();
  await expect(page.getByText(description)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agent context' })).toHaveCount(0);

  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitemradio', { name: 'Agent' }).click();
  // Agent includes everything in Developer.
  await expect(page.getByText('upsert_record', { exact: true })).toBeVisible();
  await expect(page.getByText(description)).toBeVisible();

  await page.getByRole('button', { name: 'Agent context', exact: true }).click();
  await expect(page).toHaveURL(/tab=context/);
  await expect(page.getByText('What an agent gets when it reads this record')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Facts in the pack' }).getByText('Prefers annual billing.'),
  ).toBeVisible();
  await expect(page.getByText(/^\d+ events? did not fit\.$/)).toBeVisible();
  await expect(page.getByText(/Left out: \d+ events?/)).toBeVisible();
  // A larger budget fits them all.
  await page.getByRole('button', { name: '16,000' }).click();
  await expect(page.getByText(/did not fit/)).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Events in the pack' }).getByRole('listitem'),
  ).toHaveCount(8);

  // The briefing page, linked from the sidebar at this level.
  await page.getByRole('link', { name: 'Agent briefing' }).click();
  await expect(page.getByRole('heading', { name: 'Connection instructions' })).toBeVisible();
  await expect(page.getByText(/Retainer is the memory of a CRM workspace/)).toBeVisible();
  const missing = page.getByRole('list', { name: 'Missing descriptions' });
  await expect(missing.getByText('hunch', { exact: true })).toBeVisible();
  await expect(missing.getByText('segment', { exact: true })).toHaveCount(0);
  await expect(page.getByText('get_context', { exact: true }).first()).toBeVisible();

  // Back to Standard: the tab and the link go away, and the address falls back.
  await page.goto(`${r.url}/app/r/${acme.id}?tab=context`);
  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitemradio', { name: 'Standard' }).click();
  await expect(page.getByRole('button', { name: 'Agent context' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Agent briefing' })).toHaveCount(0);
  await expect(page.getByText(description)).toHaveCount(0);
});
