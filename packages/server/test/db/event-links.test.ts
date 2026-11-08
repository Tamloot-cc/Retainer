import { type Actor, INTERNAL_NOTE_TYPE_ID } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import type { LogEventInput } from '../../src/memory/events.js';
import {
  addEventLinksFor,
  logEventFor,
  readEvent,
  remember,
  removeEventLinkFor,
  retractEventFor,
} from '../../src/memory/service.js';
import { queryInputSchema } from '../../src/records/query.js';
import {
  createRecord,
  deleteRecord,
  findRecords,
  forget,
  mergeRecord,
  upsertRecord,
} from '../../src/records/service.js';
import { contextFor, searchFor } from '../../src/retrieval/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';
import { addNoteType } from '../helpers/note-type.js';

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Links', template: 'sales' })).id;
  await addNoteType(db.owner, workspaceId);
});

let n = 0;
const email = () => `links${++n}@acme.test`;
const externalId = () => `links-${++n}`;
async function person(values: Record<string, unknown> = {}) {
  const address = email();
  const record = await createRecord(app, as(AGENT), 'person', { emails: address, ...values });
  return { ...record, email: address };
}
const company = (name = `Company ${++n}`) => createRecord(app, as(AGENT), 'company', { name });
const log = (input: Partial<LogEventInput> = {}) =>
  logEventFor(app, as(AGENT), {
    type: 'conversation',
    channel: 'calendar',
    occurredAt: '2026-10-29T14:00:00+02:00',
    title: 'Pilot review',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });
const none = { participants: { matched: [], unmatched: [] }, about: [] };

/** An event's links as reads present them. */
const linksOf = async (id: string) => {
  const { event } = await readEvent(app, as(AGENT), id);
  if (!event) throw new Error(`${id} is not an event`);
  return event;
};

/** The internal notes `remember` wrote about a record; callers never see their IDs. */
const internalNotesAbout = (recordId: string) =>
  db.owner<{ id: string }[]>`
    select r.id from records r
    join object_types o on o.id = r.object_type_id
    join event_links l on l.event_id = r.id
    where l.record_id = ${recordId} and o.universal_id = ${INTERNAL_NOTE_TYPE_ID}`;

const count = async (query: Promise<{ count: number }[]>) => (await query)[0]?.count ?? 0;

describe('logging an event again adds links (1.3)', () => {
  it('adds only the new participants and about records, and a retry adds nothing', async () => {
    const dana = await person();
    const acme = await company();
    const id = externalId();
    const first = await log({ externalId: id, participants: [{ handle: dana.email }] });

    const extra = email();
    const again = await log({
      externalId: id,
      participants: [{ handle: dana.email }, { handle: extra, role: 'guest' }],
      about: [acme.id],
    });
    expect(again).toMatchObject({ id: first.id, created: false, about: [acme.id] });
    expect(again.added).toEqual({
      participants: {
        matched: [],
        unmatched: [{ id: expect.any(String), handle: extra, role: 'guest', reason: 'no_match' }],
      },
      about: [acme.id],
    });
    expect(again.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(again.participants.unmatched.map((p) => p.handle)).toEqual([extra]);

    const retry = await log({
      externalId: id,
      participants: [{ handle: dana.email }, { handle: extra, role: 'guest' }],
      about: [acme.id],
    });
    expect(retry.added).toEqual(none);
    expect(retry.participants).toEqual(again.participants);

    // A sync that logs the original, shorter list again removes nothing.
    const stale = await log({ externalId: id, participants: [{ handle: dana.email }] });
    expect(stale.added).toEqual(none);
    expect(stale.participants).toEqual(again.participants);
    expect(stale.about).toEqual([acme.id]);
  });

  it.each([false, true])(
    'links a first-contact event after upsert (recordId: %s)',
    async (explicit) => {
      const handle = email();
      const input = { externalId: externalId(), participants: [{ handle, role: 'organizer' }] };
      const first = await log(input);
      expect(first.participants.unmatched[0]?.reason).toBe('no_match');
      const created = await upsertRecord(app, as(AGENT), 'person', {
        values: { emails: handle },
        ifMissing: 'create',
        source: first.id,
      });
      expect(
        (await contextFor(app, as(AGENT), created.id, { tokenBudget: 2000 })).recentEvents,
      ).toEqual([]);
      const retryInput = {
        ...input,
        participants: [
          { handle, role: 'organizer', ...(explicit ? { recordId: created.id } : {}) },
        ],
      };
      const again = await log(retryInput);
      const matched = [
        {
          id: first.participants.unmatched[0]?.id,
          handle,
          role: 'organizer',
          recordId: created.id,
        },
      ];
      expect(again).toMatchObject({
        id: first.id,
        created: false,
        participants: { matched, unmatched: [] },
      });
      expect(again.added).toEqual({ participants: { matched, unmatched: [] }, about: [] });
      expect(
        (await contextFor(app, as(AGENT), created.id, { tokenBudget: 2000 })).recentEvents,
      ).toEqual([expect.objectContaining({ id: first.id, via: { kind: 'participant' } })]);
      expect((await log(retryInput)).added).toEqual(none);
      expect(
        await db.owner`select id, position, record_id, unmatched_reason from event_links where event_id = ${first.id}`,
      ).toEqual([
        { id: matched[0]?.id, position: 0, record_id: created.id, unmatched_reason: null },
      ]);
    },
  );

  it('serializes concurrent re-logs into one resolved participant', async () => {
    const handle = email();
    const input = { externalId: externalId(), participants: [{ handle }] };
    const first = await log(input);
    const dana = await person({ emails: handle });
    const results = await Promise.all([
      log(input),
      log({ ...input, participants: [{ handle, recordId: dana.id }] }),
    ]);
    expect(results.every((r) => r.id === first.id && !r.created)).toBe(true);
    expect(results.map((r) => r.added?.participants.matched.length).sort()).toEqual([0, 1]);
    expect(
      await db.owner`select record_id, unmatched_reason from event_links where event_id = ${first.id}`,
    ).toEqual([{ record_id: dana.id, unmatched_reason: null }]);
  });

  it.each([false, true])(
    'resolves a formerly unmatched participant through a merge (recordId: %s)',
    async (explicit) => {
      const handle = email();
      const input = { externalId: externalId(), participants: [{ handle }] };
      await log(input);
      const loser = await person({ emails: handle });
      const winner = await person();
      await mergeRecord(app, as(USER), winner.id, { recordId: loser.id });
      const again = await log({
        ...input,
        participants: [{ handle, ...(explicit ? { recordId: loser.id } : {}) }],
      });
      expect(again.participants.matched[0]?.recordId).toBe(winner.id);
      expect(again.added?.participants.matched[0]?.recordId).toBe(winner.id);
    },
  );

  it('keeps duplicate handles and roles counted while resolving in place', async () => {
    const handle = email();
    const input = {
      externalId: externalId(),
      participants: [{ handle }, { handle }, { handle, role: 'guest' }],
    };
    const first = await log(input);
    const dana = await person({ emails: handle });
    const one = await log({ ...input, participants: [{ handle }] });
    expect(one.participants.matched).toHaveLength(1);
    expect(one.participants.unmatched).toHaveLength(2);
    const again = await log(input);
    expect(again.participants.matched.map((p) => p.id)).toEqual(
      first.participants.unmatched.map((p) => p.id),
    );
    expect(again.participants.matched.map((p) => p.recordId)).toEqual([dana.id, dana.id, dana.id]);
    expect(again.added?.participants.matched).toHaveLength(2);
    expect((await log(input)).added).toEqual(none);
  });

  it('resolves phone_only with an explicit ID, replacing an about link', async () => {
    const handle = '+14155552671';
    const dana = await person();
    const input = { externalId: externalId(), participants: [{ handle }], about: [dana.id] };
    const first = await log(input);
    expect(first.participants.unmatched[0]?.reason).toBe('phone_only');
    expect((await log(input)).added).toEqual(none);
    const again = await addEventLinksFor(app, as(AGENT), first.id, {
      participants: [{ handle, recordId: dana.id }],
      about: [],
    });
    expect(again.event?.about).toEqual([]);
    expect(again.added.participants.matched[0]).toMatchObject({
      id: first.participants.unmatched[0]?.id,
      recordId: dana.id,
    });
  });

  it('never revives a suppressed handle on retry, including with recordId', async () => {
    const dana = await person();
    await forget(app, as(USER), dana.id);
    const input = { externalId: externalId(), participants: [{ handle: dana.email }] };
    const first = await log(input);
    expect(first.participants.unmatched[0]?.reason).toBe('suppressed');
    const other = await person();
    for (const participants of [input.participants, [{ handle: dana.email, recordId: other.id }]]) {
      const again = await log({ ...input, participants });
      expect(again.participants).toEqual(first.participants);
      expect(again.added).toEqual(none);
    }
  });

  it('only resolves an ambiguous row with an explicit current candidate', async () => {
    await inWorkspace(app, workspaceId, (tx) =>
      runSchemaChange(tx, {
        workspaceId,
        actor: USER,
        scopes: ['schema:write', 'admin'],
        operations: [
          {
            op: 'create_field',
            object: 'company',
            field: {
              name: 'billingEmails',
              label: 'Billing emails',
              type: 'emails',
              isUnique: true,
            },
          },
        ],
      }),
    );
    const handle = email();
    const dana = await person({ emails: handle });
    const vendor = await createRecord(app, as(AGENT), 'company', {
      name: 'Billing',
      billingEmails: handle,
    });
    const unrelated = await person();
    const input = { externalId: externalId(), participants: [{ handle }] };
    const first = await log(input);
    expect(first.participants.unmatched[0]).toMatchObject({
      reason: 'ambiguous',
      candidates: [dana.id, vendor.id].sort(),
    });
    expect((await log(input)).added).toEqual(none);
    const outside = await log({ ...input, participants: [{ handle, recordId: unrelated.id }] });
    expect(outside.participants).toEqual(first.participants);
    expect(outside.added).toEqual(none);
    // Becoming unambiguous alone still requires explicit people/agent selection.
    await deleteRecord(app, as(USER), vendor.id);
    expect((await log(input)).added).toEqual(none);
    const again = await log({ ...input, participants: [{ handle, recordId: dana.id }] });
    expect(again.participants.unmatched).toEqual([]);
    expect(again.added?.participants.matched[0]).toMatchObject({
      id: first.participants.unmatched[0]?.id,
      recordId: dana.id,
    });
  });

  it('leaves deleted_record rows for review even when given another live ID', async () => {
    const dana = await person();
    await deleteRecord(app, as(USER), dana.id);
    const input = { externalId: externalId(), participants: [{ handle: dana.email }] };
    const first = await log(input);
    expect(first.participants.unmatched[0]?.reason).toBe('deleted_record');
    const other = await person();
    const again = await log({
      ...input,
      participants: [{ handle: dana.email, recordId: other.id }],
    });
    expect(again.participants).toEqual(first.participants);
    expect(again.added).toEqual(none);
  });

  it('still reports a different type, time, title or summary as a conflict', async () => {
    const id = externalId();
    await log({ externalId: id, summary: 'First' });
    for (const change of [
      { type: 'note' },
      { occurredAt: '2026-10-29T15:00:00+02:00' },
      { title: 'Another title' },
      { summary: 'Second' },
    ]) {
      await expect(log({ externalId: id, summary: 'First', ...change })).rejects.toMatchObject({
        status: 409,
        code: 'event_conflict',
      });
    }
    // The same instant written with another offset is the same time.
    await expect(
      log({ externalId: id, summary: 'First', occurredAt: '2026-10-29T12:00:00Z' }),
    ).resolves.toMatchObject({ created: false });
  });

  it('matches a stored participant by record ID through a merge', async () => {
    const a = await person();
    const b = await person();
    const id = externalId();
    await log({ externalId: id, participants: [{ recordId: b.id, role: 'attendee' }] });
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    const again = await log({
      externalId: id,
      participants: [{ recordId: b.id, role: 'attendee' }],
    });
    expect(again.added).toEqual(none);
    expect(again.participants.matched).toEqual([
      { id: expect.any(String), handle: null, role: 'attendee', recordId: a.id },
    ]);
  });

  it('keeps a participant whose record was deleted since, without failing the re-log', async () => {
    const dana = await person();
    const id = externalId();
    await log({ externalId: id, participants: [{ recordId: dana.id }] });
    await deleteRecord(app, as(USER), dana.id);
    const acme = await company();
    const again = await log({
      externalId: id,
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    expect(again.added).toEqual({ ...none, about: [acme.id] });
  });

  it('lands concurrent additions with different participants, each once and in order', async () => {
    const id = externalId();
    const first = await log({ externalId: id });
    const handles = Array.from({ length: 8 }, () => email());
    await Promise.all(handles.map((handle) => log({ externalId: id, participants: [{ handle }] })));
    const rows = await db.owner<{ handle: string; position: number }[]>`
      select handle, position from event_links
      where event_id = ${first.id} order by position`;
    expect(rows.map((r) => r.handle).sort()).toEqual([...handles].sort());
    expect(rows.map((r) => r.position)).toEqual(handles.map((_, i) => i));
  });

  it('refuses links on a deleted event', async () => {
    const id = externalId();
    const logged = await log({ externalId: id });
    await retractEventFor(app, as(USER), logged.id);
    await expect(log({ externalId: id, about: [(await company()).id] })).rejects.toMatchObject({
      code: 'event_retracted',
    });
    await expect(
      addEventLinksFor(app, as(AGENT), logged.id, {
        participants: [],
        about: [(await company()).id],
      }),
    ).rejects.toMatchObject({ status: 404, code: 'record_deleted' });
  });
});

describe('about records (1.3)', () => {
  it('lists the event on each record it is about, never as an attendee', async () => {
    const dana = await person({ name: 'Dana About' });
    const acme = await company('Acme About');
    const pilot = await createRecord(app, as(AGENT), 'deal', { name: 'Acme pilot' });
    const logged = await log({
      externalId: externalId(),
      title: 'Pilot kickoff',
      participants: [{ handle: dana.email, role: 'customer' }],
      about: [acme.id, pilot.id],
    });
    expect(logged.about).toEqual([acme.id, pilot.id]);
    expect(logged.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);

    const read = await linksOf(logged.id);
    expect(read.about).toEqual([acme.id, pilot.id]);
    expect(read.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);

    const acmeContext = await contextFor(app, as(AGENT), acme.id, { tokenBudget: 2000 });
    expect(acmeContext.recentEvents).toEqual([
      expect.objectContaining({ id: logged.id, type: 'conversation', via: { kind: 'about' } }),
    ]);
    const danaContext = await contextFor(app, as(AGENT), dana.id, { tokenBudget: 2000 });
    expect(danaContext.recentEvents).toEqual([
      expect.objectContaining({
        id: logged.id,
        type: 'conversation',
        via: { kind: 'participant' },
      }),
    ]);

    const hits = await searchFor(app, as(AGENT), { query: 'kickoff', limit: 10 });
    expect(hits.events.find((h) => h.id === logged.id)?.records).toEqual([
      dana.id,
      acme.id,
      pilot.id,
    ]);
  });

  it('drops repeated about records and records already listed as participants', async () => {
    const dana = await person();
    const acme = await company();
    const logged = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id, dana.id, acme.id],
    });
    expect(logged.about).toEqual([acme.id]);
    expect(
      await count(db.owner`
        select count(*)::int from event_links where event_id = ${logged.id}`),
    ).toBe(2);
  });

  it('rejects unknown and deleted about records, and follows merges', async () => {
    const gone = await company();
    await deleteRecord(app, as(USER), gone.id);
    const unknown = '00000000-0000-4000-8000-000000000000';
    await expect(log({ about: [unknown, gone.id] })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_about',
      details: {
        errors: [
          { index: 0, recordId: unknown, message: 'no record with this ID' },
          { index: 1, recordId: gone.id, message: 'the record is deleted' },
        ],
      },
    });
    const a = await company();
    const b = await company();
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect((await log({ about: [b.id] })).about).toEqual([a.id]);
  });

  it('refuses an event in about with invalid_link, naming the record (C4)', async () => {
    const earlier = await log({ type: 'conversation', channel: 'zoom', title: 'Discovery call' });
    const acme = await company();
    const refused = {
      status: 422,
      code: 'invalid_link',
      details: { errors: [expect.objectContaining({ index: 1, recordId: earlier.id })] },
    };
    await expect(log({ about: [acme.id, earlier.id] })).rejects.toMatchObject(refused);
    const followUp = await log({ externalId: externalId(), about: [acme.id] });
    await expect(
      addEventLinksFor(app, as(AGENT), followUp.id, {
        participants: [],
        about: [acme.id, earlier.id],
      }),
    ).rejects.toMatchObject(refused);
    // Nothing was linked by the refused calls.
    expect((await readEvent(app, as(AGENT), followUp.id)).event?.about).toEqual([acme.id]);
    // Itself, too.
    await expect(
      addEventLinksFor(app, as(AGENT), followUp.id, { participants: [], about: [followUp.id] }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'invalid_link',
      details: {
        errors: [{ index: 0, recordId: followUp.id, message: 'an event cannot be about itself' }],
      },
    });
    // Any event type: a note is no more linkable than a conversation.
    const note = await log({ type: 'note', channel: 'web', title: 'Aside' });
    await expect(log({ about: [note.id] })).rejects.toMatchObject({ code: 'invalid_link' });
  });

  it('refuses an event as a participant, and never matches a handle to one (C4)', async () => {
    const earlier = await log({ type: 'conversation', channel: 'zoom', title: 'Discovery call' });
    await expect(log({ participants: [{ recordId: earlier.id }] })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_participants',
      details: { errors: [expect.objectContaining({ recordId: earlier.id })] },
    });
  });

  it('keeps an about link to an event from before the rule: reads, retries, removal (C4)', async () => {
    const earlier = await log({ type: 'conversation', channel: 'zoom', title: 'Discovery call' });
    const id = externalId();
    const followUp = await log({ externalId: id, title: 'Follow-up' });
    // As a release before C4 wrote it.
    await db.owner`
      insert into event_links (workspace_id, event_id, position, record_id, link)
      values (${workspaceId}, ${followUp.id}, 0, ${earlier.id}, 'about')`;

    // It still reads, on both sides.
    expect((await readEvent(app, as(AGENT), followUp.id)).event?.about).toEqual([earlier.id]);
    const linked = await findRecords(
      app,
      as(AGENT),
      'conversation',
      queryInputSchema.parse({ linked: { record: earlier.id, link: 'about' } }),
    );
    expect(linked.records.map((r) => r.id)).toEqual([followUp.id]);

    // A sync that logs its original list again changes nothing.
    const retried = await log({ externalId: id, title: 'Follow-up', about: [earlier.id] });
    expect(retried.created).toBe(false);
    expect(retried.about).toEqual([earlier.id]);
    expect(retried.added?.about).toEqual([]);

    // A person can remove it; it cannot then be added back.
    await removeEventLinkFor(app, as(USER), followUp.id, { about: earlier.id });
    expect((await readEvent(app, as(AGENT), followUp.id)).event?.about).toEqual([]);
    await expect(
      log({ externalId: id, title: 'Follow-up', about: [earlier.id] }),
    ).rejects.toMatchObject({ code: 'invalid_link' });
  });

  it('replaces an about link when the record is added as a participant', async () => {
    const dana = await person();
    const id = externalId();
    const first = await log({ externalId: id, about: [dana.id] });
    const again = await log({ externalId: id, participants: [{ recordId: dana.id }] });
    expect(again.about).toEqual([]);
    expect(again.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(
      await db.owner`
        select link from event_links where event_id = ${first.id}`,
    ).toEqual([{ link: 'participant' }]);
  });

  it('waits for a merge in progress and links to its survivor', async () => {
    const a = await company();
    const b = await company();
    const id = externalId();
    const logged = await log({ externalId: id });
    // A merge of B into A, held open after it has moved B's links and before it commits.
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let moved = () => {};
    const holding = new Promise<void>((resolve) => {
      moved = resolve;
    });
    const merge = db.owner.begin(async (t) => {
      await t`select id from records where id = ${b.id} for update`;
      await t`update event_links set record_id = ${a.id} where record_id = ${b.id}`;
      await t`update records set merged_into_id = ${a.id}, deleted_at = now() where id = ${b.id}`;
      moved();
      await gate;
    });
    await holding;
    const relog = log({ externalId: id, about: [b.id] });
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await merge;
    expect((await relog).about).toEqual([a.id]);
    expect(
      await db.owner`
        select record_id from event_links where event_id = ${logged.id}`,
    ).toEqual([{ record_id: a.id }]);
  });

  it('removes an about link that a merge in progress is moving', async () => {
    const a = await company();
    const b = await company();
    const logged = await log({ about: [b.id] });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A merge of B into A, held open after it has moved B's links and before it commits.
    const merge = db.owner.begin(async (t) => {
      await t`select id from records where id = ${b.id} for update`;
      await t`update event_links set record_id = ${a.id} where record_id = ${b.id}`;
      await t`update records set merged_into_id = ${a.id}, deleted_at = now() where id = ${b.id}`;
      locked();
      await gate;
    });
    await holding;
    const removal = removeEventLinkFor(app, as(USER), logged.id, { about: b.id });
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await merge;
    expect((await removal).event?.about).toEqual([]);
    expect(
      await count(db.owner`
        select count(*)::int from event_links where event_id = ${logged.id}`),
    ).toBe(0);
  });

  it('links to the survivor when a merge runs at the same time', async () => {
    for (let round = 0; round < 8; round++) {
      const a = await company();
      const b = await company();
      const dana = await person();
      const id = externalId();
      const logged = await log({ externalId: id, participants: [{ recordId: b.id }] });
      const [merged, relogged] = await Promise.allSettled([
        mergeRecord(app, as(USER), a.id, { recordId: b.id }),
        log({
          externalId: id,
          participants: [{ recordId: b.id }, { recordId: dana.id }],
          about: [b.id],
        }),
      ]);
      expect(merged.status).toBe('fulfilled');
      expect(relogged.status).toBe('fulfilled');
      // B's participant row moved to A, nothing points at B, and no link repeats.
      const rows = await db.owner<{ record_id: string; link: string }[]>`
        select record_id, link from event_links
        where event_id = ${logged.id} order by position`;
      expect(rows).toEqual([
        { record_id: a.id, link: 'participant' },
        { record_id: dana.id, link: 'participant' },
      ]);
    }
  });

  it('keeps one link per record when a merge would repeat it', async () => {
    const a = await company();
    const b = await company();
    const dana = await person();
    const both = await log({ externalId: externalId(), about: [a.id, b.id] });
    const attended = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [b.id],
    });
    await mergeRecord(app, as(USER), a.id, { recordId: b.id });
    expect((await linksOf(both.id)).about).toEqual([a.id]);

    const c = await person();
    const withC = await log({
      externalId: externalId(),
      participants: [{ recordId: c.id }],
      about: [dana.id],
    });
    await mergeRecord(app, as(USER), c.id, { recordId: dana.id });
    const merged = await linksOf(withC.id);
    expect(merged.about).toEqual([]);
    expect(merged.participants.matched.map((p) => p.recordId)).toEqual([c.id]);
    expect((await linksOf(attended.id)).about).toEqual([a.id]);
  });

  it('links a note from remember as about its record', async () => {
    const dana = await person();
    await remember(app, as(AGENT), dana.id, { text: 'Likes tea' });
    const [note] = await internalNotesAbout(dana.id);
    expect(
      await db.owner`
        select record_id, link, handle, role from event_links where event_id = ${note?.id as string}`,
    ).toEqual([{ record_id: dana.id, link: 'about', handle: null, role: null }]);
    // The note is not an event any caller can list.
    const context = await contextFor(app, as(AGENT), dana.id, { tokenBudget: 2000 });
    expect(context.recentEvents).toEqual([]);
    expect(context.facts).toEqual([
      expect.objectContaining({ content: 'Likes tea', internal: true }),
    ]);
  });
});

describe('forget and about records (2.1)', () => {
  it('keeps a meeting only about the forgotten record, and drops the link', async () => {
    const dana = await person();
    const acme = await company();
    const meeting = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    const result = await forget(app, as(USER), acme.id);
    expect(result.counts.events).toBe(0);
    const read = await linksOf(meeting.id);
    expect(read.about).toEqual([]);
    expect(read.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(
      await count(db.owner`
        select count(*)::int from event_links where event_id = ${meeting.id}`),
    ).toBe(1);
  });

  it('deletes the events the person took part in and the notes about them', async () => {
    const dana = await person();
    const acme = await company();
    const meeting = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    await remember(app, as(AGENT), dana.id, { text: 'Prefers calls' });
    const [note] = await internalNotesAbout(dana.id);
    const result = await forget(app, as(USER), dana.id);
    expect(result.counts.events).toBe(2);
    expect(
      await count(db.owner`
        select count(*)::int from records where id in (${meeting.id}, ${note?.id as string})`),
    ).toBe(0);
  });
});

describe('adding and removing links by route (1.3)', () => {
  it('adds participants and about records idempotently', async () => {
    const logged = await log({ externalId: externalId() });
    const dana = await person();
    const acme = await company();
    const input = { participants: [{ recordId: dana.id, role: 'attendee' }], about: [acme.id] };
    const added = await addEventLinksFor(app, as(AGENT), logged.id, input);
    expect(added.event?.participants.matched.map((p) => p.recordId)).toEqual([dana.id]);
    expect(added.event?.about).toEqual([acme.id]);
    expect(added.added.about).toEqual([acme.id]);
    const again = await addEventLinksFor(app, as(AGENT), logged.id, input);
    expect(again.added).toEqual(none);
  });

  it('adds links only to an event', async () => {
    const dana = await person();
    const acme = await company();
    await expect(
      addEventLinksFor(app, as(AGENT), acme.id, { participants: [], about: [dana.id] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('lets only a person remove a participant or an about record', async () => {
    const dana = await person();
    const acme = await company();
    const logged = await log({
      externalId: externalId(),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    const participantId = logged.participants.matched[0]?.id as string;
    await expect(
      removeEventLinkFor(app, as(AGENT), logged.id, { participant: participantId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      removeEventLinkFor(app, as(AGENT), logged.id, { about: acme.id }),
    ).rejects.toMatchObject({
      status: 403,
    });

    const withoutDana = await removeEventLinkFor(app, as(USER), logged.id, {
      participant: participantId,
    });
    expect(withoutDana.event?.participants.matched).toEqual([]);
    const withoutAcme = await removeEventLinkFor(app, as(USER), logged.id, { about: acme.id });
    expect(withoutAcme.event?.about).toEqual([]);
    await expect(
      removeEventLinkFor(app, as(USER), logged.id, { about: acme.id }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      removeEventLinkFor(app, as(USER), logged.id, { participant: participantId }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('querying events (7.1)', () => {
  const query = (type: string, input: Record<string, unknown>) =>
    findRecords(app, as(AGENT), type, queryInputSchema.parse(input));
  const ids = (page: { records: { id: string }[] }) => page.records.map((r) => r.id);
  const newest = [{ field: 'occurredAt', direction: 'desc' }];

  it('filters by type, channel, time and linked record, newest or oldest first', async () => {
    const channel = `query-${++n}`;
    const dana = await person();
    const acme = await company();
    const at = (day: number) => `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`;
    const call1 = await log({ channel, type: 'conversation', occurredAt: at(2), about: [acme.id] });
    const note = await log({
      channel,
      type: 'note',
      occurredAt: at(10),
      participants: [{ recordId: dana.id }],
      about: [acme.id],
    });
    const call2 = await log({ channel, type: 'conversation', occurredAt: at(20) });
    const retracted = await log({ channel, type: 'conversation', occurredAt: at(21) });
    await retractEventFor(app, as(USER), retracted.id);
    await remember(app, as(AGENT), acme.id, { text: 'A note, not an event' });

    const calls = await query('conversation', { filter: { channel }, sort: newest });
    expect(ids(calls)).toEqual([call2.id, call1.id]);
    expect(calls.records[0]?.event).toMatchObject({
      channel,
      occurredAt: new Date(at(20)).toISOString(),
    });
    const oldest = await query('conversations', {
      filter: { channel },
      sort: [{ field: 'occurredAt', direction: 'asc' }],
    });
    expect(ids(oldest)).toEqual([call1.id, call2.id]);
    expect(ids(await query('note', { filter: { channel } }))).toEqual([note.id]);

    const october = await query('conversation', {
      filter: { channel, occurredAt: { gte: at(1), lt: at(20) } },
    });
    expect(ids(october)).toEqual([call1.id]);

    const aboutAcme = await query('conversation', { linked: { record: acme.id }, sort: newest });
    expect(ids(aboutAcme)).toEqual([call1.id]);
    expect(aboutAcme.records[0]?.event?.about).toEqual([acme.id]);
    expect(ids(await query('note', { linked: { record: acme.id } }))).toEqual([note.id]);
    // Across types, newest first; the internal note remember wrote about Acme is never listed.
    expect(ids(await query('event', { linked: { record: acme.id } }))).toEqual([note.id, call1.id]);
    expect(ids(await query('events', { filter: { channel, type: 'note' } }))).toEqual([note.id]);
    await expect(query('internalNote', {})).rejects.toMatchObject({ status: 404 });

    const withDana = await query('note', { linked: { record: dana.id, link: 'participant' } });
    expect(ids(withDana)).toEqual([note.id]);
    expect(ids(await query('note', { linked: { record: dana.id, link: 'about' } }))).toEqual([]);

    // `linked` needs a record, and applies to event types only.
    expect(queryInputSchema.safeParse({ linked: { link: 'about' } }).success).toBe(false);
    await expect(query('person', { linked: { record: acme.id } })).rejects.toMatchObject({
      status: 422,
      code: 'invalid_filter',
    });
  });

  it('attaches an event through its own relation field, after participant and about (6.3)', async () => {
    await inWorkspace(app, workspaceId, (tx) =>
      runSchemaChange(tx, {
        workspaceId,
        actor: USER,
        scopes: ['schema:write', 'admin'],
        operations: [
          {
            op: 'create_field',
            object: 'conversation',
            field: {
              name: 'deal',
              label: 'Deal',
              type: 'relation',
              settings: { targetObject: 'deal', inverseField: 'calls' },
            },
          },
        ],
      }),
    );
    const pilot = await createRecord(app, as(AGENT), 'deal', { name: 'Field pilot' });
    const byField = await log({ type: 'conversation', fields: { deal: pilot.id } });
    const both = await log({ type: 'conversation', fields: { deal: pilot.id }, about: [pilot.id] });

    const viaField = await query('conversation', { linked: { record: pilot.id, link: 'field' } });
    expect(ids(viaField).sort()).toEqual([byField.id, both.id].sort());
    const viaAbout = await query('conversation', { linked: { record: pilot.id, link: 'about' } });
    expect(ids(viaAbout)).toEqual([both.id]);

    const context = await contextFor(app, as(AGENT), pilot.id, { tokenBudget: 2000 });
    expect(context.recentEvents.map((e) => [e.id, e.via]).sort()).toEqual(
      [
        [byField.id, { kind: 'field', field: 'deal' }],
        [both.id, { kind: 'about' }],
      ].sort(),
    );
  });

  it('pages with a cursor', async () => {
    const channel = `query-${++n}`;
    for (let day = 1; day <= 5; day++) {
      await log({ channel, type: 'conversation', occurredAt: `2026-09-0${day}T10:00:00Z` });
    }
    const first = await query('conversation', { filter: { channel }, sort: newest, limit: 2 });
    expect(first.records).toHaveLength(2);
    const second = await query('conversation', {
      filter: { channel },
      sort: newest,
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await query('conversation', {
      filter: { channel },
      sort: newest,
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.nextCursor).toBeNull();
    const seen = [...first.records, ...second.records, ...third.records].map(
      (r) => r.event?.occurredAt as string,
    );
    expect(seen).toEqual([...seen].sort().reverse());
    expect(new Set(seen).size).toBe(5);
  });
});
