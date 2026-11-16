import { expect, test } from './fixtures.js';
import { signIn, signOut } from './helpers.js';

test('comments on a company: posted once despite a lost response, edited, deleted, never evidence', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${acme.id}?tab=comments`);
  await expect(page.getByText('No comments yet')).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Add a comment' });
  await box.fill('Their procurement moves slowly.\nLoop in legal early.');
  // The first post reaches the server, but its response is lost.
  let lost = false;
  await page.route('**/v1/records/*/comments', async (route) => {
    if (lost || route.request().method() !== 'POST') return route.continue();
    lost = true;
    await route.fetch();
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByText(/Your comment was not posted/)).toBeVisible();
  await expect(box).toHaveValue(/Their procurement/);
  await box.focus();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(box).toHaveValue('');
  await page.unrouteAll({ behavior: 'wait' });
  const posted = await r.request(`/records/${acme.id}/comments`);
  expect(posted.items).toHaveLength(1);
  expect(posted.items[0].author).toMatchObject({ type: 'user', id: 'dana' });
  const comments = page.getByRole('list', { name: 'Comments' });
  await expect(comments.getByRole('listitem')).toHaveCount(1);
  await expect(comments).toContainText('Their procurement moves slowly.');
  await expect(page.getByRole('button', { name: /^Comments/ })).toContainText('1');

  // A record with comments opens on them, and an edit says so.
  await page.goto(`${r.url}/app/r/${acme.id}`);
  await expect(page.getByRole('button', { name: /^Comments/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await comments.getByRole('listitem').hover();
  await page.getByRole('button', { name: 'Edit comment' }).click();
  const editor = page.getByRole('textbox', { name: 'Edit comment' });
  await editor.fill('Procurement is quick after all.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(comments).toContainText('Procurement is quick after all.');
  await expect(comments.getByText('edited')).toBeVisible();

  // Not evidence: it is on no history or activity list, and in no event query.
  await page.goto(`${r.url}/app/r/${acme.id}?tab=history`);
  await expect(page.getByText('Name set to')).toBeVisible();
  await expect(page.getByText('Procurement is quick after all.')).toHaveCount(0);
  await page.goto(`${r.url}/app/activity`);
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByText('Procurement is quick after all.')).toHaveCount(0);

  await page.goto(`${r.url}/app/r/${acme.id}?tab=comments`);
  await comments.getByRole('listitem').hover();
  await page.getByRole('button', { name: 'Delete comment' }).click();
  await page
    .getByRole('dialog', { name: 'Delete this comment?' })
    .getByRole('button', { name: 'Delete comment' })
    .click();
  await expect(page.getByText('No comments yet')).toBeVisible();
  // Deleting the last one leaves the person where they were.
  await expect(page.getByRole('button', { name: /^Comments/ })).toHaveAttribute(
    'aria-current',
    'page',
  );
  expect((await r.request(`/records/${acme.id}/comments`)).items).toEqual([]);
});

test('comments on a conversation, from its page and its sheet', async ({ page, retainer: r }) => {
  const call = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Renewal call',
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/e/${call.id}`);
  await page.getByRole('textbox', { name: 'Add a comment' }).fill('I was on this. Date is soft.');
  await page.keyboard.press('ControlOrMeta+Enter');
  const comments = page.getByRole('list', { name: 'Comments' });
  await expect(comments).toContainText('I was on this. Date is soft.');
  await page.goto(`${r.url}/app/o/conversation?record=${call.id}`);
  const sheet = page.getByRole('dialog', { name: 'Renewal call' });
  await expect(sheet.getByRole('list', { name: 'Comments' })).toContainText('Date is soft.');
  await sheet.getByRole('textbox', { name: 'Add a comment' }).fill('Second thought.');
  await sheet.getByRole('button', { name: 'Post comment' }).click();
  await expect(sheet.getByRole('list', { name: 'Comments' }).getByRole('listitem')).toHaveCount(2);
  await expect(sheet.getByRole('button', { name: /^Comments/ })).toContainText('2');
});

test('only people comment: an agent reads and is refused; others can only do what they may', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  const written = await r.request(
    `/records/${acme.id}/comments`,
    { body: 'Written by a person.' },
    r.keys.writer,
  );
  await expect(
    r.request(`/records/${acme.id}/comments`, { body: 'From an agent.' }, r.keys.agent),
  ).rejects.toThrow(/comment/i);
  await signIn(page, r.url, r.keys.agent);
  await page.goto(`${r.url}/app/r/${acme.id}?tab=comments`);
  const comments = page.getByRole('list', { name: 'Comments' });
  await expect(comments).toContainText('Written by a person.');
  await expect(page.getByRole('textbox', { name: 'Add a comment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete comment' })).toHaveCount(0);
  await signOut(page);

  // An admin deletes what someone else wrote, but cannot put words in their mouth.
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${acme.id}?tab=comments`);
  await comments.getByRole('listitem').hover();
  await expect(page.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete comment' })).toBeVisible();
  await expect(
    r.request(`/comments/${written.id}`, { body: 'Rewritten.' }, r.keys.user, 'PATCH'),
  ).rejects.toThrow(/author/i);
});
