import { TAMLOOT } from '@retainer/runner/tamloot-contract';
import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test.use({ tamlootFixture: true });

test('shows where Tamloot saves data, with suggestions, folded fields and plain choices', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  // Sharing is said on the card, before setup starts.
  await expect(
    page.getByText(
      'Each member connects their own Tamloot account. What it imports from them is visible to everyone in this workspace.',
    ),
  ).toBeVisible();
  await page.getByRole('link', { name: /^Set up Tamloot/ }).click();
  await page.getByRole('button', { name: 'Get AI suggestions' }).click();
  await page.getByText('Allow members to share Tamloot meetings').click();
  await page.getByRole('button', { name: /^Meetings deleted in Tamloot/ }).click();
  await page.getByRole('option', { name: 'Keep what was imported' }).click();
  await page.getByRole('button', { name: 'Review AI access', exact: true }).click();
  // Model use is explained before approving the access that lets configure call it.
  await expect(page.getByText(/Tamloot sends Anthropic your workspace structure/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve and get suggestions' }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  await r.suggestTamloot();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  const list = page.getByRole('list', { name: 'Where Tamloot saves data' });
  const meetings = list.getByRole('listitem', { name: 'Meetings' });
  const tasks = list.getByRole('listitem', { name: 'Tasks' });
  // The suggested list is visible and its reasoning is available on demand.
  await expect(meetings.getByRole('button', { name: /^Where meetings go/ })).toContainText(
    'Conversations',
  );
  const reason = meetings.getByText(/Conversations already hold meetings/);
  await expect(reason).toBeHidden();
  await meetings.getByText('Why these suggestions?', { exact: true }).click();
  await expect(reason).toBeVisible();
  await expect(tasks.getByRole('button', { name: /^Title/ })).toHaveCount(0);
  await tasks.getByText('Adjust fields', { exact: true }).click();
  await expect(tasks.getByRole('button', { name: /^Status: Open/ })).toContainText('To do');

  // A choice away from the suggestion drops its reason and says what happens instead.
  await meetings.getByRole('button', { name: /^Where meetings go/ }).click();
  await page.getByRole('option', { name: 'New list: Meetings' }).click();
  await expect(reason).toHaveCount(0);
  await expect(meetings.getByRole('button', { name: 'Edit list API names' })).toBeVisible();
  // A new list keeps its fields editable, so an optional one can still be skipped.
  await tasks.getByRole('button', { name: /^Where tasks go/ }).click();
  await page.getByRole('option', { name: 'New list: Tasks' }).click();
  await tasks.getByRole('button', { name: /^Person/ }).click();
  await page.getByRole('option', { name: 'Don’t import' }).click();
  await expect(tasks.getByRole('button', { name: /^Person/ })).toContainText('Don’t import');
  await tasks.getByRole('button', { name: /^Where tasks go/ }).click();
  await page.getByRole('option', { name: 'Don’t import' }).click();
  await expect(tasks.getByRole('button', { name: /^Where tasks go/ })).toContainText(
    'Don’t import',
  );

  await page.getByRole('button', { name: 'Review installation', exact: true }).click();
  const planned = page.getByRole('list', { name: 'Where data goes' });
  await expect(planned.getByRole('listitem', { name: 'Meetings' })).toContainText(
    'Meetings to MeetingsNew',
  );
  await expect(planned.getByRole('listitem', { name: 'Tasks' })).toContainText(
    'Tasks to Not imported',
  );
  const people = planned.getByRole('listitem', { name: 'People' });
  await people.getByText('Field mappings', { exact: true }).click();
  await expect(people).toContainText('Emails to Emails');
  // The admin's choices are rows; turning on neither repeats the model notice
  // nor presents the first full grant as an access change.
  await expect(page.getByText('Deleted in Tamloot', { exact: true })).toBeVisible();
  await expect(page.getByText('Keep what was imported', { exact: true })).toBeVisible();
  await expect(page.getByText(/Anthropic/)).toHaveCount(0);
  await expect(page.getByText(/access changes from/i)).toHaveCount(0);
  await expect(page.getByText(/Source identity|source deletion/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Turn on Tamloot', exact: true }).click();
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

test('installs with manual destinations and asks before enabling AI suggestions later', async ({
  page,
  retainer: r,
}) => {
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Extensions', exact: true }).click();
  await page.getByRole('link', { name: /^Set up Tamloot/ }).click();
  await page.getByRole('button', { name: 'Set up manually' }).click();
  await page.getByText('Allow members to share Tamloot meetings').click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  const tasks = page
    .getByRole('list', { name: 'Where Tamloot saves data' })
    .getByRole('listitem', { name: 'Tasks' });
  await tasks.getByRole('button', { name: /^Where tasks go/ }).click();
  await page.getByRole('option', { name: 'Don’t import' }).click();
  await page.getByRole('button', { name: 'Review installation', exact: true }).click();
  await expect(page.getByText(/Anthropic/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Install Tamloot' }).click();
  await expect(page).toHaveURL(/\/extensions\/[0-9a-f-]{36}$/);

  const [installed] = (await r.request('/extensions', undefined, r.keys.user)).installations;
  const detail = await r.request(`/extensions/${installed.id}`, undefined, r.keys.user);
  expect(detail.bindingChoices.task).toEqual({ action: 'skip' });
  expect(detail.grantedUses).toEqual([]);
  await r.finishConfigure(true);
  const replan = await r.request(
    '/extensions/preview',
    {
      registrationId: TAMLOOT.registration,
      version: installed.version,
      installationId: installed.id,
      settings: detail.settings,
    },
    r.keys.user,
  );
  expect(replan.grants.uses).toEqual([]);
  await expect(r.request(`/extensions/${installed.id}/configure`, {}, r.keys.user)).rejects.toThrow(
    'grant_required',
  );
  const { runs } = await r.request(`/extensions/${installed.id}/runs`, undefined, r.keys.user);
  expect(runs).not.toContainEqual(expect.objectContaining({ functionId: TAMLOOT.configure }));

  await page.reload();
  await page.getByRole('button', { name: 'Destinations', exact: true }).click();
  await page.getByRole('link', { name: 'Change destinations' }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Get AI suggestions' }).click();
  await page.getByRole('button', { name: 'Review AI access', exact: true }).click();
  await expect(page.getByText(/Tamloot sends Anthropic your workspace structure/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve and get suggestions' }).click();
  await expect(page.getByText('Preparing suggestions…')).toBeVisible();
  await expect(
    r.request(`/extensions/${installed.id}`, undefined, r.keys.user),
  ).resolves.toMatchObject({ grantedUses: ['model'] });
  await r.suggestTamloot();
  await expect(page.getByRole('heading', { name: 'Connect Tamloot' })).toBeVisible();
});
