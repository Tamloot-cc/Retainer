import { expect, test } from './fixtures.js';
import { signIn } from './helpers.js';

test('deletes an event and refreshes the affected memory', async ({ page, retainer: r }) => {
  const record = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  const event = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Renewal call',
    summary: 'Discussed renewal',
    participants: [{ recordId: record.id }],
  });
  await r.request(
    `/records/${record.id}`,
    { values: { jobTitle: 'CTO' }, source: event.id },
    r.keys.agent,
    'PATCH',
  );
  await r.request(`/records/${record.id}/facts`, {
    text: 'Needs a renewal quote',
    source: event.id,
    quote: 'Please send a quote',
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/r/${record.id}?tab=events`);
  await expect(page.getByText('Participant', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Renewal call' }).click();
  await page.getByRole('button', { name: 'Delete event', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete event', exact: true }).click();
  await expect(
    page.getByText(/1 assertions retracted, 1 records recomputed, 1 facts hidden/),
  ).toBeVisible();
  await page.goto(`${r.url}/app/r/${record.id}`);
  await expect(page.getByText('No facts yet')).toBeVisible();
});

test('groups the sidebar into Records and Activity, and explains what event lists lack', async ({
  page,
  retainer: r,
}) => {
  const dana = (await r.request('/objects/person/records', { values: { name: 'Dana Levi' } }))
    .record;
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  for (const [title, day] of [
    ['Kickoff', '2026-10-20'],
    ['Pricing review', '2026-10-22'],
  ])
    await r.request('/events', {
      type: 'conversation',
      channel: 'gmail',
      externalId: title,
      occurredAt: `${day}T10:00:00Z`,
      title,
      fields: { medium: 'email' },
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
  await signIn(page, r.url, r.keys.user);
  const records = page.getByRole('group', { name: 'Records' });
  const activity = page.getByRole('group', { name: 'Activity' });
  await expect(records.getByRole('link', { name: 'People', exact: true })).toBeVisible();
  await expect(records.getByRole('link', { name: 'Conversations' })).toHaveCount(0);
  await expect(activity.getByRole('link')).toHaveText(['Conversations']);
  // The icon rail keeps both groups.
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand sidebar' }).click();

  await activity.getByRole('link', { name: 'Conversations' }).click();
  const grid = page.getByRole('region', { name: 'Conversations' });
  // Newest first, with when, medium, who, what about and where from.
  await expect(grid.getByRole('link', { name: /^(Kickoff|Pricing review)$/ })).toHaveText([
    'Pricing review',
    'Kickoff',
  ]);
  for (const column of ['Occurred', 'Medium', 'Participants', 'About', 'Source'])
    await expect(grid.getByRole('columnheader', { name: column })).toBeVisible();
  await expect(grid.getByRole('columnheader', { name: 'Summary' })).toHaveCount(0);
  await expect(grid.getByRole('link', { name: 'Dana Levi' }).first()).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Acme' }).first()).toBeVisible();
  await expect(grid.getByText('gmail').first()).toBeVisible();
  // No New button, and a line that says why.
  await expect(page.getByRole('button', { name: /^New / })).toHaveCount(0);
  await page.getByRole('button', { name: 'Logged by agents and integrations.' }).click();
  await expect(page.getByRole('dialog', { name: 'How events are logged' })).toContainText(
    'POST /v1/events',
  );
  await page.keyboard.press('Escape');
  // Two selected: delete, but no merge, and that is said.
  await grid.getByRole('checkbox', { name: 'Select Kickoff' }).check();
  await grid.getByRole('checkbox', { name: 'Select Pricing review' }).check();
  await expect(page.getByText('Events can’t be merged')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Merge…' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection' }).click();
  // A calendar of when they happened, with nothing to set up.
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await expect(page).toHaveURL(/layout=calendar/);
  await page.goto(`${r.url}/app/o/conversation?layout=calendar&month=2026-10`);
  await expect(page.getByRole('button', { name: /Kickoff/ })).toBeVisible();
  // People write comments now, not notes (C5).
  await expect(page.getByRole('button', { name: 'Write a note' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Write a note' })).toHaveCount(0);
});

test('filters all activity by type, source, date and linked record, in the address', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  const globex = (await r.request('/objects/company/records', { values: { name: 'Globex' } }))
    .record;
  await r.request('/events', {
    type: 'conversation',
    channel: 'gmail',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Acme intro',
    summary: 'First call with the Acme team about the pilot.',
    fields: { medium: 'call' },
    about: [acme.id],
  });
  await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-22T10:00:00Z',
    title: 'Globex demo',
    about: [globex.id],
  });
  await r.request(
    '/schema/changes',
    {
      reason: 'A second event type',
      operations: [
        {
          op: 'create_object',
          object: {
            class: 'event',
            nameSingular: 'memo',
            namePlural: 'memos',
            labelSingular: 'Memo',
            labelPlural: 'Memos',
            fields: [],
          },
        },
      ],
    },
    r.keys.user,
  );
  await r.request('/events', {
    type: 'memo',
    channel: 'agent',
    occurredAt: '2026-10-23T10:00:00Z',
    title: 'Acme budget note',
    about: [acme.id],
  });
  await signIn(page, r.url, r.keys.user);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Home', exact: true })).toBeVisible();
  const titles = page.getByRole('button', { name: /^(Acme intro|Globex demo|Acme budget note)$/ });
  await expect(titles).toHaveText(['Acme budget note', 'Globex demo', 'Acme intro']);
  // Grouped by day, with the medium as a chip and the about records linked.
  await expect(page.getByRole('region', { name: /Today/ })).toContainText('Call');
  await expect(page.getByRole('region', { name: /Today/ })).toContainText(
    'First call with the Acme team',
  );

  const filter = async (kind: string) => {
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByRole('option', { name: kind, exact: true }).click();
  };
  await filter('Type');
  await page.getByRole('option', { name: 'Memos' }).click();
  await page.keyboard.press('Escape');
  await expect(titles).toHaveText(['Acme budget note']);
  await expect(page).toHaveURL(/eventTypes=memo/);
  await page.getByRole('button', { name: 'Remove filter Type' }).click();
  await expect(titles).toHaveCount(3);

  await filter('Source');
  await page.getByLabel('Source', { exact: true }).fill('zoom');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(titles).toHaveText(['Globex demo']);
  await page.getByRole('button', { name: 'Remove filter Source' }).click();

  await filter('Date');
  await page.getByRole('textbox', { name: 'From', exact: true }).fill('2100-01-01');
  await page.getByRole('textbox', { name: 'To', exact: true }).fill('2100-01-02');
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(titles).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove filter Added' }).click();

  await filter('Linked record');
  await page.getByRole('combobox', { name: 'Linked record' }).fill('Acme');
  // Entities only: an event is not something to be linked to (C4).
  await expect(page.getByRole('option', { name: /^Acme\b.*Company/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /^Acme intro/ })).toHaveCount(0);
  await page.getByRole('option', { name: /^Acme\b.*Company/ }).click();
  await expect(titles).toHaveText(['Acme budget note', 'Acme intro']);
  await expect(page.getByText('Linked to')).toBeVisible();
  // The address reproduces the feed, and a row opens in the side sheet.
  await page.reload();
  await expect(titles).toHaveText(['Acme budget note', 'Acme intro']);
  await titles.first().click();
  const sheet = page.getByRole('dialog', { name: 'Acme budget note' });
  await expect(sheet.getByText('Activity · Memo')).toBeVisible();
  await expect(page).toHaveURL(/record=/);
});

test('an event page has comments, claims and history, and no memory of its own', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  const call = await r.request('/events', {
    type: 'conversation',
    channel: 'zoom',
    occurredAt: '2026-10-20T10:00:00Z',
    title: 'Renewal call',
    about: [acme.id],
  });
  await r.request(
    `/records/${acme.id}`,
    { values: { name: 'Acme Holdings' }, source: call.id },
    r.keys.agent,
    'PATCH',
  );
  await r.request(`/records/${acme.id}/facts`, {
    text: 'Wants a two-year term',
    source: call.id,
    quote: 'two years works for us',
  });
  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/e/${call.id}`);
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('button')).toHaveText([/^Comments/, /^Claims/, /^History/]);
  await expect(page.getByText('No comments yet')).toBeVisible();

  await sections.getByRole('button', { name: /^Claims/ }).click();
  await expect(sections.getByRole('button', { name: /^Claims/ })).toContainText('2');
  const values = page.getByRole('list', { name: 'Values citing this event' });
  await expect(values).toContainText('Name set to');
  await expect(values).toContainText('Acme Holdings');
  // The event's own values cite it too, and are not claims about it.
  await expect(values.getByRole('listitem')).toHaveCount(1);
  const facts = page.getByRole('list', { name: 'Facts citing this event' });
  await expect(facts).toContainText('Wants a two-year term');
  await expect(facts).toContainText('two years works for us');

  await sections.getByRole('button', { name: 'History' }).click();
  await expect(page.getByText('Title set to')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Field changes' })).toHaveCount(0);

  // The same tabs on the record page and the sheet; an entity keeps its own.
  await page.goto(`${r.url}/app/r/${call.id}`);
  await expect(sections.getByRole('button')).toHaveText([/^Comments/, /^Claims/, /^History/]);
  // A fact stored on the event itself stays reachable, in a tab only it gets.
  await r.request(`/records/${call.id}/facts`, { text: 'Recorded with consent' });
  await page.reload();
  await expect(sections.getByRole('button')).toHaveText([
    /^Comments/,
    /^Claims/,
    /^History/,
    /^Facts/,
  ]);
  await sections.getByRole('button', { name: /^Facts/ }).click();
  await expect(page.getByRole('list', { name: 'Facts' })).toContainText('Recorded with consent');
  await page.goto(`${r.url}/app/r/${acme.id}`);
  await expect(sections.getByRole('button')).toHaveText([
    /^Comments/,
    /^Facts/,
    'Activity',
    'History',
    'Tasks',
  ]);
});

test('an event is about entities only: another event is refused and not offered', async ({
  page,
  retainer: r,
}) => {
  const acme = (await r.request('/objects/company/records', { values: { name: 'Acme' } })).record;
  const log = (title: string) =>
    r.request('/events', {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: '2026-10-20T10:00:00Z',
      title,
    });
  const kickoff = await log('Acme kickoff');
  const followUp = await log('Follow-up');
  await expect(r.request(`/events/${followUp.id}/links`, { about: [kickoff.id] })).rejects.toThrow(
    /invalid_link/,
  );
  await expect(
    r.request('/events', {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: '2026-10-21T10:00:00Z',
      title: 'Another',
      about: [kickoff.id],
    }),
  ).rejects.toThrow(/invalid_link/);

  await signIn(page, r.url, r.keys.user);
  await page.goto(`${r.url}/app/e/${followUp.id}`);
  await page.getByRole('button', { name: 'Add record…' }).click();
  await page.getByLabel('Find a record').fill('Acme');
  await expect(page.getByRole('button', { name: /^Acme\b/ }).first()).toBeVisible();
  await expect(page.getByText('Acme kickoff')).toHaveCount(0);
  await page
    .getByRole('button', { name: /^Acme\b/ })
    .first()
    .click();
  await expect
    .poll(async () => (await r.request(`/events/${followUp.id}`)).event.about)
    .toEqual([acme.id]);
});
