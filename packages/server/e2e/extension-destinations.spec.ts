import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ tamlootFixture: true });

test('shows where Tamloot saves data, with suggestions, folded fields and plain choices', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: /^Set up Tamloot/ }).click();
  await page.getByText('Allow members to share Tamloot meetings').click();
  await page.getByRole('button', { name: 'Review installation', exact: true }).click();
  await page.getByRole('button', { name: 'Approve access', exact: true }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  await r.suggestTamloot();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  const list = page.getByRole('list', { name: 'Where Tamloot saves data' });
  const meetings = list.getByRole('listitem', { name: 'Meetings' });
  const tasks = list.getByRole('listitem', { name: 'Tasks' });
  // Each kind of record shows its suggested list and why.
  await expect(meetings.getByRole('button', { name: /^Where meetings go/ })).toContainText(
    'Conversations',
  );
  await expect(meetings).toContainText('Suggested. Conversations already hold meetings');
  // Fields stay folded under a summary, status values included.
  await expect(tasks).toContainText('Status → Status (Open → To do, Done → Done)');
  await expect(tasks.getByRole('button', { name: /^Title/ })).toHaveCount(0);
  await tasks.getByText('Fields', { exact: true }).click();
  await expect(tasks.getByRole('button', { name: /^Status: Open/ })).toContainText('To do');

  // A choice away from the suggestion drops its reason and says what happens instead.
  await meetings.getByRole('button', { name: /^Where meetings go/ }).click();
  await page.getByRole('option', { name: 'New list: Meetings' }).click();
  await expect(meetings).not.toContainText('Suggested.');
  await expect(meetings).toContainText('Adds a new list, Meetings, to your workspace.');
  // A new list keeps its fields editable, so an optional one can still be skipped.
  await tasks.getByRole('button', { name: /^Where tasks go/ }).click();
  await page.getByRole('option', { name: 'New list: Tasks' }).click();
  await tasks.getByRole('button', { name: /^Person/ }).click();
  await page.getByRole('option', { name: 'Don’t import' }).click();
  await expect(tasks.getByRole('button', { name: /^Person/ })).toContainText('Don’t import');
  await tasks.getByRole('button', { name: /^Where tasks go/ }).click();
  await page.getByRole('option', { name: 'Don’t import' }).click();
  await expect(tasks).toContainText('Tamloot won’t import tasks.');

  await page.getByRole('button', { name: 'Review installation', exact: true }).click();
  const planned = page.getByRole('list', { name: 'Where data goes' });
  await expect(planned.getByRole('listitem', { name: 'Meetings' })).toContainText(
    'Meetings to MeetingsNew',
  );
  await expect(planned.getByRole('listitem', { name: 'Tasks' })).toContainText(
    'Tasks to Not imported',
  );
  await expect(planned.getByRole('listitem', { name: 'People' })).toContainText('Emails to Emails');
  await page.getByRole('button', { name: 'Review and turn on', exact: true }).click();
  await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);
  const [installed] = (await r.request('/extensions', undefined, r.keys.user)).installations;
  const detail = await r.request(`/extensions/${installed.id}`, undefined, r.keys.user);
  // The new list exists once approved, so the stored plan names it.
  expect(detail.bindingChoices).toMatchObject({
    meeting: { action: 'existing', objects: ['meeting'] },
    task: { action: 'skip' },
    person: { action: 'existing', objects: ['person'] },
  });

  await page.getByRole('button', { name: 'Destinations', exact: true }).click();
  const summary = page.getByRole('region', { name: 'Where Tamloot saves data' });
  await expect(summary.getByRole('listitem', { name: 'People' })).toContainText('People to People');
  await expect(summary.getByRole('link', { name: 'Change destinations' })).toBeVisible();
});
