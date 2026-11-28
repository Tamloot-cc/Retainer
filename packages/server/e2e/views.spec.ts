import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

const draftText = (draft: object) =>
  `Here’s the view.\n\n\`\`\`retainer-view\n${JSON.stringify(draft)}\n\`\`\``;
const groupedDraft = {
  object: 'deal',
  kind: 'table',
  name: 'Proposal review',
  description: 'Current proposals grouped by stage.',
  groupBy: 'stage',
  hideEmptyGroups: true,
  filter: { or: [{ stage: 'proposal' }, { stage: 'qualified' }] },
};

test.describe('views built in chat', () => {
  test.use({ agentFixture: true, workspaceTemplate: 'sales' });

  test('opens a checked draft unsaved, removes a setting and keeps it private', async ({
    page,
    retainer,
  }) => {
    await retainer.request('/objects/deal/records', {
      values: { name: 'Proposal one', stage: 'proposal' },
    });
    await retainer.request('/objects/deal/records', {
      values: { name: 'Closed deal', stage: 'won' },
    });
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText(groupedDraft) }],
      stopReason: 'end_turn',
    });
    await signIn(page, retainer.url, retainer.keys.user);
    await page.getByRole('link', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Draft my proposal review.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Proposal review', exact: true })).toBeVisible();
    await expect(page.getByText('Proposal · 1', { exact: true })).toBeVisible();
    await expect(page.getByLabel('View settings')).toContainText(
      'Stage is Proposal or Stage is Qualified',
    );
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page).toHaveURL(/draft=/);
    await expect(page.getByRole('link', { name: 'Proposal one', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Closed deal', exact: true })).toHaveCount(0);
    expect(
      (await retainer.request('/objects/deal/views', undefined, retainer.keys.user)).views,
    ).toEqual([]);

    await page
      .getByRole('button', { name: /Remove .*Stage is Proposal or Stage is Qualified/ })
      .click();
    await expect(page.getByRole('link', { name: 'Closed deal', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    await expect(page).toHaveURL(/view=/);
    const kept = await retainer.request('/objects/deal/views', undefined, retainer.keys.user);
    expect(kept.views).toMatchObject([
      { name: 'Proposal review', visibility: 'private', filter: null },
    ]);
  });

  test('displays five live records and keeps an ordinary draft from the card', async ({
    page,
    retainer,
  }) => {
    for (let n = 1; n <= 6; n++)
      await retainer.request('/objects/deal/records', { values: { name: `Preview row ${n}` } });
    const draft = {
      object: 'deal',
      name: 'Deal list',
      kind: 'table',
      description: 'A working list of deals.',
      sort: [{ field: 'name', direction: 'asc' }],
    };
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText(draft) }],
      stopReason: 'end_turn',
    });
    await signIn(page, retainer.url, retainer.keys.user);
    await page.getByRole('link', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Draft a list of deals.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('6 matching records')).toBeVisible();
    await expect(page.getByText(/^Preview row [1-6]$/)).toHaveCount(5);
    await expect(page.getByText('Preview row 6', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await retainer.request('/objects/deal/views', undefined, retainer.keys.user)).views,
      )
      .toMatchObject([{ name: 'Deal list', visibility: 'private' }]);
  });

  test('shows check problems and hides keep and open for an invalid draft', async ({
    page,
    retainer,
  }) => {
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText({ ...groupedDraft, groupBy: 'nonexistent' }) }],
      stopReason: 'end_turn',
    });
    await signIn(page, retainer.url, retainer.keys.user);
    await page.getByRole('link', { name: 'Chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message' }).fill('Show my proposed view.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText(/unknown field "nonexistent"/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save view', exact: true })).toHaveCount(0);
  });

  test('starts an edit chat and updates the existing view', async ({ page, retainer }) => {
    const kept = await retainer.request(
      '/objects/deal/views',
      {
        name: 'Pipeline review',
        kind: 'table',
        visibility: 'private',
      },
      retainer.keys.user,
    );
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText({ view: kept.id, groupBy: 'stage' }) }],
      stopReason: 'end_turn',
    });
    await signIn(page, retainer.url, retainer.keys.user);
    await page.goto(`${retainer.url}/app/o/deal?view=${kept.id}`);
    await page.getByRole('button', { name: 'View: Pipeline review' }).click();
    await page.getByRole('menuitem', { name: 'Edit with the agent' }).click();
    await expect(page.getByLabel('You')).toContainText(`"view": "${kept.id}"`);
    await page.getByRole('button', { name: 'Update “Pipeline review”' }).click();
    await expect
      .poll(
        async () =>
          (await retainer.request(`/views/${kept.id}`, undefined, retainer.keys.user)).groupBy,
      )
      .toBe('stage');
    expect(
      (await retainer.request('/objects/deal/views', undefined, retainer.keys.user)).views,
    ).toMatchObject([{ id: kept.id, visibility: 'private' }]);
  });
});

test.describe('relation boards', () => {
  test.use({ workspaceTemplate: 'sales' });

  test('moves a card to another company column', async ({ page, retainer }) => {
    const acme = await retainer.request('/objects/company/records', { values: { name: 'Acme' } });
    const globex = await retainer.request('/objects/company/records', {
      values: { name: 'Globex' },
    });
    const moving = await retainer.request('/objects/deal/records', {
      values: { name: 'Move this deal', company: acme.id },
    });
    await retainer.request('/objects/deal/records', {
      values: { name: 'Globex deal', company: globex.id },
    });
    const kept = await retainer.request('/objects/deal/views', {
      name: 'By company',
      kind: 'board',
      groupBy: 'company',
      groupOrder: 'asc',
    });
    await signIn(page, retainer.url, retainer.keys.user);
    await page.goto(`${retainer.url}/app/o/deal?view=${kept.id}`);
    const card: Locator = page.getByRole('button', { name: 'Move this deal' });
    await card.focus();
    await page.keyboard.press('Space');
    const status = page
      .getByRole('status')
      .filter({ hasText: 'Move this deal is over the Acme column.' });
    await expect(status).toHaveCount(1);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
    await page.keyboard.press('ArrowRight');
    await expect(
      page.getByRole('status').filter({ hasText: 'Move this deal is over the Globex column.' }),
    ).toHaveCount(1);
    await page.keyboard.press('Space');
    await expect(page.getByRole('region', { name: 'Globex, 2' })).toContainText('Move this deal');
    await expect
      .poll(async () => (await retainer.request(`/records/${moving.id}`)).fields.company)
      .toBe(globex.id);

    await page.getByRole('button', { name: 'View: By company' }).click();
    await page.getByRole('menuitem', { name: 'Edit view…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit view' });
    await dialog.getByRole('button', { name: 'Table', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Move this deal', exact: true })).toBeVisible();
    await expect.poll(async () => (await retainer.request(`/views/${kept.id}`)).groupBy).toBeNull();
  });
});
