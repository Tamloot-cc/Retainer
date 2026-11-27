import { randomBytes } from 'node:crypto';
import type { WorkspaceFeedPage } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'user' | 'agent' | 'writeOnly' | 'readOnly', string>;
let other: string;
beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Home', template: 'sales' },
    {
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'sales' }, scopes: ['read', 'write'] },
      writeOnly: { actor: { type: 'agent', id: 'writer' }, scopes: ['write'] },
      readOnly: { actor: { type: 'user', id: 'reader' }, scopes: ['read'] },
    },
  ));
  other = (
    await t.setupWorkspace(
      { name: 'Other' },
      {
        user: { actor: { type: 'user', id: 'other' }, scopes: ['admin'] },
      },
    )
  ).keys.user;
});
const word = () => `home${randomBytes(6).toString('hex')}`;
async function create(name: string) {
  const response = await t.request('/v1/objects/person/records', {
    key: keys.user,
    body: { values: { name, jobTitle: 'Founder' } },
  });
  expect(response.status).toBe(201);
  return response.body.id as string;
}
const feed = (body: Record<string, unknown> = {}, key = keys.user) =>
  t.request<WorkspaceFeedPage>('/v1/feed/query', { key, body });

const revert = (
  item: WorkspaceFeedPage['items'][number],
  { key = keys.user, assertionIds = item.changes.map((change) => change.id) } = {},
) =>
  t.request(`/v1/feed/${item.id}/revert`, {
    key,
    body: { recordId: item.record.id, assertionIds },
  });

async function update(
  id: string,
  values: Record<string, unknown>,
  key = keys.user,
  source?: string,
) {
  const response = await t.request(`/v1/records/${id}`, {
    key,
    method: 'PATCH',
    body: { values, ...(source ? { source } : {}) },
  });
  expect(response.status).toBe(200);
  return response;
}

describe('workspace Home feed', () => {
  it('combines new records and conversations, and groups a write without repeating initial fields', async () => {
    const tag = word(),
      id = await create(tag);
    const event = await t.request('/v1/events', {
      key: keys.user,
      body: {
        type: 'conversation',
        title: 'Pricing discussion',
        channel: 'zoom',
        occurredAt: '2020-01-01T10:00:00Z',
        participants: [{ recordId: id }],
      },
    });
    expect(event.status).toBe(201);
    await update(id, { name: `${tag} Morgan`, jobTitle: 'CEO' });
    const response = await feed({ linked: id });
    expect(response.status).toBe(200);
    expect(response.body.items.map((item) => item.kind)).toEqual([
      'record_updated',
      'event',
      'record_created',
    ]);
    const [write, conversation, created] = response.body.items;
    expect(write?.changes.map((change) => change.field).sort()).toEqual(['jobTitle', 'name']);
    expect(write?.changes.every((change) => change.current)).toBe(true);
    expect(write?.canRevert).toBe(true);
    expect(created?.canRevert).toBeUndefined();
    expect(conversation?.canRevert).toBeUndefined();
    expect(created?.changes).toEqual([]);
    expect(conversation?.record.event?.occurredAt).toBe('2020-01-01T10:00:00.000Z');
    expect(conversation?.at).not.toBe(conversation?.record.event?.occurredAt);
    expect(response.body.references[id]?.label).toBe(`${tag} Morgan`);
  });

  it('keeps concurrent writes separate and never describes a superseded claim as current', async () => {
    const id = await create(word());
    await Promise.all([update(id, { jobTitle: 'CEO' }), update(id, { jobTitle: 'President' })]);
    const response = await feed({ linked: id, mode: 'records' });
    const writes = response.body.items.filter((item) => item.kind === 'record_updated');
    expect(writes).toHaveLength(2);
    expect(
      writes
        .flatMap((item) => item.changes)
        .map((change) => change.current)
        .sort(),
    ).toEqual([false, true]);
  });

  it('reverts a grouped update once, preserving newer values and the source event', async () => {
    const originalName = word();
    const id = await create(originalName);
    const event = await t.request('/v1/events', {
      key: keys.user,
      body: {
        type: 'conversation',
        title: 'A new role',
        channel: 'zoom',
        occurredAt: new Date().toISOString(),
        about: [id],
      },
    });
    expect(event.status).toBe(201);
    await update(id, { name: 'New name', jobTitle: 'CEO' }, keys.user, event.body.id);
    const [card] = (await feed({ linked: id })).body.items;
    expect(card?.kind).toBe('record_updated');
    if (!card) throw new Error('Expected a Home update');
    expect(card.changes).toHaveLength(2);
    await update(id, { jobTitle: 'President' });

    const results = await Promise.all([revert(card), revert(card)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 200)?.body).toEqual({
      id: card.id,
      retractedAssertions: 2,
    });
    const record = await t.request(`/v1/records/${id}`, { key: keys.user });
    expect(record.body.fields).toMatchObject({
      name: { first: originalName, last: '' },
      jobTitle: 'President',
    });
    const items = (await feed({ linked: id })).body.items;
    expect(items.map((item) => item.kind)).toEqual(['record_updated', 'event', 'record_created']);
    expect(items.map((item) => item.id)).not.toContain(card.id);
    expect(items.some((item) => item.id === event.body.id)).toBe(true);
    const assertions = await db.owner<{ status: string }[]>`
      select status from field_assertions where id=any(${card.changes.map((c) => c.id)}::uuid[])`;
    expect(assertions.map((assertion) => assertion.status)).toEqual(['retracted', 'retracted']);
  });

  it('requires a writable person and rejects incomplete or unrelated assertions as one unit', async () => {
    const id = await create(word());
    await update(id, { jobTitle: 'CEO' });
    await update(id, { name: 'Renamed', jobTitle: 'President' });
    const [card, older, created] = (await feed({ linked: id })).body.items;
    if (!card || !older || !created) throw new Error('Expected two updates and a creation');
    expect(card.changes).toHaveLength(2);
    expect((await revert(card, { key: keys.agent })).status).toBe(403);
    expect((await revert(card, { key: keys.writeOnly })).status).toBe(403);
    expect((await revert(card, { key: keys.readOnly })).status).toBe(403);
    expect((await feed({ linked: id }, keys.readOnly)).body.items[0]?.canRevert).toBeUndefined();
    expect((await revert(card, { key: other })).status).toBe(409);
    expect((await revert(card, { assertionIds: [card.id] })).status).toBe(409);
    expect((await revert(card, { assertionIds: [card.id, older.id] })).status).toBe(409);
    expect((await revert(created, { assertionIds: [card.id] })).status).toBe(409);
    expect((await feed({ linked: id })).body.items.map((item) => item.id)).toEqual([
      card.id,
      older.id,
      created.id,
    ]);
  });

  it('requires a fresh card when retracting another update changes its displayed fields', async () => {
    const id = await create(word());
    await update(id, { jobTitle: 'CEO' });
    await update(id, { name: 'Renamed', jobTitle: 'CEO' });
    const [newer, older] = (await feed({ linked: id })).body.items;
    if (!newer || !older) throw new Error('Expected two updates');
    expect(newer.changes.map((change) => change.field)).toEqual(['name']);
    expect((await revert(older)).status).toBe(200);

    const stale = await revert(newer);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_update');
    const [refreshed] = (await feed({ linked: id })).body.items;
    if (!refreshed) throw new Error('Expected the remaining update');
    expect(refreshed.changes.map((change) => change.field).sort()).toEqual(['jobTitle', 'name']);
    expect((await revert(refreshed)).status).toBe(200);
  });

  it('leaves pending proposals in Review, hides deleted records, and enforces workspace and read scopes', async () => {
    const tag = word(),
      id = await create(tag);
    await update(id, { jobTitle: 'Unapproved title' }, keys.agent);
    expect((await feed({ linked: id })).body.items).toHaveLength(1);
    expect((await feed({ query: tag }, other)).body.items).toEqual([]);
    expect((await feed({}, keys.writeOnly)).status).toBe(403);
    await t.request(`/v1/records/${id}`, { key: keys.user, method: 'DELETE' });
    expect((await feed({ linked: id })).body.items).toEqual([]);
    // Workspace memory is stored on hidden profiles/internal notes, never Home cards.
    await t.request('/v1/records/workspace/facts', { key: keys.user, body: { text: tag } });
    expect((await feed({ query: tag })).body.items).toEqual([]);
  });

  it('omits repeated values and shows an accepted proposal once with the reviewer attribution', async () => {
    const id = await create(word());
    await update(id, { jobTitle: 'Founder' });
    expect((await feed({ linked: id })).body.items).toHaveLength(1);
    await update(id, { jobTitle: 'CEO' }, keys.agent);
    const pending = await t.request('/v1/review', { key: keys.user });
    const assertion = pending.body.pendingAssertions.find(
      (item: { recordId: string }) => item.recordId === id,
    );
    expect(assertion).toBeTruthy();
    const accepted = await t.request(`/v1/assertions/${assertion.id}/accept`, {
      key: keys.user,
      body: {},
    });
    expect(accepted.status).toBe(200);
    const items = (await feed({ linked: id })).body.items;
    expect(items.map((item) => item.kind)).toEqual(['record_updated', 'record_created']);
    expect(items[0]?.changes).toHaveLength(1);
    expect(items[0]?.actor.type).toBe('user');
  });

  it('filters types, source, dates and search, and binds cursors to the workspace and filters', async () => {
    const tag = word();
    for (let i = 0; i < 3; i++) await create(`${tag} Person ${i}`);
    const first = await feed({ query: tag, limit: 1 });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await feed({ query: tag, limit: 1, cursor: first.body.nextCursor });
    expect(second.body.items[0]?.id).not.toBe(first.body.items[0]?.id);
    expect((await feed({ query: tag, cursor: first.body.nextCursor }, other)).status).toBe(400);
    expect((await feed({ query: tag, mode: 'events', cursor: first.body.nextCursor })).status).toBe(
      400,
    );
    expect((await feed({ cursor: 'broken' })).status).toBe(400);
    expect((await feed({ types: ['missing'] })).status).toBe(400);
    expect((await feed({ query: tag, types: ['company'] })).body.items).toEqual([]);
    expect((await feed({ query: tag, channel: 'zoom' })).body.items).toEqual([]);
    expect((await feed({ query: tag, to: '2000-01-01T00:00:00Z' })).body.items).toEqual([]);
    expect((await feed({ query: tag, from: '2100-01-01T00:00:00Z' })).body.items).toEqual([]);
  });

  it('keeps a saved linked-record filter working after that record is merged', async () => {
    const survivor = await create(word());
    const merged = await create(word());
    const event = await t.request('/v1/events', {
      key: keys.user,
      body: {
        type: 'conversation',
        title: 'Conversation before merge',
        channel: 'zoom',
        occurredAt: new Date().toISOString(),
        about: [merged],
      },
    });
    const result = await t.request(`/v1/records/${survivor}/merge`, {
      key: keys.user,
      body: { recordId: merged },
    });
    expect(result.status).toBe(200);
    await update(survivor, { jobTitle: 'CEO' });
    const canonical = await feed({ linked: survivor });
    const bookmarked = await feed({ linked: merged });
    expect(bookmarked.status).toBe(200);
    expect(bookmarked.body).toEqual(canonical.body);
    expect(bookmarked.body.items.some((item) => item.record.id === event.body.id)).toBe(true);
    expect(
      bookmarked.body.items.some(
        (item) => item.kind === 'record_updated' && item.record.id === survivor,
      ),
    ).toBe(true);
    const assertionIds = bookmarked.body.items.flatMap((item) => item.changes.map((c) => c.id));
    expect(
      await db.owner`select id from field_assertions where id=any(${assertionIds}::uuid[]) and is_initial`,
    ).toHaveLength(0);
  });

  it('pages equal microsecond timestamps exactly once', async () => {
    const tag = word();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const event = await t.request('/v1/events', {
        key: keys.user,
        body: {
          type: 'conversation',
          title: `${tag} ${i}`,
          channel: 'zoom',
          occurredAt: '2020-01-01T10:00:00Z',
        },
      });
      ids.push(event.body.id);
    }
    await db.owner`update records set created_at='2026-01-01 12:00:00.123456+00' where id=any(${ids}::uuid[])`;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await feed({ query: tag, limit: 1, ...(cursor ? { cursor } : {}) });
      expect(response.status).toBe(200);
      seen.push(...response.body.items.map((item) => item.id));
      cursor = response.body.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...ids].sort().reverse());
  });
});
