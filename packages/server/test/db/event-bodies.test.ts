import { randomUUID } from 'node:crypto';
import type { Actor } from '@retainer/shared';
import { expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { type EventBody, joinEventThreads, storeEventBody } from '../../src/memory/event-bodies.js';
import { withWrite } from '../../src/records/service.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const admin: Actor = { type: 'user', id: 'admin' };

async function setup() {
  const app = startTestApp(db);
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Event bodies ${randomUUID()}` },
    { admin: { actor: admin, scopes: ['admin'] } },
  );
  const caller: Caller = { workspaceId: workspace.id, actor: admin, scopes: ['admin'] };
  async function log(title: string, occurredAt: string) {
    const logged = await app.request('/v1/events', {
      key: keys.admin,
      body: {
        type: 'conversation',
        channel: 'test',
        externalId: randomUUID(),
        occurredAt,
        title,
      },
    });
    expect(logged.status, JSON.stringify(logged.body)).toBe(201);
    return logged.body.id as string;
  }
  function store(body: Omit<EventBody, 'occurredAt'> & { occurredAt: string }) {
    return withWrite(app.sql, caller, (tx) =>
      storeEventBody(tx, workspace.id, { ...body, occurredAt: new Date(body.occurredAt) }),
    );
  }
  const content = (id: string, after?: string) =>
    app.request(`/v1/events/${id}/content${after ? `?after=${after}` : ''}`, { key: keys.admin });
  const search = (query: string) => app.request('/v1/search', { key: keys.admin, body: { query } });
  return { app, workspace, keys, caller, log, store, content, search };
}

it('reads a thread from any of its events, oldest first, a page at a time', async () => {
  const h = await setup();
  const thread = randomUUID();
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const at = `2026-11-0${i + 1}T10:00:00.000Z`;
    const id = await h.log(`Message ${i}`, at);
    await h.store({ eventId: id, threadId: thread, occurredAt: at, body: `Body ${i}` });
    ids.push(id);
  }
  const first = await h.content(ids[6] as string);
  expect(first.status).toBe(200);
  expect(first.body.parts.map((p: { text: string }) => p.text)).toEqual([
    'Body 0',
    'Body 1',
    'Body 2',
    'Body 3',
    'Body 4',
  ]);
  expect(first.body.nextAfter).toBe(ids[4]);
  const second = await h.content(ids[0] as string, first.body.nextAfter);
  expect(second.body).toMatchObject({ nextAfter: null });
  expect(second.body.parts.map((p: { id: string }) => p.id)).toEqual([ids[5], ids[6]]);

  // A cursor from another event's content is refused rather than silently ignored.
  const other = await h.log('Standalone', '2026-11-20T10:00:00Z');
  await h.store({ eventId: other, threadId: null, occurredAt: '2026-11-20T10:00:00Z', body: 'x' });
  expect((await h.content(other, ids[0])).status).toBe(404);
  expect((await h.content(other, 'not-a-uuid')).status).toBe(400);
});

it('finds a thread by the text of an older message and shows it as its newest event', async () => {
  const h = await setup();
  const thread = randomUUID();
  const older = await h.log('Pricing', '2026-11-01T10:00:00Z');
  const newer = await h.log('Re: Pricing', '2026-11-02T10:00:00Z');
  await h.store({
    eventId: older,
    threadId: thread,
    occurredAt: '2026-11-01T10:00:00Z',
    body: 'We could discount the quokka plan by ten percent.',
  });
  await h.store({
    eventId: newer,
    threadId: thread,
    occurredAt: '2026-11-02T10:00:00Z',
    body: 'Sounds good.',
  });
  const found = await h.search('quokka');
  expect(found.body.events).toEqual([
    expect.objectContaining({ id: newer, title: 'Re: Pricing', match: 'content' }),
  ]);
  // A title match ranks above a match in the full text only.
  const titled = await h.log('Quokka renewal', '2026-10-01T10:00:00Z');
  const ranked = await h.search('quokka');
  expect(ranked.body.events.map((e: { id: string }) => e.id)).toEqual([titled, newer]);
  expect(
    (await h.app.request(`/v1/events/${older}`, { key: h.keys.admin })).body.event,
  ).toMatchObject({ content: true });
});

it('joins threads, keeps a body immutable and isolates content by workspace', async () => {
  const h = await setup();
  const [a, b] = [randomUUID(), randomUUID()];
  const one = await h.log('One', '2026-11-01T10:00:00Z');
  const two = await h.log('Two', '2026-11-02T10:00:00Z');
  await h.store({ eventId: one, threadId: a, occurredAt: '2026-11-01T10:00:00Z', body: 'First' });
  await h.store({ eventId: two, threadId: b, occurredAt: '2026-11-02T10:00:00Z', body: 'Second' });
  // Storing again keeps the first body.
  await h.store({ eventId: one, threadId: a, occurredAt: '2026-11-01T10:00:00Z', body: 'Changed' });
  await withWrite(h.app.sql, h.caller, (tx) => joinEventThreads(tx, h.workspace.id, a, [b]));
  const page = await h.content(two);
  expect(page.body.parts.map((p: { text: string }) => p.text)).toEqual(['First', 'Second']);

  const other = await setup();
  expect((await other.content(one)).status).toBe(404);
  expect((await other.search('first')).body.events).toEqual([]);
});

it('builds search text in the migration the way the write path does', async () => {
  const h = await setup();
  const id = await h.log('Accents', '2026-11-01T10:00:00Z');
  const body = 'José met Zoë at the Café, re: Ünïcode-tests & dana@acme.com';
  await h.store({ eventId: id, threadId: null, occurredAt: '2026-11-01T10:00:00Z', body });
  // Migration 0129 copies Gmail bodies with this expression.
  const [row] = await db.owner<{ same: boolean }[]>`
    select search = to_tsvector('simple', retainer_fold(body::text)) as same
    from event_bodies where event_id=${id}`;
  expect(row?.same).toBe(true);
  expect((await h.search('jose')).body.events).toEqual([
    expect.objectContaining({ id, match: 'content' }),
  ]);
});

it('lists an event whose full text names a forgotten person for review', async () => {
  const h = await setup();
  const person = await h.app.request('/v1/objects/person/records', {
    key: h.keys.admin,
    body: { values: { name: 'Rina Cohen', emails: 'rina@erased.test' } },
  });
  expect(person.status).toBe(201);
  const byName = await h.log('Standup', '2026-11-01T10:00:00Z');
  const byEmail = await h.log('Notes', '2026-11-02T10:00:00Z');
  const unrelated = await h.log('Other', '2026-11-03T10:00:00Z');
  for (const [id, body] of [
    [byName, 'Then Rina Cohen asked about the renewal.'],
    [byEmail, 'Forwarded from rina@erased.test'],
    [unrelated, 'Nothing about anyone.'],
  ] as const)
    await h.store({ eventId: id, threadId: null, occurredAt: '2026-11-01T10:00:00Z', body });
  const forgotten = await h.app.request(`/v1/records/${person.body.id}/forget`, {
    key: h.keys.admin,
    body: {},
  });
  expect(forgotten.status, JSON.stringify(forgotten.body)).toBe(200);
  expect([...forgotten.body.reviewCandidates.events].sort()).toEqual([byName, byEmail].sort());
});
