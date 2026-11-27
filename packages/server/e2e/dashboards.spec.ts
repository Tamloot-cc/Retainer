import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

const program = [
  'root = Dashboard("Company snapshot", [count, Metric("Deals tracked", pipeline.total), chart])',
  'companies = Query("aggregate_records", { object: "company" }, { total: 0 })',
  'pipeline = Query("aggregate_records", { object: "deal", groupBy: "stage" }, { total: 0, groups: [] })',
  'count = Metric("Companies tracked", companies.total)',
  'chart = BarChart("Pipeline by stage", pipeline.groups.label, pipeline.groups.total)',
].join('\n');

test.describe('saved dashboards', () => {
  test.use({ agentFixture: true, workspaceTemplate: 'sales' });

  test('streams, pins, refreshes and edits a shared dashboard in the viewer’s own chat', async ({
    page,
    browser,
    retainer,
  }) => {
    await retainer.request('/objects/company/records', { values: { name: 'Acme' } });
    await retainer.request('/objects/deal/records', {
      values: { name: 'First deal', stage: 'lead' },
    });
    retainer.anthropic?.enqueue({
      blocks: [
        { type: 'text', text: `Here’s your dashboard.\n\n\`\`\`openui-lang\n${program}\n\`\`\`` },
      ],
      stopReason: 'end_turn',
    });
    await signIn(page, retainer.url, retainer.keys.user);
    await page.getByRole('link', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Show a company dashboard.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Companies tracked' });
    await expect(preview.getByText('1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Pin to Dashboards' }).click();
    const saved = page.getByRole('link', { name: 'Saved' });
    await expect(saved).toBeVisible();
    const ownerChat = new URL(page.url()).pathname;
    await page.reload();
    await expect(saved).toBeVisible();
    await page.getByRole('link', { name: 'Dashboards', exact: true }).click();
    await page.getByRole('link', { name: /Company snapshot/ }).click();
    await expect(preview.getByText('1', { exact: true })).toBeVisible();
    const url = page.url();
    const callsBefore = retainer.anthropic?.requests.length;
    await retainer.request('/objects/company/records', { values: { name: 'Globex' } });
    await page.reload();
    await expect(preview.getByText('2', { exact: true })).toBeVisible();
    const chart = page.getByRole('region', { name: 'Pipeline by stage', exact: true }).first();
    await chart.getByText('View data table').click();
    await expect(chart.getByRole('cell', { name: 'Lead', exact: true })).toBeVisible();
    expect(retainer.anthropic?.requests.length).toBe(callsBefore);

    await page.getByRole('button', { name: 'Dashboard actions' }).click();
    await page.getByRole('menuitem', { name: 'Share with workspace' }).click();
    await expect(page.getByText(/Shared with workspace/)).toBeVisible();

    const second = await browser.newPage();
    try {
      await signIn(second, retainer.url, retainer.keys.writer);
      // Simulate a viewer whose access excludes the deal object. The company
      // query still reaches the real workspace and renders independently.
      await second.route('**/v1/objects/deal/aggregate', (route) =>
        route.fulfill({
          status: 403,
          json: { error: { code: 'forbidden', message: 'You can’t read deals' } },
        }),
      );
      await second.goto(url);
      await expect(
        second.getByRole('region', { name: 'Companies tracked' }).getByText('2', { exact: true }),
      ).toBeVisible();
      const denied = second.getByRole('region', { name: 'Deals tracked' });
      await denied.getByText('This part couldn’t load').click();
      await expect(denied.getByText('You can’t read deals')).toBeVisible();

      retainer.anthropic?.enqueue({
        blocks: [
          {
            type: 'text',
            text: 'I relabelled the metric.\n\n```openui-lang\ncount = Metric("Companies in CRM", companies.total)\n```',
          },
        ],
        stopReason: 'end_turn',
      });
      await second.getByRole('button', { name: 'Edit with the agent' }).click();
      const updatedMetric = second.getByRole('region', { name: 'Companies in CRM' });
      await expect(updatedMetric.getByText('2', { exact: true })).toBeVisible();
      expect(new URL(second.url()).pathname).not.toBe(ownerChat);
      const last = retainer.anthropic?.requests.at(-1)?.body as { messages?: unknown[] };
      expect(JSON.stringify(last.messages)).toContain('starting point');
      await second.getByRole('button', { name: 'Update “Company snapshot”' }).click();
      await expect(second.getByRole('link', { name: 'Saved' })).toBeVisible();
      await page.reload();
      await expect(
        page.getByRole('region', { name: 'Companies in CRM' }).getByText('2', { exact: true }),
      ).toBeVisible();
    } finally {
      await second.close();
    }
  });
});
