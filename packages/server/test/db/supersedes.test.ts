import { randomBytes } from 'node:crypto';
import { type Actor, INTERNAL_NOTE_TYPE_ID } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import type { LogEventInput } from '../../src/memory/events.js';
import {
  clearMyMemory,
  factsOf,
  logEventFor,
  remember,
  retractEventFor,
  retractFactFor,
} from '../../src/memory/service.js';
import { createRecord, forget, mergeRecord } from '../../src/records/service.js';
import { contextFor, searchFor, timelineFor } from '../../src/retrieval/service.js';
import { useTestDatabase } from '../helpers/db.js';
import { keyCaller, sessionCaller, type Team, team } from '../helpers/people.js';

// Correcting and moving facts with `supersedes` (personal memory spec 4.9,
// 6: "Supersedes"): every rule of the table, races, and what a move keeps.

const db = useTestDatabase();
let app: Sql;
let t: Team;
let dana: Caller;
let agent: Caller;
const USER: Caller = {
  workspaceId: '',
  actor: { type: 'user', id: 'maya' } as Actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
};
let user: Caller;

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
  t = await team(db);
  dana = await keyCaller(db, app, t.workspaceId, { worksFor: t.dana });
  agent = await keyCaller(db, app, t.workspaceId);
  user = { ...USER, workspaceId: t.workspaceId };
});

let n = 0;
const unique = () => `${++n}-${randomBytes(3).toString('hex')}`;
const company = async (caller = agent) =>
  (await createRecord(app, caller, 'company', { name: `Acme ${unique()}` })).record;
const log = (input: Partial<LogEventInput> = {}) =>
  logEventFor(app, agent, {
    type: 'conversation',
    channel: 'zoom',
    externalId: `ext-${unique()}`,
    occurredAt: '2026-10-29T14:00:00+02:00',
    title: 'Call',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });
const current = async (caller: Caller, record: string) =>
  (await factsOf(app, caller, record, 100)).facts.map((f) => f.content);

async function row(id: string) {
  const [fact] = await db.owner<
    {
      record_id: string;
      superseded_by: string | null;
      replaced_at: Date | null;
      valid_from: Date;
      valid_to: Date | null;
      private_to_user: string | null;
    }[]
  >`select record_id, superseded_by, replaced_at, valid_from, valid_to, private_to_user
    from facts where id = ${id}`;
  return fact;
}

describe('correcting a fact', () => {
  it('replaces it on the same record; the old one stays in history as superseded', async () => {
    const old = await remember(app, dana, 'me', { text: 'Prefers short emails' });
    const corrected = await remember(app, dana, 'me', {
      text: 'Prefers long emails now',
      supersedes: old.fact.id,
    });
    expect(await current(dana, 'me')).toContain('Prefers long emails now');
    expect(await current(dana, 'me')).not.toContain('Prefers short emails');
    expect(await row(old.fact.id)).toMatchObject({
      superseded_by: corrected.fact.id,
      replaced_at: expect.any(Date),
    });
    // A correction without a source gets its own note, private like the fact.
    expect(corrected.fact.sources).toEqual([{ event: null, internal: true, quote: null }]);
    expect((await row(corrected.fact.id))?.private_to_user).toBe(t.dana.id);
    const history = await timelineFor(app, dana, 'me', { limit: 50 });
    expect(history.items).toContainEqual(
      expect.objectContaining({ id: old.fact.id, status: 'superseded' }),
    );
    // Search and context leave it out.
    expect(
      (await searchFor(app, dana, { query: 'short emails', limit: 10 })).facts.map((f) => f.id),
    ).not.toContain(old.fact.id);
  });

  it('takes a new source and quote on the same record', async () => {
    const acme = await company();
    const call = await log({ about: [acme.id] });
    const old = await remember(app, agent, acme.id, { text: 'Budget is 10k' });
    const corrected = await remember(app, agent, acme.id, {
      text: 'Budget is 12k',
      source: call.id,
      quote: 'we can do twelve',
      supersedes: old.fact.id,
    });
    expect(corrected.fact).toMatchObject({
      record: acme.id,
      sources: [{ event: call.id, quote: 'we can do twelve' }],
    });
    expect(await current(agent, acme.id)).toEqual(['Budget is 12k']);
  });
});

describe('the rules', () => {
  it('refuses a fact that is retracted, already superseded or not found', async () => {
    const acme = await company();
    const retracted = await remember(app, agent, acme.id, { text: 'Retracted fact' });
    await retractFactFor(app, agent, retracted.fact.id);
    const superseded = await remember(app, agent, acme.id, { text: 'Old fact' });
    await remember(app, agent, acme.id, { text: 'New fact', supersedes: superseded.fact.id });
    for (const id of [retracted.fact.id, superseded.fact.id]) {
      await expect(
        remember(app, agent, acme.id, { text: 'Again', supersedes: id }),
      ).rejects.toMatchObject({ status: 409, code: 'fact_not_current' });
    }
    await expect(
      remember(app, agent, acme.id, {
        text: 'x',
        supersedes: '01a1bc93-0000-7000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ status: 404 });
    // Someone else's personal fact is not found either.
    const eli = await keyCaller(db, app, t.workspaceId, { worksFor: t.eli });
    const theirs = await remember(app, eli, 'me', { text: 'Eli only' });
    await expect(
      remember(app, dana, 'me', { text: 'Eli only', supersedes: theirs.fact.id }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to replace a shared fact with one in me', async () => {
    const shared = await remember(app, dana, 'workspace', { text: `Shared ${unique()}` });
    await expect(
      remember(app, dana, 'me', { text: shared.fact.content, supersedes: shared.fact.id }),
    ).rejects.toMatchObject({ status: 422, code: 'private_replacement' });
    expect((await row(shared.fact.id))?.replaced_at).toBeNull();
  });

  it('lets a person’s own agent share a personal fact', async () => {
    const own = await remember(app, dana, 'me', { text: `Our SLA is 4 hours ${unique()}` });
    const shared = await remember(app, dana, 'workspace', {
      text: own.fact.content,
      supersedes: own.fact.id,
    });
    expect(shared.fact).toMatchObject({ profile: 'workspace' });
    expect((await row(shared.fact.id))?.private_to_user).toBeNull();
    const eli = await sessionCaller(db, app, t.eli, t.workspaceId);
    expect(await current(eli, 'workspace')).toContain(own.fact.content);
  });

  it('never lets an agent supersede what a person or an integration wrote', async () => {
    const acme = await company();
    const integration: Caller = { ...user, actor: { type: 'integration', id: 'hubspot' } };
    for (const writer of [user, integration]) {
      const theirs = await remember(app, writer, acme.id, { text: `By ${writer.actor.type}` });
      await expect(
        remember(app, agent, acme.id, { text: 'Agent says', supersedes: theirs.fact.id }),
      ).rejects.toMatchObject({ status: 403, code: 'supersedes_person' });
      // A person may.
      await remember(app, user, acme.id, { text: 'Person says', supersedes: theirs.fact.id });
    }
  });

  it('lets one of two concurrent supersedes win', async () => {
    for (let i = 0; i < 5; i++) {
      const acme = await company();
      const old = await remember(app, agent, acme.id, { text: `Contested ${i}` });
      const results = await Promise.allSettled([
        remember(app, agent, acme.id, { text: `First ${i}`, supersedes: old.fact.id }),
        remember(app, agent, acme.id, { text: `Second ${i}`, supersedes: old.fact.id }),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { status: 409, code: 'fact_not_current' },
      });
      expect(await current(agent, acme.id)).toHaveLength(1);
    }
  });
});

describe('moving a fact', () => {
  it('keeps its text, citations, quotes and validity, and records the mover', async () => {
    const acme = await company();
    const first = await log({ occurredAt: '2026-09-01T10:00:00Z' });
    const second = await log({ occurredAt: '2026-09-15T10:00:00Z' });
    const misplaced = await remember(app, dana, 'me', {
      text: 'Legal review at Acme takes two weeks',
      source: first.id,
      quote: 'two weeks for legal',
    });
    await db.owner`
      insert into fact_sources (workspace_id, fact_id, source_record_id, quote)
      values (${t.workspaceId}, ${misplaced.fact.id}, ${second.id}, 'still two weeks')`;
    const mover = await keyCaller(db, app, t.workspaceId, { worksFor: t.dana, name: 'mover' });
    const moved = await remember(app, mover, acme.id, {
      text: 'Legal review at Acme takes two weeks',
      supersedes: misplaced.fact.id,
    });
    expect(moved.fact).toMatchObject({
      record: acme.id,
      validFrom: misplaced.fact.validFrom,
      writtenBy: mover.actor,
      sources: [
        { event: first.id, quote: 'two weeks for legal' },
        { event: second.id, quote: 'still two weeks' },
      ],
    });
    const before = await row(misplaced.fact.id);
    const after = await row(moved.fact.id);
    expect(after).toMatchObject({ valid_from: before?.valid_from, valid_to: before?.valid_to });
    expect(after?.private_to_user).toBeNull();
    expect(await current(dana, 'me')).not.toContain('Legal review at Acme takes two weeks');
    const shared = (await contextFor(app, agent, acme.id, { tokenBudget: 4000 })).facts;
    expect(shared.map((f) => f.id)).toEqual([moved.fact.id]);
    // The old fact keeps its author and sources in history.
    const history = (await timelineFor(app, dana, 'me', { limit: 100 })).items;
    expect(history).toContainEqual(
      expect.objectContaining({
        id: misplaced.fact.id,
        status: 'superseded',
        writtenBy: dana.actor,
      }),
    );
  });

  it('lets retracting or erasing an inherited source affect the copy', async () => {
    const acme = await company();
    const contact = (
      await createRecord(app, agent, 'person', { emails: `moved-${unique()}@acme.test` })
    ).record;
    const call = await log({ participants: [{ recordId: contact.id }] });
    const deleted = await log();
    const a = await remember(app, dana, 'me', { text: 'Erased with the call', source: call.id });
    const b = await remember(app, dana, 'me', {
      text: 'Retracted with the call',
      source: deleted.id,
    });
    const movedA = await remember(app, dana, acme.id, {
      text: a.fact.content,
      supersedes: a.fact.id,
    });
    const movedB = await remember(app, dana, acme.id, {
      text: b.fact.content,
      supersedes: b.fact.id,
    });
    await retractEventFor(app, agent, deleted.id);
    expect(await current(agent, acme.id)).toEqual([a.fact.content]);
    await forget(app, user, contact.id);
    expect(await current(agent, acme.id)).toEqual([]);
    const left = await db.owner`
      select id from facts where id = any(${[movedA.fact.id, a.fact.id]}::uuid[])`;
    expect(left).toHaveLength(0);
    expect((await row(movedB.fact.id))?.replaced_at).toBeNull();
  });

  it("copies an internal note with the destination's privacy and attachment, which outlives Clear all", async () => {
    const acme = await company();
    const viewer = await keyCaller(db, app, t.workspaceId, { worksFor: t.viewer });
    const personal = await remember(app, viewer, 'me', { text: 'Acme wants invoices by mail' });
    const moved = await remember(app, viewer, acme.id, {
      text: personal.fact.content,
      supersedes: personal.fact.id,
    });
    const [note] = await db.owner<
      { id: string; private_to_user: string | null; about: string; type: string }[]
    >`
      select r.id, r.private_to_user, l.record_id as about, o.universal_id as type
      from fact_sources s join records r on r.id = s.source_record_id
      join object_types o on o.id = r.object_type_id
      join event_links l on l.event_id = r.id and l.link = 'about'
      where s.fact_id = ${moved.fact.id}`;
    expect(note).toMatchObject({
      private_to_user: null,
      about: acme.id,
      type: INTERNAL_NOTE_TYPE_ID,
    });
    const [old] = await db.owner<{ id: string }[]>`
      select source_record_id as id from fact_sources where fact_id = ${personal.fact.id}`;
    expect(note?.id).not.toBe(old?.id);

    await clearMyMemory(app, await sessionCaller(db, app, t.viewer, t.workspaceId));
    expect(await current(agent, acme.id)).toEqual(['Acme wants invoices by mail']);
    expect((await factsOf(app, agent, acme.id, 10)).facts[0]?.sources).toEqual([
      { event: null, internal: true, quote: null },
    ]);
  });

  it('refuses a changed text or an explicit source', async () => {
    const acme = await company();
    const call = await log();
    const fact = await remember(app, dana, 'me', { text: 'Moves with its text' });
    await expect(
      remember(app, dana, acme.id, { text: 'Moves with other text', supersedes: fact.fact.id }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_move' });
    await expect(
      remember(app, dana, acme.id, {
        text: 'Moves with its text',
        source: call.id,
        supersedes: fact.fact.id,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'invalid_move' });
    // Surrounding spaces are trimmed as for any input.
    await remember(app, dana, acme.id, {
      text: '  Moves with its text ',
      supersedes: fact.fact.id,
    });
  });

  it('never makes the old fact current again when its replacement is erased', async () => {
    const acme = await company();
    const old = await remember(app, agent, acme.id, { text: 'Old belief' });
    const contact = (
      await createRecord(app, agent, 'person', { emails: `replacement-${unique()}@acme.test` })
    ).record;
    const call = await log({ participants: [{ recordId: contact.id }] });
    const replacement = await remember(app, agent, acme.id, {
      text: 'New belief',
      source: call.id,
      supersedes: old.fact.id,
    });
    await forget(app, user, contact.id);
    expect(await row(replacement.fact.id)).toBeUndefined();
    expect(await row(old.fact.id)).toMatchObject({
      superseded_by: null,
      replaced_at: expect.any(Date),
    });
    expect(await current(agent, acme.id)).toEqual([]);
    const history = await timelineFor(app, agent, acme.id, { limit: 50, types: ['fact'] });
    expect(history.items).toContainEqual(
      expect.objectContaining({ id: old.fact.id, status: 'superseded' }),
    );
  });

  it('follows a merge that races the move', async () => {
    for (let i = 0; i < 4; i++) {
      const [a, b, c] = [await company(), await company(), await company()];
      const fact = await remember(app, agent, a.id, { text: `Racing a merge ${i}` });
      const [move, merge] = await Promise.allSettled([
        remember(app, agent, c.id, { text: fact.fact.content, supersedes: fact.fact.id }),
        // The fact's record merges away, or the destination does.
        mergeRecord(app, user, b.id, { recordId: i % 2 === 0 ? a.id : c.id }),
      ]);
      expect(merge.status).toBe('fulfilled');
      expect(move.status).toBe('fulfilled');
      // Exactly one current copy, on the destination or what it merged into.
      const survivors = await db.owner<{ record_id: string }[]>`
        select record_id from facts
        where content = ${fact.fact.content} and replaced_at is null and deleted_at is null`;
      expect(survivors).toEqual([{ record_id: i % 2 === 0 ? c.id : b.id }]);
    }
  });
});
