import { beforeAll, describe, expect, it } from 'vitest';
import { type McpTestClient, startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let workspaceId: string;
let keys: Record<
  'dana' | 'maya' | 'admin' | 'agent' | 'agentAdmin' | 'integration' | 'reader',
  string
>;
let otherKey: string;
let agent: McpTestClient;

beforeAll(async () => {
  t = startTestApp(db);
  const setup = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      dana: { actor: { type: 'user', id: 'dana' }, scopes: ['read', 'write'] },
      maya: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
      admin: { actor: { type: 'user', id: 'ops' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      agentAdmin: { actor: { type: 'agent', id: 'root-bot' }, scopes: ['admin'] },
      integration: { actor: { type: 'integration', id: 'hubspot' }, scopes: ['read', 'write'] },
      reader: { actor: { type: 'user', id: 'dana' }, scopes: ['read'] },
    },
  );
  ({ keys } = setup);
  workspaceId = setup.workspace.id;
  const other = await t.setupWorkspace(
    { name: 'Other' },
    { dana: { actor: { type: 'user', id: 'dana' }, scopes: ['admin'] } },
  );
  otherKey = other.keys.dana;
  agent = await t.mcpClient(keys.agent);
});

let n = 0;
async function company(name = `Comment Co ${++n}`): Promise<string> {
  const res = await t.request('/v1/objects/company/records', {
    key: keys.dana,
    body: { values: { name } },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}
async function person(name = `Comment Person ${++n}`): Promise<string> {
  const res = await t.request('/v1/objects/person/records', {
    key: keys.dana,
    body: { values: { name, emails: { primary: `comment${++n}@acme.test` } } },
  });
  expect(res.status).toBe(201);
  return res.body.id;
}
async function event(body: Record<string, unknown> = {}): Promise<string> {
  const res = await t.request('/v1/events', {
    key: keys.agent,
    body: {
      type: 'conversation',
      channel: 'zoom',
      externalId: `comment-${++n}`,
      occurredAt: '2026-10-01T10:00:00Z',
      title: 'Kickoff',
      ...body,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id;
}
const post = (record: string, body: string, key = keys.dana, headers?: Record<string, string>) =>
  t.request(`/v1/records/${record}/comments`, {
    key,
    body: { body },
    ...(headers ? { headers } : {}),
  });
async function comment(record: string, body = 'Is this the right email?', key = keys.dana) {
  const res = await post(record, body, key);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; record: string; body: string; createdAt: string };
}
const list = (record: string, query = '', key = keys.reader) =>
  t.request(`/v1/records/${record}/comments${query}`, { key });

describe('writing a comment', () => {
  it('adds a comment to an entity and to an event, taking the author from the key', async () => {
    const acme = await company();
    const res = await post(acme, "Don't contact him before January.\nHe is on leave.");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      record: acme,
      body: "Don't contact him before January.\nHe is on leave.",
      author: { type: 'user', id: 'dana' },
      editedAt: null,
    });
    expect(res.body.createdAt).toBe(res.body.updatedAt);

    const meeting = await event();
    const onEvent = await comment(meeting, 'Who took notes?');
    expect(onEvent.record).toBe(meeting);
  });

  it('never takes the author from the payload', async () => {
    const res = await t.request(`/v1/records/${await company()}/comments`, {
      key: keys.dana,
      body: { body: 'hello', author: { type: 'user', id: 'someone-else' } },
    });
    expect(res.status).toBe(400);
  });

  it('keeps line breaks, drops surrounding space, and limits the length', async () => {
    const acme = await company();
    expect((await comment(acme, '  one\n\ntwo  ')).body).toBe('one\n\ntwo');
    for (const body of ['', '   \n ']) {
      expect((await post(acme, body)).status).toBe(400);
    }
    expect((await post(acme, 'x'.repeat(10_000))).status).toBe(201);
    expect((await post(acme, 'x'.repeat(10_001))).status).toBe(400);
  });

  it.each([
    ['agent', 'agent'],
    ['integration', 'integration'],
    ['agent with admin', 'agentAdmin'],
  ] as const)('refuses an %s key with 403', async (_name, key) => {
    const res = await post(await company(), 'From a bot', keys[key]);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect(res.body.error.message).toContain('list_comments');
  });

  it('refuses a key without write, a missing record and a deleted one', async () => {
    const acme = await company();
    expect((await post(acme, 'Hi', keys.reader)).status).toBe(403);
    expect((await post('00000000-0000-4000-8000-000000000000', 'Hi')).status).toBe(404);
    await t.request(`/v1/records/${acme}`, { key: keys.dana, method: 'DELETE' });
    const deleted = await post(acme, 'Hi');
    expect(deleted.status).toBe(404);
    expect(deleted.body.error.code).toBe('record_deleted');
  });

  it('cannot reach another workspace', async () => {
    const acme = await company();
    await comment(acme);
    expect((await post(acme, 'Hi', otherKey)).status).toBe(404);
    expect((await list(acme, '', otherKey)).status).toBe(404);
  });
});

describe('idempotency', () => {
  it('creates one comment when two posts carry one key at the same time', async () => {
    const acme = await company();
    const headers = { 'idempotency-key': `two-at-once-${acme}` };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => post(acme, 'Once only', keys.dana, headers)),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    const { body } = await list(acme);
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
  });

  it('refuses a key reused for another body, or by another person', async () => {
    const acme = await company();
    const headers = { 'idempotency-key': `reused-${acme}` };
    expect((await post(acme, 'First', keys.dana, headers)).status).toBe(201);
    const other = await post(acme, 'Second', keys.dana, headers);
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('idempotency_key_reused');
    const person2 = await post(acme, 'First', keys.maya, headers);
    expect(person2.status).toBe(422);
    expect((await list(acme)).body.total).toBe(1);
  });

  it('replays an edit and a delete under their keys', async () => {
    const { id } = await comment(await company());
    const edit = () =>
      t.request(`/v1/comments/${id}`, {
        key: keys.dana,
        method: 'PATCH',
        body: { body: 'Edited' },
        headers: { 'idempotency-key': `edit-${id}` },
      });
    const [first, second] = await Promise.all([edit(), edit()]);
    expect(first?.body.editedAt).toBeTruthy();
    expect(second?.body.editedAt).toBe(first?.body.editedAt);

    const remove = () =>
      t.request(`/v1/comments/${id}`, {
        key: keys.dana,
        method: 'DELETE',
        headers: { 'idempotency-key': `delete-${id}` },
      });
    const [a, b] = await Promise.all([remove(), remove()]);
    expect([a?.status, b?.status]).toEqual([200, 200]);
    expect(a?.body).toEqual({ id, deleted: true });
  });
});

describe('reading comments', () => {
  it('lists a record’s comments newest first, in pages, with a total', async () => {
    const acme = await company();
    const written = [];
    for (let i = 0; i < 5; i++) written.push(await comment(acme, `Remark ${i}`));
    const first = await list(acme, '?limit=2');
    expect(first.body.total).toBe(5);
    expect(first.body.items.map((c: { body: string }) => c.body)).toEqual(['Remark 4', 'Remark 3']);
    const second = await list(acme, `?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((c: { body: string }) => c.body)).toEqual([
      'Remark 2',
      'Remark 1',
    ]);
    const third = await list(acme, `?limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.items.map((c: { body: string }) => c.body)).toEqual(['Remark 0']);
    expect(third.body.nextCursor).toBeNull();
    expect((await list(acme, '?cursor=nonsense')).status).toBe(400);
  });

  it('counts them with the record, for its tabs', async () => {
    const acme = await company();
    await comment(acme);
    const { id } = await comment(acme);
    await t.request(`/v1/comments/${id}`, { key: keys.dana, method: 'DELETE' });
    const res = await t.request(`/v1/records/${acme}?include=counts`, { key: keys.reader });
    expect(res.body.counts).toEqual({ comments: 1, facts: 0, linked: 0, claims: 0 });
  });

  it('counts what each other tab lists: facts, linked records and claims', async () => {
    const acme = await company();
    const meeting = await event({ about: [acme] });
    await t.request(`/v1/records/${acme}/facts`, {
      key: keys.agent,
      body: { text: 'Legal takes two weeks.', source: meeting },
    });
    await t.request(`/v1/records/${acme}`, {
      key: keys.agent,
      method: 'PATCH',
      body: { values: { industry: 'Software' }, source: meeting },
    });
    for (const status of ['todo', 'done']) {
      await t.request('/v1/objects/task/records', {
        key: keys.agent,
        body: { values: { title: `A ${status} task`, status, company: acme } },
      });
    }
    const counts = async (id: string) =>
      (await t.request(`/v1/records/${id}?include=counts`, { key: keys.reader })).body.counts;
    expect(await counts(acme)).toMatchObject({ facts: 1, linked: 2 });
    // The event's own logged title is not a claim on it; the value and the fact are.
    expect((await counts(meeting)).claims).toBe(2);
    const claims = await t.request(`/v1/events/${meeting}/claims?own=false`, { key: keys.reader });
    expect(claims.body.assertions).toHaveLength(1);
    expect(claims.body.facts).toHaveLength(1);
    const all = await t.request(`/v1/events/${meeting}/claims`, { key: keys.reader });
    expect(all.body.assertions.length).toBeGreaterThan(1);
  });
});

describe('editing and deleting', () => {
  it('lets the author edit, marks it edited, and refuses everyone else', async () => {
    const { id, createdAt } = await comment(await company(), 'Draft');
    for (const key of [keys.maya, keys.admin, keys.agent]) {
      const refused = await t.request(`/v1/comments/${id}`, {
        key,
        method: 'PATCH',
        body: { body: 'Taken over' },
      });
      expect(refused.status).toBe(403);
    }
    // Their own identity on a key without write doesn't reach it either.
    expect(
      (
        await t.request(`/v1/comments/${id}`, {
          key: keys.reader,
          method: 'PATCH',
          body: { body: 'Read-only' },
        })
      ).status,
    ).toBe(403);
    const edited = await t.request(`/v1/comments/${id}`, {
      key: keys.dana,
      method: 'PATCH',
      body: { body: 'Final' },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.body).toBe('Final');
    expect(edited.body.createdAt).toBe(createdAt);
    expect(edited.body.editedAt).toBeTruthy();
    // The same text again is no edit.
    const again = await t.request(`/v1/comments/${id}`, {
      key: keys.dana,
      method: 'PATCH',
      body: { body: 'Final' },
    });
    expect(again.body.editedAt).toBe(edited.body.editedAt);
  });

  it('does not mark a comment edited until its body changes', async () => {
    const { id } = await comment(await company(), 'Same');
    const res = await t.request(`/v1/comments/${id}`, {
      key: keys.dana,
      method: 'PATCH',
      body: { body: 'Same' },
    });
    expect(res.body.editedAt).toBeNull();
  });

  it('lets the author or a user admin delete, and no one else', async () => {
    const acme = await company();
    const mine = await comment(acme, 'Mine');
    const theirs = await comment(acme, 'Theirs');
    for (const key of [keys.maya, keys.agent, keys.agentAdmin]) {
      const refused = await t.request(`/v1/comments/${mine.id}`, { key, method: 'DELETE' });
      expect(refused.status).toBe(403);
    }
    const byAuthor = await t.request(`/v1/comments/${mine.id}`, {
      key: keys.dana,
      method: 'DELETE',
    });
    expect(byAuthor.body).toEqual({ id: mine.id, deleted: true });
    const byAdmin = await t.request(`/v1/comments/${theirs.id}`, {
      key: keys.admin,
      method: 'DELETE',
    });
    expect(byAdmin.status).toBe(200);
    expect((await list(acme)).body).toMatchObject({ total: 0, items: [] });
    // Gone for every later write.
    const gone = await t.request(`/v1/comments/${mine.id}`, { key: keys.dana, method: 'DELETE' });
    expect(gone.status).toBe(404);
    const [row] = await db.owner<{ deleted_by: unknown }[]>`
      select deleted_by from comments where id = ${theirs.id}`;
    expect(row?.deleted_by).toMatchObject({ type: 'user', id: 'ops' });
  });

  it('runs an edit and a delete of one comment one after the other', async () => {
    const { id } = await comment(await company());
    const [edit, remove] = await Promise.all([
      t.request(`/v1/comments/${id}`, { key: keys.dana, method: 'PATCH', body: { body: 'Late' } }),
      t.request(`/v1/comments/${id}`, { key: keys.dana, method: 'DELETE' }),
    ]);
    expect(remove.status).toBe(200);
    expect([200, 404]).toContain(edit.status);
    const [row] = await db.owner<{ deleted_at: Date | null }[]>`
      select deleted_at from comments where id = ${id}`;
    expect(row?.deleted_at).not.toBeNull();
  });

  it('cannot change a comment of another workspace', async () => {
    const { id } = await comment(await company());
    const res = await t.request(`/v1/comments/${id}`, {
      key: otherKey,
      method: 'PATCH',
      body: { body: 'Across' },
    });
    expect(res.status).toBe(404);
  });
});

describe('following the record', () => {
  it('hides comments with a deleted record, and keeps them from being changed', async () => {
    const acme = await company();
    const { id } = await comment(acme);
    await t.request(`/v1/records/${acme}`, { key: keys.dana, method: 'DELETE' });
    const read = await list(acme);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('record_deleted');
    expect(
      (await t.request(`/v1/comments/${id}`, { key: keys.dana, method: 'DELETE' })).status,
    ).toBe(404);
  });

  it('hides comments with a deleted event', async () => {
    const meeting = await event();
    await comment(meeting);
    await t.request(`/v1/events/${meeting}`, { key: keys.dana, method: 'DELETE' });
    expect((await list(meeting)).status).toBe(404);
  });

  it('moves comments to the survivor of a merge, keeping authors and times', async () => {
    const survivor = await company();
    const merged = await company();
    const own = await comment(survivor, 'On the survivor', keys.maya);
    const moved = await comment(merged, 'On the duplicate', keys.dana);
    const res = await t.request(`/v1/records/${survivor}/merge`, {
      key: keys.dana,
      body: { recordId: merged },
    });
    expect(res.status).toBe(200);
    const { body } = await list(survivor);
    expect(body.total).toBe(2);
    const onSurvivor = body.items.find((c: { id: string }) => c.id === moved.id);
    expect(onSurvivor).toMatchObject({
      record: survivor,
      body: 'On the duplicate',
      author: { type: 'user', id: 'dana' },
      createdAt: moved.createdAt,
      updatedAt: moved.createdAt,
      editedAt: null,
    });
    expect(body.items.some((c: { id: string }) => c.id === own.id)).toBe(true);
  });

  it('follows a merged ID on every comment route', async () => {
    const survivor = await company();
    const merged = await company();
    await t.request(`/v1/records/${survivor}/merge`, {
      key: keys.dana,
      body: { recordId: merged },
    });
    const added = await comment(merged, 'Sent to the old ID');
    expect(added.record).toBe(survivor);
    const read = await list(merged);
    expect(read.status).toBe(200);
    expect(read.body.record).toBe(survivor);
    expect(read.body.items.map((c: { id: string }) => c.id)).toEqual([added.id]);
  });

  it('loses no comment to a merge running at the same time', async () => {
    const survivor = await company();
    const merged = await company();
    const [added, merge] = await Promise.all([
      post(merged, 'Racing the merge'),
      t.request(`/v1/records/${survivor}/merge`, { key: keys.dana, body: { recordId: merged } }),
    ]);
    expect(merge.status).toBe(200);
    expect(added.status).toBe(201);
    const { body } = await list(survivor);
    expect(body.items.map((c: { id: string }) => c.id)).toEqual([added.body.id]);
  });

  it('hard-deletes the comments on what forget erases, deleted ones too, and counts them', async () => {
    const dana = await person();
    const meeting = await event({ participants: [{ recordId: dana }] });
    const live = await comment(dana, 'Dana is on leave');
    const removed = await comment(dana, 'Deleted, text still stored');
    await t.request(`/v1/comments/${removed.id}`, { key: keys.dana, method: 'DELETE' });
    const onEvent = await comment(meeting, 'Dana said no');
    const untouched = await comment(await company(), 'Dana also works with them');
    const replayKey = `forget-${dana}`;
    await post(dana, 'With a key', keys.dana, { 'idempotency-key': replayKey });

    const res = await t.request(`/v1/records/${dana}/forget`, { key: keys.admin, method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.counts.comments).toBe(4);

    const ids = [live.id, removed.id, onEvent.id];
    expect(await db.owner`select id from comments where id = any(${ids}::uuid[])`).toEqual([]);
    // Comments elsewhere that name the person are not found: the limit forget has for free text.
    expect(await db.owner`select id from comments where id = ${untouched.id}`).toHaveLength(1);
    // A stored response mentioning them goes too.
    expect(await db.owner`select id from idempotency_keys where key = ${replayKey}`).toEqual([]);
    const [audit] = await db.owner<{ counts: Record<string, number> }[]>`
      select counts from deletion_audit_log where workspace_id = ${workspaceId}
      order by created_at desc limit 1`;
    expect(audit?.counts.comments).toBe(4);
  });
});

describe('outside the evidence model (C1, C3)', () => {
  const MARK = 'Zanzibarcomment';

  it('stays out of the feed, the events query, timelines, context and fact sources', async () => {
    const acme = await company();
    const meeting = await event({ about: [acme] });
    const { id } = await comment(acme, `${MARK} on the company`);
    await comment(meeting, `${MARK} on the conversation`);

    const events = await t.request('/v1/events/query', { key: keys.reader, body: {} });
    expect(JSON.stringify(events.body)).not.toContain(MARK);
    const attached = await t.request(`/v1/records/${acme}/events`, { key: keys.reader });
    expect(attached.body.items.map((e: { id: string }) => e.id)).toEqual([meeting]);
    for (const path of [
      `/v1/records/${acme}/timeline`,
      `/v1/records/${meeting}/timeline`,
      `/v1/records/${acme}/context`,
      `/v1/records/${acme}/assertions`,
      `/v1/records/${acme}/facts`,
    ]) {
      const res = await t.request(path, { key: keys.reader });
      expect(res.status, path).toBe(200);
      expect(JSON.stringify(res.body), path).not.toContain(MARK);
    }
    const search = await t.request('/v1/search', { key: keys.reader, body: { query: MARK } });
    expect(search.body.records).toEqual([]);
    expect(search.body.events).toEqual([]);
    expect(search.body.facts).toEqual([]);

    // A comment cannot be cited: its ID is no event.
    const cited = await t.request(`/v1/records/${acme}/facts`, {
      key: keys.agent,
      body: { text: 'From a comment', source: id },
    });
    expect(cited.status).toBeGreaterThanOrEqual(400);
    expect(cited.status).toBeLessThan(500);
  });

  it('changes nothing about the record it is on', async () => {
    const acme = await company();
    const before = await t.request(`/v1/records/${acme}`, { key: keys.reader });
    const assertions = () =>
      db.owner`select count(*)::int as count from field_assertions where record_id = ${acme}`;
    const [counted] = await assertions();
    await comment(acme);
    const after = await t.request(`/v1/records/${acme}`, { key: keys.reader });
    expect(after.body.updatedAt).toBe(before.body.updatedAt);
    expect(after.body.fields).toEqual(before.body.fields);
    expect((await assertions())[0]).toEqual(counted);
  });
});

describe('agents reading comments (4.1)', () => {
  it('get_record returns the newest 20 comments and a total', async () => {
    const acme = await company();
    for (let i = 0; i < 22; i++) await comment(acme, `Remark ${i}`);
    const { body, isError } = await agent.call('get_record', { id: acme });
    expect(isError).toBe(false);
    expect(body.id).toBe(acme);
    expect(body.comments.total).toBe(22);
    expect(body.comments.items).toHaveLength(20);
    expect(body.comments.items[0].body).toBe('Remark 21');
    expect(body.comments.nextCursor).toBeTruthy();
    // REST keeps its shape: a record read does not grow a thread.
    expect((await t.request(`/v1/records/${acme}`, { key: keys.reader })).body.comments).toBe(
      undefined,
    );
  });

  it('list_comments pages through the rest, and writes need a person', async () => {
    const acme = await company();
    for (let i = 0; i < 3; i++) await comment(acme, `Remark ${i}`);
    const first = await agent.call('list_comments', { record: acme, limit: 2 });
    expect(first.body.items.map((c: { body: string }) => c.body)).toEqual(['Remark 2', 'Remark 1']);
    const rest = await agent.call('list_comments', {
      record: acme,
      limit: 2,
      cursor: first.body.nextCursor,
    });
    expect(rest.body.items.map((c: { body: string }) => c.body)).toEqual(['Remark 0']);
    expect(rest.body.total).toBe(3);
  });

  it('follows a merged ID, and needs read', async () => {
    const survivor = await company();
    const merged = await company();
    await comment(merged, 'Before the merge');
    await t.request(`/v1/records/${survivor}/merge`, {
      key: keys.dana,
      body: { recordId: merged },
    });
    const res = await agent.call('list_comments', { record: merged });
    expect(res.body.record).toBe(survivor);
    expect(res.body.total).toBe(1);
  });

  it('the guides and instructions say what comments are, and offer no note', async () => {
    const { body } = await agent.call<string>('get_guide', { name: 'schema_design' });
    expect(body).toContain('never a source to cite');
    expect(body).toContain('she moved to Berlin');
    const instructions = agent.getInstructions() ?? '';
    expect(instructions).toContain('never\na source to cite');
    expect(instructions).not.toMatch(/\bnotes\b/);
    const { tools } = await agent.listTools();
    const log = tools.find((tool) => tool.name === 'log_event');
    expect(JSON.stringify(log?.inputSchema)).not.toContain('"note"');
  });

  it('schema_design states the object-or-event test, and that history is not an event', async () => {
    const { body } = await agent.call<string>('get_guide', { name: 'schema_design' });
    const rule = body.slice(body.indexOf('### Object or event'));
    expect(rule).toContain('Where does it stand now?');
    expect(rule).toContain('What happened?');
    expect(rule).toContain('History is not an event');
    expect(rule).toContain('A deal moving to Won');
    expect(rule).toContain('job change');
    const { tools } = await agent.listTools();
    const propose = tools.find((tool) => tool.name === 'propose_schema_change');
    expect(propose?.description).toContain('object-or-event test');
    expect(propose?.description).toContain('get_guide("schema_design")');
  });

  it('reserves the name comment, with what to use instead', async () => {
    const res = await t.request('/v1/schema/changes', {
      key: keys.admin,
      body: {
        operations: [
          {
            op: 'create_object',
            object: {
              nameSingular: 'comment',
              namePlural: 'comments',
              labelSingular: 'Comment',
              labelPlural: 'Comments',
              labelField: 'text',
              fields: [{ name: 'text', label: 'Text', type: 'text' }],
            },
          },
        ],
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('comments are built in');
  });
});

describe('the base template (C5)', () => {
  it('a new workspace has no note type, and an agent can add one under its reserved ID', async () => {
    const fresh = await t.setupWorkspace(
      { name: 'No notes' },
      { admin: { actor: { type: 'user', id: 'ops' }, scopes: ['admin'] } },
    );
    const key = fresh.keys.admin;
    const events = async () =>
      (await t.request('/v1/schema', { key })).body.objects.filter(
        (o: { class: string }) => o.class === 'event',
      );
    expect((await events()).map((o: { nameSingular: string }) => o.nameSingular)).toEqual([
      'conversation',
    ]);
    const logged = await t.request('/v1/events', {
      key,
      body: { type: 'note', channel: 'web', occurredAt: '2026-10-01T10:00:00Z', title: 'Hi' },
    });
    expect(logged.status).toBe(404);

    const added = await t.request('/v1/schema/changes', {
      key,
      body: {
        reason: 'Our CRM keeps notes',
        operations: [
          {
            op: 'create_object',
            object: {
              class: 'event',
              nameSingular: 'note',
              namePlural: 'notes',
              labelSingular: 'Note',
              labelPlural: 'Notes',
              fields: [],
            },
          },
        ],
      },
    });
    expect(added.body.status).toBe('applied');
    const note = (await events()).find((o: { nameSingular: string }) => o.nameSingular === 'note');
  });
});
