import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

const chatLink = (page: import('@playwright/test').Page) =>
  page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Chat' });

test('Chat is absent from navigation and direct access when the agent is unavailable', async ({
  page,
  retainer,
}) => {
  await signIn(page, retainer.url, retainer.keys.user);
  await expect(chatLink(page)).toHaveCount(0);
  await page.goto(`${retainer.url}/app/chat`);
  await expect(page.getByRole('heading', { name: 'Chat is unavailable' })).toBeVisible();
});

test.describe('with the agent', () => {
  test.use({ agentFixture: true });

  test('asks a question, watches the agent search and answer, and finds it saved after a reload', async ({
    page,
    retainer: r,
  }) => {
    await r.request('/objects/company/records', { values: { name: 'Acme Robotics' } });
    r.anthropic?.enqueue(
      {
        blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'Acme' } }],
        stopReason: 'tool_use',
      },
      {
        blocks: [{ type: 'text', text: 'Acme Robotics is a **company** in your workspace.' }],
        stopReason: 'end_turn',
      },
    );
    await signIn(page, r.url, r.keys.user);
    await chatLink(page).click();
    await expect(page.getByRole('heading', { name: 'Chat', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).fill('What do we know about Acme?');
    await page.getByRole('button', { name: 'Send' }).click();

    const messages = page.getByRole('list', { name: 'Messages' });
    await expect(messages.getByText('What do we know about Acme?')).toBeVisible();
    await expect(messages.getByText('Searched for “Acme”')).toBeVisible();
    await expect(messages.getByText('Acme Robotics is a')).toBeVisible();
    await expect(messages.locator('strong', { hasText: 'company' })).toBeVisible();
    // The model got exactly the person's text, with the server's context first.
    const first = r.anthropic?.requests[0]?.body as { messages: { content: unknown }[] };
    expect(JSON.stringify(first.messages.at(-1))).toContain('What do we know about Acme?');

    // Saved: a reload reads the chat back from the agent's store.
    await page.reload();
    await expect(messages.getByText('What do we know about Acme?')).toBeVisible();
    await expect(messages.getByText('Searched for “Acme”')).toBeVisible();
    await expect(messages.getByText('Acme Robotics is a')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'What do we know about Acme?' })).toBeVisible();

    // Listed, then deleted.
    await chatLink(page).click();
    await page.getByRole('link', { name: /What do we know about Acme\?/ }).click();
    await page.getByRole('button', { name: 'Delete chat' }).click();
    await page
      .getByRole('dialog', { name: 'Delete this chat?' })
      .getByRole('button', { name: 'Delete chat' })
      .click();
    await expect(page.getByText('No chats yet')).toBeVisible();
  });

  test('scrolls a wide Markdown table inside a narrow chat', async ({ page, retainer: r }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    r.anthropic?.enqueue({
      blocks: [
        {
          type: 'text',
          text: [
            'Here are the companies in the demo workspace.',
            '',
            '| Company | Estimated revenue | Business stage | Headquarters | Next step |',
            '| --- | --- | --- | --- | --- |',
            '| Northstar Labs | $1.8M | Growth | Boston | Review the pilot |',
            '| Cedar Works | $920K | Early stage | Portland | Schedule a call |',
            '| Juniper Systems | — | Early stage | Denver | Confirm revenue |',
            '',
            '- Revenue is unavailable for Juniper Systems.',
          ].join('\n'),
        },
      ],
      stopReason: 'end_turn',
    });
    await signIn(page, r.url, r.keys.user);
    await page.goto(`${r.url}/app/chat`);
    await page.getByRole('textbox', { name: 'Message' }).fill('Compare the demo companies.');
    await page.getByRole('button', { name: 'Send' }).click();

    const messages = page.getByRole('list', { name: 'Messages' });
    const region = messages.getByRole('region', { name: 'Markdown table' });
    await expect(region.getByRole('columnheader', { name: 'Next step' })).toBeVisible();
    await expect(messages.getByText('Revenue is unavailable for Juniper Systems.')).toBeVisible();
    expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.locator('html').evaluate((el) => el.scrollWidth)).toBe(390);
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });

  test('groups repeated writes and shows how many bulk items failed', async ({
    page,
    retainer: r,
  }) => {
    const companies = ['Maple Workshop', 'Juniper Labs', 'Cedar Studio'];
    r.anthropic?.enqueue(
      {
        blocks: companies.map((name, i) => ({
          type: 'tool_use' as const,
          id: `toolu_${i}`,
          name: 'upsert_record',
          input: { object: 'company', values: { name } },
        })),
        stopReason: 'tool_use',
      },
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_bulk',
            name: 'upsert_records',
            input: {
              items: [
                {
                  object: 'company',
                  values: { name: 'Birch Design' },
                  idempotencyKey: 'demo-birch',
                },
                { object: 'company', match: { name: 'Missing Company' } },
              ],
            },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        blocks: [{ type: 'text', text: 'I saved four companies. One update failed.' }],
        stopReason: 'end_turn',
      },
    );
    await signIn(page, r.url, r.keys.user);
    await chatLink(page).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Save the companies from my notes.');
    await page.getByRole('button', { name: 'Send' }).click();

    const messages = page.getByRole('list', { name: 'Messages' });
    const summary = messages.getByText('Saved 3 records', { exact: true });
    const calls = messages.getByText('Saved a record', { exact: true });
    await expect(summary).toBeVisible();
    await expect(messages.getByText('Saved 1 record, 1 failed')).toBeVisible();
    await expect(messages.getByText('I saved four companies. One update failed.')).toBeVisible();
    // Exercise the saved trace after the streamed messages are reconciled.
    const id = new URL(page.url()).pathname.split('/').at(-1);
    await expect
      .poll(async () => (await r.request(`/agent/chats/${id}`, undefined, r.keys.user)).running)
      .toBe(false);
    await page.reload();
    await expect(summary).toBeVisible();
    await expect(calls.first()).toBeHidden();

    await summary.locator('..').press('Space');
    await expect(calls).toHaveCount(3);
    for (const call of await calls.all()) await expect(call).toBeVisible();
    await calls.first().click();
    await expect(messages.getByText('Maple Workshop', { exact: false }).first()).toBeVisible();

    await page.reload();
    await expect(summary).toBeVisible();
    await expect(calls.first()).toBeHidden();
  });

  test('stops a turn that is taking long', async ({ page, retainer: r }) => {
    r.anthropic?.enqueue({
      blocks: [{ type: 'text', text: 'This answer never arrives.' }],
      stopReason: 'end_turn',
      delayMs: 20_000,
    });
    await signIn(page, r.url, r.keys.user);
    await chatLink(page).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Take your time');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').getByText('Thinking…')).toBeVisible();
    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    // The server stopped the turn too: the runtime noticed the cancel and closed it.
    const id = new URL(page.url()).pathname.split('/').at(-1);
    await expect
      .poll(async () => (await r.request(`/agent/chats/${id}`, undefined, r.keys.user)).running)
      .toBe(false);
    await expect(page.getByText('This answer never arrives.')).toHaveCount(0);
  });
});
