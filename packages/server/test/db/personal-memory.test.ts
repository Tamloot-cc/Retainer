import { randomBytes } from 'node:crypto';
import { type Actor, MEMBER_PROFILE_TYPE_ID, WORKSPACE_PROFILE_TYPE_ID } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  removeFromOrganization,
  removeFromWorkspace,
  setOrganizationRole,
} from '../../src/accounts/people.js';
import type { Caller } from '../../src/caller.js';
import { CONTROL_ROLE } from '../../src/config.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace, lockMemberExclusive, type Tx } from '../../src/db/tx.js';
import type { LogEventInput } from '../../src/memory/events.js';
import { clearMyMemory, factsOf, logEventFor, remember } from '../../src/memory/service.js';
import { reviewPage } from '../../src/reads/review.js';
import {
  createRecord,
  findEvents,
  findRecords,
  forget,
  readRecord,
  upsertRecord,
  withRead,
} from '../../src/records/service.js';
import { contextFor, searchFor, timelineFor } from '../../src/retrieval/service.js';
import { getSchema } from '../../src/schema/compiled.js';
import { describeSchema } from '../../src/schema-engine/service.js';
import { consolidateWorkspace } from '../../src/worker/consolidate.js';
import { setOrganizationMember, setWorkspaceMember } from '../../src/workspaces/organizations.js';
import { useTestDatabase } from '../helpers/db.js';
import {
  addPerson,
  keyCaller,
  type Person,
  sessionCaller,
  type Team,
  team,
} from '../helpers/people.js';

// Personal and workspace memory (docs/specs/user-and-workspace-memory.md,
// section 6): privacy enforced by Postgres, leaving, retries and erasure.

const db = useTestDatabase();
let app: Sql;
let control: Sql;
let t: Team;

/** Tables that hold private rows (spec 4.2). */
const PRIVATE_TABLES = [
  'records',
  'facts',
  'fact_sources',
  'field_assertions',
  'event_records',
  'event_links',
  'idempotency_keys',
] as const;

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
  control = db.connect({ role: CONTROL_ROLE, max: 10 });
  t = await team(db);
});

let n = 0;
const unique = () => `${++n}-${randomBytes(3).toString('hex')}`;

/** An agent key that works for nobody. */
const agent = (workspaceId = t.workspaceId) => keyCaller(db, app, workspaceId);
/** An agent key that works for a person. */
const agentFor = (person: Person, workspaceId = t.workspaceId) =>
  keyCaller(db, app, workspaceId, { worksFor: person });
const session = (person: Person, workspaceId = t.workspaceId) =>
  sessionCaller(db, app, person, workspaceId);
/** A key-mode user key with every scope: forget needs a person's approval. */
const userKey = (workspaceId = t.workspaceId): Caller => ({
  workspaceId,
  actor: { type: 'user', id: 'maya' } as Actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

const log = async (caller: Caller, input: Partial<LogEventInput> = {}) =>
  logEventFor(app, caller, {
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

const company = async (caller: Caller) =>
  (await createRecord(app, caller, 'company', { name: `Acme ${unique()}` })).record;

/** Rows private to a person in a workspace, per table, as the owner sees them. */
async function privateRows(userId: string, workspaceId = t.workspaceId) {
  const counts: Record<string, number> = {};
  for (const table of PRIVATE_TABLES) {
    const [row] = await db.owner<{ count: number }[]>`
      select count(*)::int as count from ${db.owner(table)}
      where workspace_id = ${workspaceId} and private_to_user = ${userId}`;
    counts[table] = row?.count ?? 0;
  }
  return counts;
}
const none = Object.fromEntries(PRIVATE_TABLES.map((table) => [table, 0]));

async function profileOf(userId: string, workspaceId = t.workspaceId) {
  const [row] = await db.owner<{ id: string }[]>`
    select r.id from records r join object_types o on o.id = r.object_type_id
    where r.workspace_id = ${workspaceId} and r.private_to_user = ${userId}
      and o.universal_id = ${MEMBER_PROFILE_TYPE_ID}`;
  return row?.id;
}

/** A person who is an editor of the team's workspaces, with a key that works for them. */
async function newMember(name = 'Member') {
  const person = await addPerson(db, name);
  await setOrganizationMember(db.owner, {
    organization: t.organizationId,
    email: person.email,
    role: 'member',
  });
  for (const id of [t.workspaceId, t.otherWorkspaceId]) {
    await setWorkspaceMember(db.owner, { workspace: id, email: person.email, role: 'editor' });
  }
  return { person, key: await agentFor(person) };
}

describe('workspace memory', () => {
  it('is seeded with every workspace, hidden from the schema', async () => {
    const rows = await db.owner<{ count: number }[]>`
      select count(*)::int as count from records r join object_types o on o.id = r.object_type_id
      where r.workspace_id = ${t.workspaceId} and o.universal_id = ${WORKSPACE_PROFILE_TYPE_ID}`;
    expect(rows[0]?.count).toBe(1);

    const described = await describeSchema(app, await agent());
    const names = described.objects.map((o) => o.nameSingular);
    expect(names).not.toContain('workspaceProfile');
    expect(names).not.toContain('memberProfile');
    const memory = described.builtIns.find((b) => b.name === 'memory');
    expect(memory?.profiles).toEqual(['workspace']);
    const forDana = await describeSchema(app, await agentFor(t.dana));
    expect(forDana.builtIns.find((b) => b.name === 'memory')?.profiles).toEqual([
      'workspace',
      'me',
    ]);
  });

  it('is written and read by every agent and person in the workspace', async () => {
    const writer = await agent();
    const written = await remember(app, writer, 'workspace', {
      text: 'We sell a 12-month plan; we never discount more than 15%.',
    });
    expect(written.fact).toMatchObject({ profile: 'workspace', sources: [{ internal: true }] });
    expect(written.fact).not.toHaveProperty('record');

    for (const reader of [await session(t.viewer), await agentFor(t.eli), await agent()]) {
      const pack = await contextFor(app, reader, 'workspace', { tokenBudget: 2000 });
      expect(pack).toMatchObject({ profile: 'workspace', label: 'Sales' });
      expect(pack.facts).toContainEqual(
        expect.objectContaining({ id: written.fact.id, writtenBy: writer.actor, internal: true }),
      );
    }
    const timeline = await timelineFor(app, await agent(), 'workspace', { limit: 50 });
    expect(timeline).toMatchObject({ profile: 'workspace' });
    expect(timeline.items.every((i) => i.kind === 'fact')).toBe(true);
    expect(timeline.items.map((i) => i.id)).toContain(written.fact.id);
  });
});

describe('personal memory', () => {
  it('is created on the first write, private to its person and per workspace', async () => {
    const { person, key } = await newMember('Noa');
    expect(await profileOf(person.id)).toBeUndefined();
    // Reading before any write: an empty memory, and no profile made.
    const empty = await contextFor(app, key, 'me', { tokenBudget: 2000 });
    expect(empty).toMatchObject({ profile: 'me', label: 'Noa', facts: [] });
    expect(await profileOf(person.id)).toBeUndefined();

    const fact = await remember(app, key, 'me', { text: 'Prefers short follow-ups.' });
    expect(fact.fact).toMatchObject({ profile: 'me', content: 'Prefers short follow-ups.' });
    expect(await profileOf(person.id)).toBeDefined();
    // The profile, the fact, its source and the note's rows are all private.
    const rows = await privateRows(person.id);
    expect(rows).toMatchObject({
      records: 2,
      facts: 1,
      fact_sources: 1,
      event_records: 1,
      event_links: 1,
      field_assertions: 1,
    });

    // The same person signed in sees it; nobody else does.
    const own = await contextFor(app, await session(person), 'me', { tokenBudget: 2000 });
    expect(own.facts.map((f) => f.id)).toEqual([fact.fact.id]);
    const other = await contextFor(app, await session(t.eli), 'me', { tokenBudget: 2000 });
    expect(other.facts).toEqual([]);
    // Nothing learned in one workspace surfaces in another (M7).
    const elsewhere = await contextFor(app, await agentFor(person, t.otherWorkspaceId), 'me', {
      tokenBudget: 2000,
    });
    expect(elsewhere.facts).toEqual([]);
  });

  it('is no_person for a credential that works for nobody', async () => {
    const key = await agent();
    await expect(remember(app, key, 'me', { text: 'x' })).rejects.toMatchObject({
      status: 422,
      code: 'no_person',
    });
    await expect(contextFor(app, key, 'me', { tokenBudget: 100 })).rejects.toMatchObject({
      code: 'no_person',
    });
    await expect(factsOf(app, key, 'me', 10)).rejects.toMatchObject({ code: 'no_person' });
  });

  it('works only with the memory tools: others answer profile_not_supported', async () => {
    const key = await agentFor(t.dana);
    await remember(app, key, 'me', { text: 'Writes to Israeli clients in Hebrew.' });
    const profile = (await profileOf(t.dana.id)) as string;
    for (const id of ['me', 'workspace', profile]) {
      await expect(readRecord(app, key, id)).rejects.toMatchObject({
        status: 422,
        code: 'profile_not_supported',
      });
    }
    await expect(
      upsertRecord(app, key, 'person', { id: profile, values: { name: 'x' } } as never),
    ).rejects.toMatchObject({ code: 'profile_not_supported' });
    await expect(
      log(key, { about: [profile], externalId: `about-${unique()}` }),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(createRecord(app, key, 'memberProfile', {})).rejects.toMatchObject({
      status: 404,
    });
    // Someone else's profile ID is not even found.
    await expect(readRecord(app, await agentFor(t.eli), profile)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('leak matrix', () => {
  it("hides a person's facts and notes from everyone else on every read path", async () => {
    const dana = await agentFor(t.dana);
    const writer = await agent();
    const acme = await company(writer);
    const call = await log(writer, { about: [acme.id], summary: 'Quarterly call' });
    const cited = await remember(app, dana, 'me', {
      text: 'Pineapple is the codeword Dana uses for renewals.',
      source: call.id,
      quote: 'pineapple secret quote',
    });
    const noted = await remember(app, dana, 'me', { text: 'Pineapple pizza on Fridays.' });
    const profile = (await profileOf(t.dana.id)) as string;
    const [note] = await db.owner<{ id: string }[]>`
      select source_record_id as id from fact_sources where fact_id = ${noted.fact.id}`;
    const secretIds = [cited.fact.id, noted.fact.id, profile, note?.id as string];

    const observers: [string, Caller][] = [
      ["another member's session", await session(t.eli)],
      ["another member's agent", await agentFor(t.eli)],
      ['a workspace admin', await session(t.admin)],
      ['an organization owner', await session(t.owner)],
      ['a key that works for nobody', await agent()],
    ];
    for (const [who, caller] of observers) {
      const leaked = (value: unknown) => {
        const text = JSON.stringify(value);
        for (const id of secretIds) expect(text, who).not.toContain(id);
        expect(text, who).not.toContain('ineapple');
      };
      leaked(await searchFor(app, caller, { query: 'pineapple', limit: 50 }));
      leaked(await contextFor(app, caller, acme.id, { tokenBudget: 16000 }));
      leaked(await timelineFor(app, caller, acme.id, { limit: 200 }));
      leaked(await timelineFor(app, caller, call.id, { limit: 200 }));
      leaked(await contextFor(app, caller, 'workspace', { tokenBudget: 16000 }));
      if (caller.person) leaked(await contextFor(app, caller, 'me', { tokenBudget: 16000 }));
      const schema = await withRead(app, caller, (tx) => getSchema(tx, t.workspaceId));
      for (const object of schema.objectsByName.keys()) {
        leaked(await findRecords(app, caller, object, { limit: 200 } as never));
      }
      leaked(await findEvents(app, caller, { limit: 200 } as never));
      leaked(await withRead(app, caller, (tx, s) => reviewPage(tx, t.workspaceId, s, 200, {})));
      for (const id of [profile, note?.id as string]) {
        await expect(readRecord(app, caller, id), who).rejects.toMatchObject({ status: 404 });
        await expect(factsOf(app, caller, id, 10), who).rejects.toMatchObject({ status: 404 });
      }
      // Row-level security, not the application, does this.
      const [seen] = await withRead(
        app,
        caller,
        (tx) => tx<{ count: number }[]>`
          select count(*)::int as count from facts where private_to_user is not null`,
      );
      expect(seen?.count, who).toBe(0);
    }

    // Dana's own agent sees both, citing the shared call.
    const own = await contextFor(app, dana, 'me', { tokenBudget: 4000 });
    expect(own.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining([cited.fact.id, noted.fact.id]),
    );
    const found = await searchFor(app, dana, { query: 'pineapple', limit: 10 });
    expect(found.facts.map((f) => f.profile)).toEqual(['me', 'me']);
  });

  it('is invisible to the consolidator, which still deduplicates workspace memory', async () => {
    const { person, key } = await newMember('Dup');
    const writer = await agent();
    // Duplicates are the same text from the same source (4.2).
    const call = await log(writer);
    const twice = async (caller: Caller, record: string, text: string) => [
      await remember(app, caller, record, { text, source: call.id }),
      await remember(app, caller, record, { text, source: call.id }),
    ];
    const [m1, m2] = await twice(key, 'me', `Personal duplicate ${unique()}`);
    const [w1, w2] = await twice(writer, 'workspace', `Workspace duplicate ${unique()}`);
    await consolidateWorkspace(app, t.workspaceId);
    const status = async (id: string | undefined) =>
      (
        await db.owner<{ superseded: boolean }[]>`
          select superseded_by is not null as superseded from facts where id = ${id ?? ''}`
      )[0]?.superseded;
    expect(await status(m1?.fact.id)).toBe(false);
    expect(await status(m2?.fact.id)).toBe(false);
    expect([await status(w1?.fact.id), await status(w2?.fact.id)].sort()).toEqual([false, true]);
    expect((await privateRows(person.id)).facts).toBe(2);
  });
});

describe('row-level security without the app', () => {
  it('shows a raw query with only the workspace set no private row, and refuses to write one', async () => {
    const { person, key } = await newMember('Raw');
    await remember(app, key, 'me', { text: 'Raw private fact' }, `raw-${unique()}`);
    const visible = await inWorkspace(app, t.workspaceId, async (tx) => {
      const counts: Record<string, number> = {};
      for (const table of PRIVATE_TABLES) {
        const [row] = await tx<{ count: number }[]>`
          select count(*)::int as count from ${tx(table)} where private_to_user is not null`;
        counts[table] = row?.count ?? 0;
      }
      return counts;
    });
    expect(visible).toEqual(none);
    expect((await privateRows(person.id)).idempotency_keys).toBe(1);

    // Another person's transaction cannot write a row private to someone else…
    const profile = (await profileOf(person.id)) as string;
    await expect(
      inWorkspace(
        app,
        t.workspaceId,
        (tx) => tx`
          insert into idempotency_keys (workspace_id, operation, key, request_hash, expires_at,
            private_to_user)
          values (${t.workspaceId}, 'x', 'x', 'x', now(), ${person.id})`,
        t.eli.id,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // …nor a shared child of their private record: the parent is not visible.
    await expect(
      inWorkspace(
        app,
        t.workspaceId,
        (tx) => tx`
          insert into facts (workspace_id, record_id, content, kind, valid_from, actor)
          values (${t.workspaceId}, ${profile}, 'planted', 'stated', now(),
            ${tx.json({ type: 'agent', id: 'x' })})`,
        t.eli.id,
      ),
    ).rejects.toThrow(/not visible/);
  });
});

describe('concurrency', () => {
  it('makes one profile from two first writes to me, without a lock upgrade', async () => {
    for (let i = 0; i < 5; i++) {
      const { person, key } = await newMember(`First${i}`);
      const signedIn = await session(person);
      const results = await Promise.all([
        remember(app, key, 'me', { text: 'From the agent' }),
        remember(app, signedIn, 'me', { text: 'From the session' }),
        remember(app, key, 'me', { text: 'From the agent again' }),
      ]);
      expect(results).toHaveLength(3);
      const profiles = await db.owner<{ count: number }[]>`
        select count(*)::int as count from records r join object_types o on o.id = r.object_type_id
        where r.workspace_id = ${t.workspaceId} and r.private_to_user = ${person.id}
          and o.universal_id = ${MEMBER_PROFILE_TYPE_ID}`;
      expect(profiles[0]?.count).toBe(1);
    }
  });

  it('either deletes a racing remember(me) with the member, or refuses it', async () => {
    for (let i = 0; i < 6; i++) {
      const { person, key } = await newMember(`Race${i}`);
      await remember(app, key, 'me', { text: 'Before the race' });
      const [write, removal] = await Promise.allSettled([
        remember(app, key, 'me', { text: `During the race ${i}` }),
        removeFromWorkspace(control, t.admin, t.workspaceId, person.id),
      ]);
      expect(removal.status).toBe('fulfilled');
      if (write.status === 'rejected') {
        expect(write.reason).toMatchObject({ status: 403, code: 'not_a_member' });
      }
      expect(await privateRows(person.id)).toEqual(none);
    }
  });

  it('either deletes a racing move out of me with the member, or refuses it', async () => {
    const writer = await agent();
    for (let i = 0; i < 4; i++) {
      const { person, key } = await newMember(`Move${i}`);
      const acme = await company(writer);
      const fact = await remember(app, key, 'me', { text: `Acme's legal takes two weeks ${i}` });
      const [move, removal] = await Promise.allSettled([
        remember(app, key, acme.id, { text: fact.fact.content, supersedes: fact.fact.id }),
        removeFromWorkspace(control, t.admin, t.workspaceId, person.id),
      ]);
      expect(removal.status).toBe('fulfilled');
      expect(await privateRows(person.id)).toEqual(none);
      const shared = await factsOf(app, writer, acme.id, 10);
      if (move.status === 'fulfilled') {
        // The move committed first: its published copy stays with Acme.
        expect(shared.facts.map((f) => f.content)).toEqual([fact.fact.content]);
        expect(shared.facts[0]?.sources).toEqual([{ event: null, internal: true, quote: null }]);
      } else {
        expect(move.reason).toMatchObject({ status: 403 });
        expect(shared.facts).toEqual([]);
      }
    }
  });

  it('makes a search during a removal wait for it, then refuses it', async () => {
    const { person, key } = await newMember('Searcher');
    const word = `kiwi${randomBytes(3).toString('hex')}`;
    await remember(app, key, 'me', { text: `Prefers ${word} on Fridays` });
    let release = () => {};
    const removing = db.owner.begin(async (tx) => {
      // What removal holds while it deletes the membership and the memory.
      await lockMemberExclusive(tx as unknown as Tx, t.workspaceId, person.id);
      await tx`delete from workspace_members
        where workspace_id = ${t.workspaceId} and user_id = ${person.id}`;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    let settled = false;
    const search = searchFor(app, key, { query: word, limit: 10 }).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await removing;
    await expect(search).rejects.toMatchObject({ status: 403, code: 'not_a_member' });
  });

  it('never replays a stored response after its person left', async () => {
    const { person, key } = await newMember('Replay');
    const idempotencyKey = `replay-${unique()}`;
    const first = await remember(app, key, 'me', { text: 'Replayed fact' }, idempotencyKey);
    const [replay, removal] = await Promise.allSettled([
      remember(app, key, 'me', { text: 'Replayed fact' }, idempotencyKey),
      removeFromWorkspace(control, t.admin, t.workspaceId, person.id),
    ]);
    expect(removal.status).toBe('fulfilled');
    if (replay.status === 'fulfilled') expect(replay.value).toEqual(first);
    else expect(replay.reason).toMatchObject({ status: 403 });
    // Afterwards the same caller gets a refusal, never the stored response.
    await expect(
      remember(app, key, 'me', { text: 'Replayed fact' }, idempotencyKey),
    ).rejects.toMatchObject({ status: 403, code: 'not_a_member' });
    expect(await privateRows(person.id)).toEqual(none);
  });
});

describe('leaving a workspace', () => {
  /** A member with a key, personal facts citing a shared call and a note, and a stored response. */
  async function withMemory(name: string) {
    const member = await newMember(name);
    const writer = await agent();
    const call = await log(writer, { summary: `Call with ${name}` });
    await remember(app, member.key, 'me', {
      text: `${name} learned this on a call`,
      source: call.id,
      quote: 'a quote',
    });
    await remember(app, member.key, 'me', { text: `${name} likes tea` }, `leave-${unique()}`);
    const elsewhere = await agentFor(member.person, t.otherWorkspaceId);
    await remember(app, elsewhere, 'me', { text: `${name} in support` });
    const rows = await privateRows(member.person.id);
    expect(rows).toMatchObject({ facts: 2, idempotency_keys: 1 });
    return { ...member, call };
  }

  const keyRevoked = async (keyId: string) =>
    (
      await db.owner<{ revoked: boolean }[]>`
        select revoked_at is not null as revoked from api_keys where id = ${keyId}`
    )[0]?.revoked;

  it('deletes their memory there, revokes keys that work for them, and keeps shared events', async () => {
    const { person, key, call } = await withMemory('Leaver');
    await removeFromWorkspace(control, t.admin, t.workspaceId, person.id);
    expect(await privateRows(person.id)).toEqual(none);
    expect(await keyRevoked(key.keyId)).toBe(true);
    // The shared call they cited is untouched.
    expect(await readRecord(app, await agent(), call.id)).toMatchObject({ id: call.id });
    // Their memory in the workspace they still belong to stays.
    expect((await privateRows(person.id, t.otherWorkspaceId)).facts).toBe(1);
    const [audit] = await db.owner<{ actor_id: string; counts: Record<string, number> }[]>`
      select actor_id, counts from deletion_audit_log
      where workspace_id = ${t.workspaceId} and counts ? 'personalMemory'
      order by created_at desc limit 1`;
    expect(audit).toEqual({
      actor_id: t.admin.id,
      counts: { personalMemory: 1, profiles: 1, facts: 2, notes: 1, responses: 1 },
    });
  });

  it('deletes their memory in every workspace when they leave the organization', async () => {
    const { person } = await withMemory('OrgLeaver');
    await removeFromOrganization(control, t.owner, t.organizationId, person.id);
    expect(await privateRows(person.id)).toEqual(none);
    expect(await privateRows(person.id, t.otherWorkspaceId)).toEqual(none);
  });

  it('deletes their memory where a lower organization role ends their access', async () => {
    const person = await addPerson(db, 'Demoted');
    await setOrganizationMember(db.owner, {
      organization: t.organizationId,
      email: person.email,
      role: 'admin',
    });
    const key = await agentFor(person);
    await remember(app, key, 'me', { text: 'Admin preference' });
    await setOrganizationRole(control, t.owner, t.organizationId, person.id, 'member');
    expect(await privateRows(person.id)).toEqual(none);
    expect(await keyRevoked(key.keyId)).toBe(true);
  });

  it('deletes their memory with their account', async () => {
    const { person } = await withMemory('Deleted');
    await db.owner`delete from users where id = ${person.id}`;
    expect(await privateRows(person.id)).toEqual(none);
    expect(await privateRows(person.id, t.otherWorkspaceId)).toEqual(none);
  });
});

describe('Clear all', () => {
  it('lets any member, a viewer too, clear their own memory, keeping membership and keys', async () => {
    const viewerKey = await agentFor(t.viewer);
    await remember(app, viewerKey, 'me', { text: 'Viewer preference' }, `clear-${unique()}`);
    const signedIn = await session(t.viewer);
    const cleared = await clearMyMemory(app, signedIn);
    expect(cleared).toEqual({
      cleared: true,
      counts: { profiles: 1, facts: 1, notes: 1, responses: 1 },
    });
    expect(await privateRows(t.viewer.id)).toEqual(none);
    // Still a member, and their agent still works for them.
    await remember(app, viewerKey, 'me', { text: 'After clearing' });
    expect((await privateRows(t.viewer.id)).facts).toBe(1);
  });

  it('refuses API keys, OAuth agents and key mode', async () => {
    const key = await agentFor(t.dana);
    await expect(clearMyMemory(app, key)).rejects.toMatchObject({ status: 403 });
    const oauth: Caller = {
      ...key,
      connectedBy: t.dana.id,
      person: {
        id: t.dana.id,
        name: 'Dana',
        check: { kind: 'oauth', subject: t.dana.id, workspace: t.workspaceId, client: 'c' },
      },
    };
    await expect(clearMyMemory(app, oauth)).rejects.toMatchObject({ status: 403 });
    await expect(clearMyMemory(app, userKey())).rejects.toMatchObject({ status: 403 });
  });
});

describe('retries', () => {
  it('gives two people using one key and one input independent results', async () => {
    const idempotencyKey = `shared-key-${unique()}`;
    const input = { text: 'Likes early meetings' };
    const dana = await remember(app, await agentFor(t.dana), 'me', input, idempotencyKey);
    const eli = await remember(app, await agentFor(t.eli), 'me', input, idempotencyKey);
    expect(dana.fact.id).not.toBe(eli.fact.id);
    // Each replays their own.
    expect(await remember(app, await session(t.eli), 'me', input, idempotencyKey)).toEqual(eli);
    const rows = await db.owner<{ private_to_user: string }[]>`
      select private_to_user from idempotency_keys where key = ${idempotencyKey} order by 1`;
    expect(rows.map((r) => r.private_to_user).sort()).toEqual([t.dana.id, t.eli.id].sort());
  });

  it('keeps the response to a move from me to a shared record private', async () => {
    const key = await agentFor(t.dana);
    const acme = await company(await agent());
    const fact = await remember(app, key, 'me', { text: `Acme pays late ${unique()}` });
    const idempotencyKey = `move-${unique()}`;
    await remember(
      app,
      key,
      acme.id,
      { text: fact.fact.content, supersedes: fact.fact.id },
      idempotencyKey,
    );
    const [row] = await db.owner<{ private_to_user: string | null }[]>`
      select private_to_user from idempotency_keys where key = ${idempotencyKey}`;
    expect(row?.private_to_user).toBe(t.dana.id);
  });
});

describe('source erasure', () => {
  it("erases other people's private citations, quotes and orphaned facts, and tells nobody", async () => {
    const writer = await agent();
    const contact = (
      await createRecord(app, writer, 'person', { emails: `erase-${unique()}@acme.test` })
    ).record;
    const call = await log(writer, { participants: [{ recordId: contact.id }] });
    const other = await log(writer, { summary: 'Unrelated call' });
    const dana = await agentFor(t.dana);
    const eli = await agentFor(t.eli);
    const danaOnly = await remember(
      app,
      dana,
      'me',
      { text: `Dana's take ${unique()}`, source: call.id, quote: 'dana private quote' },
      `erase-${unique()}`,
    );
    const eliOnly = await remember(app, eli, 'me', {
      text: `Eli's take ${unique()}`,
      source: call.id,
      quote: 'eli private quote',
    });
    // A fact with two sources keeps the one that survives. Moves copy
    // citations, so a moved copy of a two-source fact is the way to make one.
    const twoSources = await remember(app, dana, 'me', {
      text: `Two sources ${unique()}`,
      source: other.id,
    });
    await db.owner`
      insert into fact_sources (workspace_id, fact_id, source_record_id, quote)
      values (${t.workspaceId}, ${twoSources.fact.id}, ${call.id}, 'second quote')`;

    const result = await forget(app, userKey(), contact.id);
    const text = JSON.stringify(result);
    for (const id of [danaOnly.fact.id, eliOnly.fact.id, twoSources.fact.id]) {
      expect(text).not.toContain(id);
    }
    // Counts are of shared rows only: no private fact is counted.
    expect(result.counts.facts).toBe(0);

    const facts = await db.owner<{ id: string }[]>`
      select id from facts where id = any(${[danaOnly.fact.id, eliOnly.fact.id, twoSources.fact.id]}::uuid[])`;
    expect(facts.map((f) => f.id)).toEqual([twoSources.fact.id]);
    const quotes = await db.owner<{ quote: string | null; source: string | null }[]>`
      select quote, source_record_id as source from fact_sources
      where quote like '%private quote' or fact_id = ${twoSources.fact.id}`;
    expect(quotes).toEqual([{ quote: null, source: other.id }]);
    const cached = await db.owner`
      select 1 from idempotency_keys where strpos(result::text, ${call.id}) > 0`;
    expect(cached).toHaveLength(0);
  });

  it('runs only inside forget: never across workspaces, never on a profile', async () => {
    const key = await agentFor(t.dana);
    await remember(app, key, 'me', { text: 'Survives a direct call' });
    const profile = (await profileOf(t.dana.id)) as string;
    const before = await privateRows(t.dana.id);
    // Without the privacy lock.
    await expect(
      inWorkspace(
        app,
        t.workspaceId,
        (tx) =>
          tx`select retainer_erase_private_derivatives(${t.workspaceId}, ${[profile]}::uuid[])`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Another workspace than the transaction's.
    await expect(
      inWorkspace(
        app,
        t.workspaceId,
        (tx) =>
          tx`select retainer_erase_private_derivatives(${t.otherWorkspaceId}, ${[profile]}::uuid[])`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // With the lock, a profile's ID is ignored and nothing comes back.
    const [returned] = await inWorkspace(app, t.workspaceId, async (tx) => {
      await tx`select pg_advisory_xact_lock(${0x5250}::int4, hashtext(${t.workspaceId}))`;
      return tx`select retainer_erase_private_derivatives(${t.workspaceId}, ${[profile]}::uuid[]) as r`;
    });
    expect(returned).toEqual({ r: '' });
    expect(await privateRows(t.dana.id)).toEqual(before);
  });

  it('never lets a shared fact cite a private note or fact, even the caller’s own', async () => {
    const key = await agentFor(t.dana);
    const noted = await remember(app, key, 'me', { text: 'My own private note' });
    const [note] = await db.owner<{ id: string }[]>`
      select source_record_id as id from fact_sources where fact_id = ${noted.fact.id}`;
    const acme = await company(key);
    for (const source of [note?.id as string, noted.fact.id]) {
      await expect(
        remember(app, key, acme.id, { text: 'Cites private', source }),
      ).rejects.toMatchObject({ status: 422, code: 'invalid_source' });
    }
  });
});
