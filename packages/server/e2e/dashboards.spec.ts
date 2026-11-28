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

  test('hides a metric default while loading and displays a successful zero', async ({
    page,
    retainer,
  }) => {
    const key = retainer.keys.user;
    const dashboard = await retainer.request(
      '/dashboards',
      {
        name: 'Company count',
        program: [
          'root = Dashboard("Company count", [Metric("Companies tracked", companies.total)])',
          'companies = Query("aggregate_records", {object: "company"}, {total: 0})',
        ].join('\n'),
      },
      key,
    );
    await signIn(page, retainer.url, key);
    let release: () => void = () => {};
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/v1/objects/company/aggregate', async (route) => {
      await delayed;
      await route.continue();
    });
    try {
      await page.getByRole('link', { name: 'Dashboards', exact: true }).click();
      await page.getByRole('link', { name: /Company count/ }).click();
      const metric = page.getByRole('region', { name: 'Companies tracked' });
      await expect(metric.getByRole('progressbar', { name: 'Loading data' })).toBeVisible();
      await expect(metric.getByText('0', { exact: true })).toHaveCount(0);
      release();
      await expect(metric.getByText('0', { exact: true })).toBeVisible();
      await expect(metric.getByRole('progressbar')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboard.id}$`));
    } finally {
      release();
    }
  });

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
      await expect(denied.getByText('0', { exact: true })).toHaveCount(0);

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
  test('edits the selected dashboard when several were saved from the same chat', async ({
    page,
    retainer,
  }) => {
    const key = retainer.keys.user;
    const chat = await retainer.request('/agent/chats', { client: 'web' }, key);
    const selected = await retainer.request(
      '/dashboards',
      {
        name: 'Company snapshot',
        program,
        chatId: chat.id,
      },
      key,
    );
    const otherProgram = program.replace('Company snapshot', 'Latest snapshot');
    const latest = await retainer.request(
      '/dashboards',
      {
        name: 'Latest snapshot',
        program: otherProgram,
        chatId: chat.id,
      },
      key,
    );
    retainer.anthropic?.enqueue({
      blocks: [
        {
          type: 'text',
          text: '```openui-lang\ncount = Metric("Companies in CRM", companies.total)\n```',
        },
      ],
      stopReason: 'end_turn',
    });
    await signIn(page, retainer.url, key);
    await page.goto(`${retainer.url}/app/dashboards/${selected.id}`);
    await page.getByRole('button', { name: 'Edit with the agent' }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${chat.id}\\?`));
    await page.getByRole('button', { name: 'Update “Company snapshot”' }).click();
    await expect(page.getByRole('link', { name: 'Saved' })).toHaveAttribute(
      'href',
      `/app/dashboards/${selected.id}`,
    );
    const changed = await retainer.request(`/dashboards/${selected.id}`, undefined, key);
    const untouched = await retainer.request(`/dashboards/${latest.id}`, undefined, key);
    expect(changed.program).toContain('Companies in CRM');
    expect(untouched.updatedAt).toBe(latest.updatedAt);
  });
  test('continues an existing dashboard chat after its queried object is renamed', async ({
    page,
    retainer,
  }) => {
    const key = retainer.keys.user;
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: `\`\`\`openui-lang\n${program}\n\`\`\`` }],
      stopReason: 'end_turn',
    });
    await signIn(page, retainer.url, key);
    await page.getByRole('link', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Show a company dashboard.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Pin to Dashboards' }).click();
    const saved = page.getByRole('link', { name: 'Saved' });
    await expect(saved).toBeVisible();
    const chat = new URL(page.url()).pathname;
    await retainer.request(
      '/schema/changes',
      {
        operations: [
          { op: 'rename_object', object: 'company', nameSingular: 'client', namePlural: 'clients' },
        ],
      },
      key,
    );
    await saved.click();
    retainer.anthropic?.enqueue({
      blocks: [
        {
          type: 'text',
          text: '```openui-lang\ncount = Metric("Clients tracked", companies.total)\n```',
        },
      ],
      stopReason: 'end_turn',
    });
    await page.getByRole('button', { name: 'Edit with the agent' }).click();
    await expect(page.getByRole('region', { name: 'Clients tracked' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(chat);
    const id = chat.split('/').at(-1);
    await expect
      .poll(async () => (await retainer.request(`/agent/chats/${id}`, undefined, key)).running)
      .toBe(false);
    // The former schema name appears only in the historical draft.
    // Loading the chat again must read the live dashboard, never the old one.
    const queriedObjects: string[] = [];
    page.on('request', (request) => {
      const object = new URL(request.url()).pathname.match(
        /\/v1\/objects\/([^/]+)\/aggregate$/,
      )?.[1];
      if (object) queriedObjects.push(object);
    });
    const liveRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/objects/client/aggregate' && response.ok(),
    );
    await page.reload();
    await liveRead;
    await expect(page.getByText('Previous draft. Live data is paused.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Companies tracked' })).toBeVisible();
    expect(queriedObjects).not.toContain('company');
    const updates = page.getByRole('button', { name: 'Update “Company snapshot”' });
    // The preview streams before its save actions appear.
    await expect(updates).toHaveCount(2);
    await updates.last().click();
    const lastSaved = page.getByRole('link', { name: 'Saved' }).last();
    await expect(lastSaved).toBeVisible();
    await lastSaved.click();
    await expect(page.getByRole('region', { name: 'Clients tracked' })).toBeVisible();
  });

  test('New dashboard opens the chat’s starter and sends its suggestion prompt', async ({
    page,
    retainer,
  }) => {
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: 'Three ideas: Deals by stage, … Which one should I build?' }],
      stopReason: 'end_turn',
    });
    await signIn(page, retainer.url, retainer.keys.user);
    await page.getByRole('link', { name: 'Dashboards', exact: true }).click();
    await page.getByRole('link', { name: 'New dashboard' }).click();
    await expect(page).toHaveURL(/\/chat\?new=dashboard$/);
    await expect(page.getByText(/Pin it to keep it/)).toBeVisible();
    const prompt = 'Suggest a few dashboards I could build from this workspace’s data.';
    await page.getByRole('button', { name: prompt }).click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
    await expect(page.getByLabel('You')).toContainText(prompt);
    await expect(page.getByText(/Which one should I build\?/)).toBeVisible();
  });
});
