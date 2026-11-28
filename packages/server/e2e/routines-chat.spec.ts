import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

const SOURCE = '5f0c2a1e-0000-4000-8000-000000000001';
const PREVIEW = 'a41e2a1e-0000-4000-8000-000000000002';
const ROUTINE = 'b51e2a1e-0000-4000-8000-000000000003';
const fence = {
  source: SOURCE,
  preview: PREVIEW,
  name: 'Thank-you task for won deals',
  description: 'When a deal moves to Won, create a task for its owner to send a thank-you note.',
  summary: "Creates one task for the deal's owner.",
  report: { verdict: 'full', gaps: [] },
};
const draftText = (value: object) =>
  `Here’s the routine.\n\n\`\`\`retainer-routine\n${JSON.stringify(value)}\n\`\`\``;
const run = {
  id: 'run-1',
  routineId: null,
  versionId: null,
  mode: 'dry',
  trigger: 'preview',
  recordId: null,
  status: 'succeeded',
  code: null,
  attempt: 1,
  at: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  expiresAt: null,
  initiatedBy: null,
  modelCalls: 0,
  output: null,
  calls: [
    {
      position: 1,
      operation: 'record.create',
      state: 'reported',
      code: null,
      differs: false,
      recordId: null,
    },
  ],
};
const draft = (over: object = {}) => ({
  sourceId: SOURCE,
  manifest: {
    when: { kind: 'record', object: 'deal', on: ['updated'] },
    uses: { tools: [], model: false },
  },
  code: 'export async function main() {\n  // creates the task\n}',
  facts: ["Runs when a deal's Stage changes.", 'Writes as an agent.'],
  ok: true,
  problems: [],
  count: { kind: 'record', value: 4 },
  preview: { available: true, done: true, runs: [run] },
  proposals: [],
  ...over,
});

/** Stubs the draft route and counts what the card asks for: it never starts a dry run. */
async function stubRoutes(page: Page, answer: () => object) {
  const seen = { drafts: 0, previews: 0, proposed: [] as unknown[] };
  await page.route('**/v1/routines/drafts/**', async (route) => {
    seen.drafts++;
    await route.fulfill({ json: answer() });
  });
  await page.route('**/v1/routines/preview', async (route) => {
    seen.previews++;
    await route.fulfill({ status: 500, json: {} });
  });
  await page.route('**/v1/routines', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    seen.proposed.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      json: { routineId: ROUTINE, versionId: 'v1', number: 1 },
    });
  });
  return seen;
}

async function ask(page: Page, url: string, key: string, text: string) {
  await signIn(page, url, key);
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Message' }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('routines built in chat', () => {
  test.use({ agentFixture: true, routineFixture: true, workspaceTemplate: 'sales' });

  test('shows Retainer’s facts, the agent’s words and the stored dry run, then proposes as the person', async ({
    page,
    retainer,
  }) => {
    let proposals: object[] = [];
    const seen = await stubRoutes(page, () => draft({ proposals }));
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText(fence) }],
      stopReason: 'end_turn',
    });
    await ask(page, retainer.url, retainer.keys.user, 'Thank won deals.');
    await expect(page.getByRole('heading', { name: fence.name, exact: true })).toBeVisible();
    const facts = page.getByRole('region', { name: "Retainer's facts" });
    await expect(facts).toContainText("Runs when a deal's Stage changes.");
    await expect(page.getByRole('region', { name: "The agent's summary" })).toContainText(
      fence.summary,
    );
    const dry = page.getByRole('region', { name: 'Dry run', exact: true });
    await expect(dry).toContainText('4 changes in the last 30 days matched the trigger');
    await expect(dry.getByText('Done', { exact: true })).toBeVisible();
    proposals = [
      {
        routineId: ROUTINE,
        versionId: 'v1',
        number: 1,
        name: fence.name,
        description: fence.description,
        summary: fence.summary,
        report: fence.report,
        state: 'proposed',
        builtBy: { type: 'user', id: 'x' },
        byYou: true,
        createdAt: new Date().toISOString(),
      },
    ];
    await page.getByRole('button', { name: 'Propose', exact: true }).click();
    await expect(page.getByText(/Proposed, waiting for an admin/)).toBeVisible();
    expect(seen.proposed).toEqual([
      {
        sourceId: SOURCE,
        name: fence.name,
        description: fence.description,
        summary: fence.summary,
        report: fence.report,
      },
    ]);
    // Reopening the chat shows it as proposed and starts no dry run.
    await page.reload();
    await expect(page.getByText(/Proposed, waiting for an admin/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Propose', exact: true })).toHaveCount(0);
    expect(seen.previews).toBe(0);
  });

  test('a draft with no dry run can be proposed; one naming a routine proposes a new version', async ({
    page,
    retainer,
  }) => {
    const seen = await stubRoutes(page, () => draft({ preview: null }));
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText({ ...fence, preview: null, routine: ROUTINE }) }],
      stopReason: 'end_turn',
    });
    await ask(page, retainer.url, retainer.keys.user, 'Change my won-deal routine.');
    await expect(page.getByText(/No stored dry run/)).toBeVisible();
    await page.getByRole('button', { name: 'Propose new version', exact: true }).click();
    await expect.poll(() => seen.proposed.length).toBe(1);
    expect(seen.proposed[0]).toMatchObject({ sourceId: SOURCE, routineId: ROUTINE });
  });

  test('while its dry run goes, the card polls only the runs and reads the draft once', async ({
    page,
    retainer,
  }) => {
    const seen = await stubRoutes(page, () =>
      draft({ preview: { available: true, done: false, runs: [{ ...run, status: 'running' }] } }),
    );
    let polls = 0;
    await page.route(`**/v1/routines/previews/${PREVIEW}`, async (route) => {
      polls++;
      await route.fulfill({
        json: {
          previewId: PREVIEW,
          done: polls > 1,
          runs: [polls > 1 ? run : { ...run, status: 'running' }],
        },
      });
    });
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText(fence) }],
      stopReason: 'end_turn',
    });
    await ask(page, retainer.url, retainer.keys.user, 'Thank won deals.');
    const dry = page.getByRole('region', { name: 'Dry run', exact: true });
    await expect(dry.getByText('Done', { exact: true })).toBeVisible({ timeout: 10_000 });
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(seen.drafts).toBe(1);
    expect(seen.previews).toBe(0);
  });

  test('a dry run poll that fails stops and says so; one gone reads the draft again', async ({
    page,
    retainer,
  }) => {
    let gone = false;
    const seen = await stubRoutes(page, () =>
      draft({
        preview: gone
          ? { available: false }
          : { available: true, done: false, runs: [{ ...run, status: 'running' }] },
      }),
    );
    let polls = 0;
    await page.route(`**/v1/routines/previews/${PREVIEW}`, async (route) => {
      polls++;
      if (polls === 1)
        return route.fulfill({
          status: 500,
          json: { error: { code: 'internal', message: 'boom' } },
        });
      gone = true;
      return route.fulfill({
        status: 404,
        json: { error: { code: 'not_found', message: 'gone' } },
      });
    });
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText(fence) }],
      stopReason: 'end_turn',
    });
    await ask(page, retainer.url, retainer.keys.user, 'Thank won deals.');
    await expect(page.getByText(/Couldn’t follow this dry run: boom/)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Propose', exact: true })).toBeVisible();
    await page.waitForTimeout(4500);
    expect(polls).toBe(1);
    // Reopened, the next poll finds the dry run gone and the draft is read again.
    await page.reload();
    await expect(page.getByText(/No stored dry run|no longer kept/)).toBeVisible({
      timeout: 10_000,
    });
    expect(seen.drafts).toBeGreaterThanOrEqual(3);
  });

  test('a draft whose check no longer holds offers no Propose', async ({ page, retainer }) => {
    await stubRoutes(page, () => draft({ ok: false }));
    retainer.anthropic?.enqueue({
      blocks: [{ type: 'text', text: draftText(fence) }],
      stopReason: 'end_turn',
    });
    await ask(page, retainer.url, retainer.keys.user, 'Thank won deals.');
    await expect(page.getByText(/This draft needs a fresh check/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Propose', exact: true })).toHaveCount(0);
  });

  test('New routine opens the chat’s starter, which creates a chat only on send', async ({
    page,
    retainer,
  }) => {
    await signIn(page, retainer.url, retainer.keys.user);
    await page.getByRole('link', { name: 'Routines', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Describe the routine' })).toHaveCount(0);
    await page.getByRole('link', { name: 'New routine' }).click();
    await expect(page).toHaveURL(/\/chat\?new=routine$/);
    await expect(page.getByText(/an admin approves it before anything runs/)).toBeVisible();
    await expect(page.getByText('No chats yet')).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Suggest a few routines that would save time in this workspace.',
      })
      .click();
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/);
    await expect(
      page.getByText('Suggest a few routines that would save time in this workspace.'),
    ).toBeVisible();
  });
});
