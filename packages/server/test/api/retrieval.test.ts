import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let t: TestApp;
let keys: Record<'agent' | 'user', string>;
let otherKey: string;

beforeAll(async () => {
  t = startTestApp(db);
  ({ keys } = await t.setupWorkspace(
    { name: 'Acme Sales', template: 'sales' },
    {
      agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
      user: { actor: { type: 'user', id: 'maya' }, scopes: ['read', 'write'] },
    },
  ));
  const other = await t.setupWorkspace(
    { name: 'Other' },
    { agent: { actor: { type: 'agent', id: 'other' }, scopes: ['read', 'write'] } },
  );
  otherKey = other.keys.agent;
});

/** A word no other test uses, so tests sharing the workspace do not see each other's rows. */
const word = () => `w${randomBytes(4).toString('hex')}`;

const create = async (object: string, values: Record<string, unknown>, key = keys.agent) => {
  const res = await t.request(`/v1/objects/${object}/records`, { key, body: { values } });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const logEvent = async (body: Record<string, unknown>, key = keys.agent) => {
  const res = await t.request('/v1/events', {
    key,
    body: {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: '2026-10-29T14:00:00+02:00',
      ...body,
    },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
};

const rememberFact = async (record: string, text: string, source?: string, key = keys.agent) => {
  const res = await t.request(`/v1/records/${record}/facts`, {
    key,
    body: { text, ...(source ? { source } : {}) },
  });
  expect(res.status).toBe(201);
  return res.body.fact.id as string;
};

const search = (body: Record<string, unknown>, key = keys.agent) =>
  t.request('/v1/search', { key, body });

describe('POST /v1/search', () => {
  it('optionally includes identifying details and visible record context without changing the default response', async () => {
    const tag = word();
    const email = `${tag}@acme.test`;
    const dana = await create('person', { name: `Dana ${tag}`, emails: email });
    const company = await create('company', { name: `Acme ${tag}`, domain: `https://${tag}.test` });
    const foreign = await create(
      'person',
      { name: `Foreign ${tag}`, emails: `${tag}@other.test` },
      otherKey,
    );
    const call = await logEvent({
      title: `Call ${tag}`,
      participants: [{ recordId: dana }],
      about: [company],
    });
    await rememberFact(dana, `Prefers email ${tag}`, call);
    const plain = await search({ query: tag });
    expect(plain.body.references).toBeUndefined();
    expect(plain.body.records.every((r: any) => r.detail === undefined)).toBe(true);
    const rich = await search({ query: tag, includeContext: true });
    expect(rich.status).toBe(200);
    expect(rich.body.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: dana, detail: email }),
        expect.objectContaining({ id: company, detail: `https://${tag}.test` }),
      ]),
    );
    expect(rich.body.references).toEqual({
      [dana]: { id: dana, object: 'person', label: `Dana ${tag}` },
      [company]: { id: company, object: 'company', label: `Acme ${tag}` },
    });
    expect(JSON.stringify(rich.body)).not.toContain(foreign);
    expect(JSON.stringify(rich.body)).not.toContain('object_type_id');
    expect(rich.body.records.every((r: any) => r.data === undefined)).toBe(true);
  });
  it('finds records, facts and events, grouped by type with their record IDs', async () => {
    const tag = word();
    const email = `${tag}@acme.test`;
    const dana = await create('person', { name: `Dana ${tag}`, emails: email });
    const call = await logEvent({
      title: `Renewal call ${tag}`,
      summary: 'Talked about pricing.',
      participants: [{ handle: email }, { handle: 'nobody@acme.test' }],
    });
    const fact = await rememberFact(dana, `Legal review ${tag} takes two weeks.`, call);

    const res = await search({ query: tag });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      records: [{ id: dana, object: 'person', label: `Dana ${tag}`, match: 'text' }],
      facts: [
        {
          id: fact,
          record: dana,
          content: `Legal review ${tag} takes two weeks.`,
          validFrom: '2026-10-29T12:00:00.000Z',
        },
      ],
      events: [
        {
          id: call,
          type: 'conversation',
          occurredAt: '2026-10-29T12:00:00.000Z',
          title: `Renewal call ${tag}`,
          summary: 'Talked about pricing.',
          records: [dana],
        },
      ],
    });
  });

  it('supports quoted phrases, OR and -word', async () => {
    const [a, b] = [word(), word()];
    const one = await create('company', { name: `${a} alpha` });
    const two = await create('company', { name: `${a} beta` });
    const three = await create('company', { name: `${b} gamma` });
    const ids = async (query: string) =>
      ((await search({ query })).body.records as { id: string; match: string }[])
        .filter((r) => r.match === 'text')
        .map((r) => r.id)
        .sort();

    expect(await ids(`${a} -beta`)).toEqual([one]);
    expect(await ids(`"${a} beta"`)).toEqual([two]);
    expect(await ids(`"beta ${a}"`)).toEqual([]);
    expect(await ids(`${a} OR ${b}`)).toEqual([one, two, three].sort());
    // No stemming: a word does not match a shorter one.
    expect(await ids(`${a}s`)).toEqual([]);
  });

  it('matches every word as a prefix, ranking exact matches first', async () => {
    const tag = word();
    const exact = await create('company', { name: tag });
    const longer = await create('company', { name: `${tag}corp` });
    const ids = async (query: string) =>
      ((await search({ query })).body.records as { id: string; match: string }[])
        .filter((r) => r.match === 'text')
        .map((r) => r.id);

    // The newer record would come first on a tie; the exact one wins.
    expect(await ids(tag)).toEqual([exact, longer]);
    expect((await ids(tag.slice(0, -2))).sort()).toEqual([exact, longer].sort());
    expect(await ids(`${tag}co`)).toEqual([longer]);
    // Every word must match: one that starts no word excludes the hit.
    expect(await ids(`${tag} zz${tag}`)).toEqual([]);

    const call = await logEvent({ title: `Kickoff ${tag}meetings` });
    const dana = await create('person', { name: `Dana ${word()}` });
    await rememberFact(dana, `Prefers ${tag}meetings in person`, call);
    const res = await search({ query: `${tag}meet` });
    expect(res.body.events.map((i: { id: string }) => i.id)).toEqual([call]);
    expect(res.body.facts.map((f: { record: string }) => f.record)).toEqual([dana]);
  });

  it('ignores accents in the query and the stored text', async () => {
    const tag = word();
    const accented = await create('person', { name: `José Muñoz${tag}` });
    const plain = await create('person', { name: `Jose Munoz${tag}` });
    const ids = async (query: string) =>
      ((await search({ query })).body.records as { id: string; match: string }[])
        .map((r) => `${r.id}:${r.match}`)
        .sort();
    const both = [`${accented}:text`, `${plain}:text`].sort();
    expect(await ids(`jose munoz${tag}`)).toEqual(both);
    expect(await ids(`JOSÉ MUÑOZ${tag}`)).toEqual(both);

    await rememberFact(accented, `Wants the café ${tag} package`);
    const res = await search({ query: `cafe ${tag}` });
    expect(res.body.facts.map((f: { record: string }) => f.record)).toEqual([accented]);
  });

  it('finds a record by the domain of its emails and links', async () => {
    const tag = word();
    const person = await create('person', { name: word(), emails: `dana@${tag}.example` });
    const company = await create('company', {
      name: word(),
      domain: `https://www.${tag}.example/pricing`,
    });
    const ids = async (query: string) =>
      ((await search({ query })).body.records as { id: string }[]).map((r) => r.id).sort();
    expect(await ids(tag)).toEqual([person, company].sort());
    expect(await ids(`${tag}.example`)).toEqual([person, company].sort());
  });

  it('ranks short, precise matches first and honors the limit', async () => {
    const tag = word();
    const long = await create('company', {
      name: `${tag} ${Array.from({ length: 40 }, (_, i) => `filler${i}`).join(' ')}`,
    });
    const short = await create('company', { name: `${tag} ${tag}` });
    const res = await search({ query: tag, limit: 1 });
    expect(res.body.records.map((r: { id: string }) => r.id)).toEqual([short]);
    const both = await search({ query: tag });
    expect(both.body.records.map((r: { id: string }) => r.id)).toEqual([short, long]);
  });

  it('falls back to similar labels only when no record matches word for word', async () => {
    const tag = word();
    const dana = await create('person', { name: `Dana Levi${tag}` });
    const res = await search({ query: `Dana Levy${tag}` });
    expect(res.body.records).toEqual([
      { id: dana, object: 'person', label: `Dana Levi${tag}`, match: 'similar_label' },
    ]);
    // A word-for-word hit wins outright; similar labels are not added to it.
    const exact = await create('person', { name: `Dana Levy${tag}` });
    const again = await search({ query: `Dana Levy${tag}` });
    expect(again.body.records.map((r: { id: string }) => r.id)).toEqual([exact]);
  });

  it('hides deleted records, retracted facts and events, and facts with no live source', async () => {
    const tag = word();
    const email = `${tag}@acme.test`;
    const person = await create('person', { name: `Gone ${tag}`, emails: email });
    const kept = await create('company', { name: `Kept ${tag}` });
    const call = await logEvent({ title: `Call ${tag}`, participants: [{ handle: email }] });
    await rememberFact(kept, `Cited ${tag}`, call);
    const retracted = await rememberFact(kept, `Retracted ${tag}`);
    await rememberFact(person, `About the deleted ${tag}`);

    expect(
      (await t.request(`/v1/facts/${retracted}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    expect(
      (await t.request(`/v1/records/${person}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    let res = await search({ query: tag });
    expect(res.body.records.map((r: { id: string }) => r.id)).toEqual([kept]);
    expect(res.body.facts.map((f: { content: string }) => f.content)).toEqual([`Cited ${tag}`]);
    // The call stays; its deleted participant is no longer listed.
    expect(res.body.events).toMatchObject([{ id: call, records: [] }]);

    expect(
      (await t.request(`/v1/events/${call}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    res = await search({ query: tag });
    expect(res.body.events).toEqual([]);
    expect(res.body.facts).toEqual([]);
  });

  it('lists the records an event links, as participants and about, in order', async () => {
    const tag = word();
    const email = `${word()}@acme.test`;
    const dana = await create('person', { name: word(), emails: email });
    const acme = await create('company', { name: word() });
    const call = await logEvent({
      title: `Pricing ${tag}`,
      participants: [{ handle: email }, { recordId: dana }],
      about: [acme, dana],
    });
    const meeting = await logEvent({ type: 'conversation', summary: `Kickoff ${tag}` });
    const res = await search({ query: tag });
    expect(res.body.records).toEqual([]);
    expect(res.body.events).toEqual([
      expect.objectContaining({ id: call, type: 'conversation', records: [dana, acme] }),
      expect.objectContaining({
        id: meeting,
        type: 'conversation',
        title: null,
        summary: `Kickoff ${tag}`,
        records: [],
      }),
    ]);
  });

  it('never lists internal notes: their text is found with the fact', async () => {
    const tag = word();
    const dana = await create('person', { name: word() });
    const fact = await rememberFact(dana, `Uncited ${tag} detail`);
    const res = await search({ query: tag });
    expect(res.body).toEqual({
      records: [],
      facts: [expect.objectContaining({ id: fact, record: dana })],
      events: [],
    });
    // Once the fact is retracted, nothing finds the note's text.
    await t.request(`/v1/facts/${fact}`, { key: keys.agent, method: 'DELETE' });
    expect((await search({ query: tag })).body).toEqual({ records: [], facts: [], events: [] });
  });

  it("never returns another workspace's rows", async () => {
    const tag = word();
    await create('company', { name: `Private ${tag}` });
    const res = await search({ query: tag }, otherKey);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ records: [], facts: [], events: [] });
  });

  it('reserves the channel of remember notes, so no logged event is hidden as one', async () => {
    const res = await t.request('/v1/events', {
      key: keys.agent,
      body: { type: 'note', channel: 'retainer', occurredAt: '2026-10-29T14:00:00+02:00' },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('reserved');
  });

  it('validates the body and needs a key', async () => {
    expect((await search({ query: '   ' })).status).toBe(400);
    expect((await search({ query: 'x', limit: 51 })).status).toBe(400);
    expect((await search({ query: 'x', object: 'person' })).status).toBe(400);
    expect((await t.request('/v1/search', { body: { query: 'x' } })).status).toBe(401);
    // A query with no words is valid and matches nothing.
    expect((await search({ query: '!!!' })).body).toEqual({
      records: [],
      facts: [],
      events: [],
    });
  });
});

describe('GET /v1/records/:id/context', () => {
  const context = (id: string, query = '', key = keys.agent) =>
    t.request(`/v1/records/${id}/context${query}`, { key });

  it('packs values with provenance, linked records, facts and recent events', async () => {
    const tag = word();
    const email = `${tag}@acme.test`;
    const noa = await create('person', { name: 'Noa Shapira', emails: email });
    const patch = await t.request(`/v1/records/${noa}`, {
      key: keys.user,
      method: 'PATCH',
      body: { values: { jobTitle: 'Head of Data' } },
    });
    expect(patch.status).toBe(200);

    const later = await create('task', {
      title: 'Later',
      status: 'todo',
      dueDate: '2026-12-01',
      person: noa,
    });
    const undated = await create('task', { title: 'Undated', status: 'in_progress', person: noa });
    const soon = await create('task', {
      title: 'Soon',
      status: 'todo',
      dueDate: '2026-11-04',
      person: noa,
    });
    const finished = await create('task', {
      title: 'Finished',
      status: 'done',
      dueDate: '2026-10-01',
      person: noa,
    });
    await create('task', { title: 'Unrelated', status: 'todo' });

    const demo = await logEvent({
      type: 'conversation',
      occurredAt: '2026-10-21T09:00:00Z',
      title: 'Demo',
      summary: 'Showed the data platform.',
      participants: [{ handle: email }],
    });
    const followUp = await logEvent({
      occurredAt: '2026-10-25T09:00:00Z',
      title: 'Follow-up',
      participants: [{ handle: email }],
    });
    const sso = await rememberFact(noa, 'Needs SSO before agreeing to a pilot', demo);
    // Uncited: its internal note is not listed under recentEvents, and has no readable ID.
    const budget = await rememberFact(noa, 'Budget is approved for Q1');

    const res = await context(noa);
    expect(res.status).toBe(200);
    const pack = res.body;
    expect(pack.record).toEqual({
      id: noa,
      object: 'person',
      label: 'Noa Shapira',
      fields: {
        name: {
          value: { first: 'Noa', last: 'Shapira' },
          writtenBy: { type: 'agent', id: 'inbox' },
          observedAt: expect.any(String),
        },
        emails: {
          value: { primary: email, additional: [] },
          writtenBy: { type: 'agent', id: 'inbox' },
          observedAt: expect.any(String),
        },
        jobTitle: {
          value: 'Head of Data',
          writtenBy: { type: 'user', id: 'maya' },
          observedAt: expect.any(String),
        },
      },
    });
    expect(pack.linkedRecords).toEqual([
      {
        object: 'task',
        total: 4,
        items: [
          {
            id: finished,
            title: 'Finished',
            via: { field: 'person', on: 'linked' },
            selects: { status: 'done' },
          },
          {
            id: soon,
            title: 'Soon',
            via: { field: 'person', on: 'linked' },
            selects: { status: 'todo' },
          },
          {
            id: undated,
            title: 'Undated',
            via: { field: 'person', on: 'linked' },
            selects: { status: 'in_progress' },
          },
          {
            id: later,
            title: 'Later',
            via: { field: 'person', on: 'linked' },
            selects: { status: 'todo' },
          },
        ],
      },
    ]);
    expect(pack.facts).toEqual([
      {
        id: budget,
        content: 'Budget is approved for Q1',
        validFrom: expect.any(String),
        writtenBy: { type: 'agent', id: 'inbox' },
        sources: [],
        internal: true,
      },
      {
        id: sso,
        content: 'Needs SSO before agreeing to a pilot',
        validFrom: '2026-10-21T09:00:00.000Z',
        writtenBy: { type: 'agent', id: 'inbox' },
        sources: [demo],
      },
    ]);
    expect(pack.recentEvents).toEqual([
      {
        id: followUp,
        type: 'conversation',
        occurredAt: '2026-10-25T09:00:00.000Z',
        title: 'Follow-up',
        summary: null,
        via: { kind: 'participant' },
      },
      {
        id: demo,
        type: 'conversation',
        occurredAt: '2026-10-21T09:00:00.000Z',
        title: 'Demo',
        summary: 'Showed the data platform.',
        via: { kind: 'participant' },
      },
    ]);
    expect(pack.omitted).toEqual({ linkedRecords: 0, facts: 0, recentEvents: 0 });
    expect(pack.tokenEstimate).toBe(Math.ceil(JSON.stringify(pack).length / 4));
    expect(pack.tokenEstimate).toBeLessThanOrEqual(2000);
  });

  it('says how each event is attached, once per event, participant before about before field', async () => {
    // Its own workspace: the relation field on call changes the schema.
    const own = await t.setupWorkspace(
      { name: `Via ${word()}`, template: 'sales' },
      {
        agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
        admin: { actor: { type: 'user', id: 'dana' }, scopes: ['admin'] },
      },
    );
    const change = await t.request('/v1/schema/changes', {
      key: own.keys.admin,
      body: {
        operations: [
          {
            op: 'create_field',
            object: 'conversation',
            field: {
              name: 'account',
              label: 'Account',
              type: 'relation',
              settings: { targetObject: 'company', inverseField: 'accountCalls' },
            },
          },
        ],
      },
    });
    expect(change.body.status).toBe('applied');

    const key = own.keys.agent;
    const email = `${word()}@acme.test`;
    const dana = await create('person', { name: 'Dana Via', emails: email }, key);
    const acme = await create('company', { name: 'Acme Via' }, key);
    const other = await create('company', { name: 'Other Via' }, key);
    const both = await logEvent(
      {
        occurredAt: '2026-10-05T09:00:00Z',
        participants: [{ handle: email }],
        about: [dana, acme],
        fields: { account: acme },
      },
      key,
    );
    const aboutOnly = await logEvent(
      { type: 'conversation', occurredAt: '2026-10-04T09:00:00Z', about: [dana] },
      key,
    );
    const byField = await logEvent(
      { occurredAt: '2026-10-03T09:00:00Z', fields: { account: acme } },
      key,
    );
    // The fact's internal note is about acme, yet never listed as an event.
    const fact = await rememberFact(acme, 'Pays annually', undefined, key);

    const recent = async (id: string) =>
      (await context(id, '', key)).body.recentEvents.map((e: { id: string; via: unknown }) => [
        e.id,
        e.via,
      ]);
    expect(await recent(dana)).toEqual([
      [both, { kind: 'participant' }],
      [aboutOnly, { kind: 'about' }],
    ]);
    expect(await recent(acme)).toEqual([
      [both, { kind: 'about' }],
      [byField, { kind: 'field', field: 'account' }],
    ]);
    const pack = (await context(acme, '', key)).body;
    expect(pack.omitted.recentEvents).toBe(0);
    expect(pack.facts).toEqual([
      expect.objectContaining({ id: fact, sources: [], internal: true }),
    ]);

    // `linked` on the event type's query sees the same attachments.
    const linked = async (link?: string) =>
      (
        await t.request('/v1/objects/conversation/query', {
          key,
          body: { linked: { record: acme, ...(link ? { link } : {}) } },
        })
      ).body.records
        .map((r: { id: string }) => r.id)
        .sort();
    expect(await linked()).toEqual([both, byField].sort());
    expect(await linked('field')).toEqual([both, byField].sort());
    expect(await linked('about')).toEqual([both]);

    // The field follows its current value: reassigning it moves the event.
    const moved = await t.request(`/v1/records/${byField}`, {
      key,
      method: 'PATCH',
      body: { values: { account: other } },
    });
    expect(moved.status).toBe(200);
    expect(await recent(acme)).toEqual([[both, { kind: 'about' }]]);
    expect(await recent(other)).toEqual([[byField, { kind: 'field', field: 'account' }]]);

    // A deleted relation field no longer attaches anything.
    const dropped = await t.request('/v1/schema/changes', {
      key: own.keys.admin,
      body: { operations: [{ op: 'delete_field', object: 'conversation', field: 'account' }] },
    });
    expect(dropped.body.status).toBe('applied');
    expect(await recent(other)).toEqual([]);
  });

  it('leaves out deleted events and the facts that rested only on them', async () => {
    const email = `${word()}@acme.test`;
    const noa = await create('person', { name: `Noa ${word()}`, emails: email });
    const call = await logEvent({ title: 'Gone', participants: [{ handle: email }] });
    const kept = await logEvent({
      title: 'Kept',
      about: [noa],
      occurredAt: '2026-10-01T09:00:00Z',
    });
    await rememberFact(noa, 'Only from the deleted call', call);
    expect(
      (await t.request(`/v1/events/${call}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    const pack = (await context(noa)).body;
    expect(pack.recentEvents.map((e: { id: string }) => e.id)).toEqual([kept]);
    expect(pack.facts).toEqual([]);
  });

  it('fits facts and recent events at the default budget when links fill a page', async () => {
    const company = await create('company', { name: `Busy ${word()}` });
    for (let i = 0; i < 85; i++) {
      await create('task', { title: `Linked record ${i}`, status: 'done', company });
    }
    for (let i = 0; i < 3; i++) {
      const event = await logEvent({ title: `Call ${i}`, about: [company] });
      await rememberFact(company, `Fact from call ${i}`, event);
    }
    const pack = (await context(company)).body;
    expect(pack.linkedRecords[0].items.length).toBeGreaterThan(0);
    expect(pack.omitted.linkedRecords).toBeGreaterThan(0);
    expect(pack.facts).toHaveLength(3);
    expect(pack.recentEvents).toHaveLength(3);
    expect(JSON.stringify(pack).length).toBeLessThanOrEqual(8_000);
  });

  it('fits the sections to the budget, always keeping the values, and counts what it left out', async () => {
    const company = await create('company', { name: `Budget ${word()}` });
    for (let i = 0; i < 3; i++) {
      await create('task', { title: `Task ${i} ${'x'.repeat(600)}`, status: 'todo', company });
    }
    await rememberFact(company, `A fact ${'y'.repeat(200)}`);

    const tiny = await context(company, '?tokenBudget=1');
    expect(tiny.status).toBe(200);
    expect(tiny.body.record.fields.name).toBeDefined();
    expect(tiny.body).toMatchObject({
      linkedRecords: [],
      facts: [],
      recentEvents: [],
      omitted: { linkedRecords: 3, facts: 1, recentEvents: 0 },
    });

    // Room for two tasks and the fact: the third task does not fit, and the
    // section after it still gets the rest.
    const full = await context(company);
    const frame = JSON.stringify({
      ...full.body,
      linkedRecords: [],
      facts: [],
      recentEvents: [],
      omitted: { linkedRecords: 3, facts: 1, recentEvents: 0 },
    }).length;
    // Each item costs its JSON and a comma; 5 tokens of slack is far less than a task.
    const group = full.body.linkedRecords[0];
    const twoTasks = JSON.stringify({ ...group, items: group.items.slice(0, 2) }).length;
    const fact = JSON.stringify(full.body.facts[0]).length + 1;
    const budget = Math.ceil((frame + twoTasks + fact) / 4) + 5;
    const some = await context(company, `?tokenBudget=${budget}`);
    expect(some.body.linkedRecords[0].items).toHaveLength(2);
    expect(some.body.facts).toHaveLength(1);
    expect(some.body.omitted).toEqual({ linkedRecords: 1, facts: 0, recentEvents: 0 });
  });

  it('never sends more than the budget once the values fit, framing included', async () => {
    const company = await create('company', { name: `Frame ${word()}` });
    for (let i = 0; i < 40; i++) await create('task', { title: `T${i}`, status: 'todo', company });
    // With no room for items, the pack is the values and the framing around them.
    const bare = Math.ceil(
      JSON.stringify((await context(company, '?tokenBudget=1')).body).length / 4,
    );
    for (const extra of [0, 1, 30, 100, 250, 400]) {
      const budget = bare + extra;
      const res = await context(company, `?tokenBudget=${budget}`);
      const sent = JSON.stringify(res.body).length;
      expect(sent, `budget ${budget}`).toBeLessThanOrEqual(budget * 4);
      expect(res.body.tokenEstimate).toBe(Math.ceil(sent / 4));
      expect((res.body.linkedRecords[0]?.items.length ?? 0) + res.body.omitted.linkedRecords).toBe(
        40,
      );
    }
  });

  it('lets the budget, not a row limit, decide how many items fit', async () => {
    const company = await create('company', { name: `Many ${word()}` });
    for (let i = 0; i < 230; i++) await create('task', { title: `T${i}`, status: 'todo', company });
    const res = await context(company, '?tokenBudget=16000');
    expect(res.body.linkedRecords[0].items).toHaveLength(230);
    expect(res.body.omitted.linkedRecords).toBe(0);
  });

  it('drops linked records linked only through a deleted relation field, as get_record does', async () => {
    // Its own workspace: deleting task.person here would change the others' schema.
    const own = await t.setupWorkspace(
      { name: `Links ${word()}`, template: 'sales' },
      {
        agent: { actor: { type: 'agent', id: 'inbox' }, scopes: ['read', 'write'] },
        admin: { actor: { type: 'user', id: 'dana' }, scopes: ['admin'] },
      },
    );
    const noa = await create('person', { name: 'Noa Levi' }, own.keys.agent);
    const task = await create(
      'task',
      { title: 'Call', status: 'todo', person: noa },
      own.keys.agent,
    );
    const before = await context(noa, '', own.keys.agent);
    expect(before.body.linkedRecords[0].items.map((x: { id: string }) => x.id)).toEqual([task]);

    const change = await t.request('/v1/schema/changes', {
      key: own.keys.admin,
      body: { operations: [{ op: 'delete_field', object: 'task', field: 'person' }] },
    });
    expect(change.body.status).toBe('applied');

    const after = await context(noa, '', own.keys.agent);
    expect(after.body.linkedRecords).toEqual([]);
    expect(after.body.omitted.linkedRecords).toBe(0);
  });

  it('refuses deleted, unknown and foreign records', async () => {
    const company = await create('company', { name: `Deleted ${word()}` });
    expect(
      (await t.request(`/v1/records/${company}`, { key: keys.agent, method: 'DELETE' })).status,
    ).toBe(200);
    const deleted = await context(company);
    expect(deleted.status).toBe(404);
    expect(deleted.body.error.code).toBe('record_deleted');

    const unknown = await context('00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);

    const mine = await create('company', { name: `Mine ${word()}` });
    expect((await context(mine, '', otherKey)).status).toBe(404);
  });

  it('validates tokenBudget', async () => {
    const company = await create('company', { name: `Valid ${word()}` });
    for (const bad of ['0', '16001', 'abc', '1.5']) {
      const res = await context(company, `?tokenBudget=${bad}`);
      expect(res.status, bad).toBe(400);
    }
    expect((await context(company, '?tokenBudget=16000')).status).toBe(200);
  });
});

describe('GET /v1/records/:id/timeline', () => {
  const timeline = (record: string, query = '', key = keys.agent) =>
    t.request(`/v1/records/${record}/timeline${query}`, { key });

  it('pages events, values and facts with comma-separated filters', async () => {
    const deal = await create('deal', { name: `Deal ${word()}`, stage: 'lead' });
    const call = await logEvent({ about: [deal] });
    await rememberFact(deal, `Fact ${word()}`, call);

    const all = await timeline(deal);
    expect(all.status).toBe(200);
    expect(all.body.record).toBe(deal);
    const kinds = all.body.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['event', 'field_change', 'fact']));

    const first = await timeline(deal, '?types=event,fact&limit=1');
    expect(first.body.items).toHaveLength(1);
    const second = await timeline(
      deal,
      `?types=event,fact&limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    expect(
      [...first.body.items, ...second.body.items].map((i: { kind: string }) => i.kind).sort(),
    ).toEqual(['event', 'fact']);

    const stage = await timeline(deal, '?fields=stage');
    expect(stage.body.items).toMatchObject([{ kind: 'field_change', field: 'stage' }]);
  });

  it('refuses bad filters and foreign cursors, and stays in its workspace', async () => {
    const deal = await create('deal', { name: `Deal ${word()}` });
    const other = await create('deal', { name: `Deal ${word()}` });
    expect((await timeline(deal, '?types=emails')).status).toBe(400);
    expect((await timeline(deal, '?limit=0')).status).toBe(400);
    expect((await timeline(deal, '?from=yesterday')).status).toBe(400);
    expect((await timeline(deal, '?fields=nope')).body.error.code).toBe('unknown_field');
    const page = await timeline(deal, '?limit=1');
    const cursor = encodeURIComponent(page.body.nextCursor);
    const foreign = await timeline(other, `?limit=1&cursor=${cursor}`);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe('invalid_cursor');
    expect((await timeline(deal, '', otherKey)).status).toBe(404);
  });
});
