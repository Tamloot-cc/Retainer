import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useTestDatabase } from '../helpers/db.js';
import { setupGmailEvidence } from '../helpers/gmail-evidence.js';

const db = useTestDatabase();
const setup = () => setupGmailEvidence(db);

it('atomically imports, deduplicates across mailboxes and preserves both citation paths on a late thread join', async () => {
  const h = await setup();
  const [one, two] = await Promise.all([h.mailbox('one'), h.mailbox('two')]);
  expect(await h.save(one)).toEqual({ kind: 'no_match' });
  await h.person('dana@example.com');
  const [first, replay] = await Promise.all([h.save(one), h.save(one)]);
  expect(first.kind).toBe('imported');
  expect(replay.kind).toBe('imported');
  if (first.kind !== 'imported' || replay.kind !== 'imported') throw new Error('missing evidence');
  expect(first.messageId).toBe(replay.messageId);
  expect([first.created, replay.created].sort()).toEqual([false, true]);
  const second = await h.save(two, {
    messageId: 'message-b',
    threadId: 'thread-b',
    rfcMessageId: '<message-b@example.com>',
    occurredAt: '2026-01-05T12:00:00Z',
    body: 'Follow-up body.',
  });
  if (second.kind !== 'imported') throw new Error('missing reply');
  const overlap = await h.save(two, { messageId: 'overlap-a', threadId: 'thread-b' });
  expect(overlap).toEqual({
    kind: 'imported',
    messageId: first.messageId,
    eventId: second.messageId,
    created: false,
  });
  const active = await h.app.request('/v1/events/query', {
    key: h.keys.admin,
    body: { filter: { type: { eq: 'conversation' } } },
  });
  expect(active.status).toBe(200);
  const current = active.body.records;
  expect(current).toHaveLength(1);
  const page = await h.app.request(`/v1/events/${first.messageId}/content`, {
    key: h.keys.admin,
  });
  expect(page.status).toBe(200);
  expect(page.body.parts.map((part: { id: string }) => part.id)).toEqual([
    first.messageId,
    second.messageId,
  ]);
  expect(await db.owner`select 1 from gmail_deliveries where workspace_id=${h.ws}`).toHaveLength(3);
  expect((await h.app.request(`/v1/events/${first.messageId}`, { key: h.keys.admin })).status).toBe(
    200,
  );
  const removed = await h.app.request(`/v1/events/${second.messageId}`, {
    key: h.keys.admin,
    method: 'DELETE',
  });
  expect(removed.status).toBe(200);
  expect(
    (await h.app.request(`/v1/events/${first.messageId}/content`, { key: h.keys.admin })).status,
  ).toBe(404);
  expect(await h.save(two, { messageId: 'late-message', threadId: 'thread-b' })).toEqual({
    kind: 'removed',
  });
});

it('checks targeted matches during the write and isolates Gmail evidence across workspaces', async () => {
  const h = await setup();
  const mailbox = await h.mailbox('one');
  const person = await h.person('dana@example.com');
  expect(
    await h.save(mailbox, { targetEmail: 'dana@example.com', targetPersonId: randomUUID() }),
  ).toEqual({ kind: 'no_match' });
  const result = await h.save(mailbox, { targetEmail: 'dana@example.com', targetPersonId: person });
  if (result.kind !== 'imported') throw new Error('missing evidence');
  const other = await setup();
  expect(
    (await h.app.request(`/v1/events/${result.eventId}/content`, { key: other.keys.admin })).status,
  ).toBe(404);
});

it('uses a custom email type without moving an older duplicate or joining its thread', async () => {
  const h = await setup();
  await h.person('dana@example.com');
  const original = await h.save(await h.mailbox('original'));
  if (original.kind !== 'imported') throw new Error('missing original message');
  const changed = await h.app.request('/v1/schema/changes', {
    key: h.keys.admin,
    body: {
      operations: [
        {
          op: 'create_object',
          object: {
            class: 'event',
            nameSingular: 'mail',
            namePlural: 'mailMessages',
            labelSingular: 'Mail',
            labelPlural: 'Mail messages',
            fields: [
              {
                name: 'medium',
                label: 'Medium',
                type: 'select',
                settings: { options: [{ value: 'email', label: 'Email' }] },
              },
            ],
          },
        },
      ],
    },
  });
  expect(changed.status).toBe(200);
  const mailbox = { ...(await h.mailbox('new-destination')), plan: await h.planFor('mail') };
  const duplicate = await h.save(mailbox, { messageId: 'duplicate-a' });
  expect(duplicate).toEqual({ ...original, created: false });
  const reply = await h.save(mailbox, {
    messageId: 'reply-a',
    rfcMessageId: '<reply-a@example.com>',
    occurredAt: '2026-01-05T12:00:00Z',
    subject: 'Reply',
  });
  if (reply.kind !== 'imported') throw new Error('missing reply');
  const deliveries = await db.owner`
    select o.name_singular, b.thread_id from event_bodies b
    join records r on r.id=b.event_id join object_types o on o.id=r.object_type_id
    where b.workspace_id=${h.ws} order by b.occurred_at`;
  expect(deliveries.map((item) => item.name_singular)).toEqual(['conversation', 'mail']);
  expect(deliveries[0]?.thread_id).not.toBe(deliveries[1]?.thread_id);
});

it('accepts a non-unique match field and skips an ambiguous email', async () => {
  const h = await setup();
  const mailbox = await h.mailbox('one');
  const changed = await h.app.request('/v1/schema/changes', {
    key: h.keys.admin,
    body: {
      operations: [{ op: 'update_field', object: 'person', field: 'emails', isUnique: false }],
    },
  });
  expect(changed.status).toBe(200);
  await h.person('dana@example.com');
  await h.person('dana@example.com');
  expect(await h.save(mailbox)).toEqual({ kind: 'no_match' });
});
