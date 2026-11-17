import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { factsOf, logEventFor, remember, retractFactFor } from '../../src/memory/service.js';
import { reviewPage } from '../../src/reads/review.js';
import {
  createRecord,
  dismissSuggestion,
  mergeRecord,
  withRead,
} from '../../src/records/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import { consolidateWorkspace } from '../../src/worker/consolidate.js';
import { startWorker } from '../../src/worker/index.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Sql;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const caller = (workspaceId: string, actor: Actor = AGENT): Caller => ({
  workspaceId,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});

const reviewQueue = (sql: Sql, caller: Caller, limit: number) =>
  withRead(sql, caller, (tx, schema) => reviewPage(tx, caller.workspaceId, schema, limit, {}));

beforeAll(() => {
  app = db.connect({ role: RUNTIME_ROLE, max: 30 });
});

let n = 0;
const newWorkspace = async () =>
  (await createWorkspace(db.owner, { name: `Consolidate ${++n}`, template: 'sales' })).id;
const email = () => `consolidate${++n}@acme.test`;

async function call(ws: string, occurredAt = '2026-10-01T10:00:00Z', title?: string) {
  return logEventFor(app, caller(ws), {
    type: 'conversation',
    channel: 'zoom',
    occurredAt,
    ...(title !== undefined ? { title } : {}),
    fields: {},
    participants: [],
    about: [],
  });
}

async function suggestions(ws: string) {
  return db.owner<{ a: string; b: string; reason: string; status: string }[]>`
    select record_a_id as a, record_b_id as b, reason, status from merge_suggestions
    where workspace_id = ${ws} order by reason, a`;
}

const pair = (x: string, y: string) => [x, y].sort() as [string, string];

describe('fact dedupe (4.2)', () => {
  it('supersedes exact duplicates with the oldest, which gains every source', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(app, caller(ws), 'person', { emails: email() });
    const first = await call(ws);
    const second = await call(ws);
    const original = await remember(app, caller(ws), dana.id, {
      text: 'Renewal is due in March',
      source: first.id,
    });
    const duplicate = await remember(app, caller(ws), dana.id, {
      text: '  renewal is  due in March ',
      source: second.id,
      quote: 'March renewal',
    });

    const stats = await consolidateWorkspace(app, ws);
    expect(stats).toEqual({ supersededFacts: 1, mergeSuggestions: 0 });

    const facts = (await factsOf(app, caller(ws), dana.id, 10)).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]?.id).toBe(original.fact.id);
    expect(facts[0]?.sources).toEqual(
      expect.arrayContaining([
        { event: first.id, quote: null },
        { event: second.id, quote: 'March renewal' },
      ]),
    );
    const [kept] = await db.owner<{ superseded_by: string; deleted_at: Date | null }[]>`
      select superseded_by, deleted_at from facts where id = ${duplicate.fact.id}`;
    expect(kept).toEqual({ superseded_by: original.fact.id, deleted_at: null });

    // Running again changes nothing.
    expect(await consolidateWorkspace(app, ws)).toEqual({
      supersededFacts: 0,
      mergeSuggestions: 0,
    });
  });

  it('finds duplicates a later merge brings together, comparing only changed records', async () => {
    const ws = await newWorkspace();
    // Records with facts but no field values: a merge moves facts only.
    const a = await createRecord(app, caller(ws), 'person', {});
    const b = await createRecord(app, caller(ws), 'person', {});
    const source = await call(ws);
    await remember(app, caller(ws), a.id, { text: 'Owns the budget', source: source.id });
    await remember(app, caller(ws), b.id, { text: 'Owns the budget', source: source.id });
    expect(await consolidateWorkspace(app, ws)).toMatchObject({ supersededFacts: 0 });

    // Old facts, new neighbours: the merge touched A, so the next run looks at it.
    await db.owner`
      update consolidator_runs set compared_until = now() where workspace_id = ${ws}`;
    await mergeRecord(app, caller(ws, USER), a.id, { recordId: b.id });
    expect(await consolidateWorkspace(app, ws)).toMatchObject({ supersededFacts: 1 });
    expect((await factsOf(app, caller(ws), a.id, 10)).facts).toHaveLength(1);
  });

  it('keeps the same text at different times, near-duplicates and other records apart', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(app, caller(ws), 'person', { emails: email() });
    const ron = await createRecord(app, caller(ws), 'person', { emails: email() });
    const october = await call(ws, '2026-10-01T10:00:00Z');
    const september = await call(ws, '2026-09-01T10:00:00Z');
    await remember(app, caller(ws), dana.id, { text: 'Asked for a discount', source: october.id });
    await remember(app, caller(ws), dana.id, {
      text: 'Asked for a discount',
      source: september.id,
    });
    await remember(app, caller(ws), dana.id, { text: 'Asked for a discount.', source: october.id });
    await remember(app, caller(ws), ron.id, { text: 'Asked for a discount', source: october.id });

    expect(await consolidateWorkspace(app, ws)).toMatchObject({ supersededFacts: 0 });
    expect((await factsOf(app, caller(ws), dana.id, 10)).facts).toHaveLength(3);
  });

  it('never supersedes a duplicate with a fact retracted while it ran', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(app, caller(ws), 'person', { emails: email() });
    const source = await call(ws);
    const original = await remember(app, caller(ws), dana.id, {
      text: 'Likes golf',
      source: source.id,
    });
    const duplicate = await remember(app, caller(ws), dana.id, {
      text: 'Likes golf',
      source: source.id,
    });

    // Hold the canonical fact, let the consolidator find the pair and wait
    // on it, then retract the fact and let go.
    let locked!: () => void;
    let release!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retraction = db.owner.begin(async (tx) => {
      await tx`select id from facts where id = ${original.fact.id} for update`;
      locked();
      await released;
      await tx`update facts set deleted_at = now() where id = ${original.fact.id}`;
    });
    await isLocked;
    const run = consolidateWorkspace(app, ws);
    for (let i = 0; i < 100; i++) {
      const [waiting] = await db.owner<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity
        where datname = ${db.name} and wait_event_type = 'Lock'`;
      if ((waiting?.count ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await retraction;
    expect(await run).toMatchObject({ supersededFacts: 0 });

    const live = (await factsOf(app, caller(ws), dana.id, 10)).facts;
    expect(live.map((f) => f.id)).toEqual([duplicate.fact.id]);
  });

  it('runs alongside a fact retraction without failing', async () => {
    for (let round = 0; round < 5; round++) {
      const ws = await newWorkspace();
      const dana = await createRecord(app, caller(ws), 'person', { emails: email() });
      const source = await call(ws);
      const original = await remember(app, caller(ws), dana.id, {
        text: 'Plays tennis',
        source: source.id,
      });
      await remember(app, caller(ws), dana.id, { text: 'Plays tennis', source: source.id });
      const results = await Promise.allSettled([
        consolidateWorkspace(app, ws),
        retractFactFor(app, caller(ws, USER), original.fact.id),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await factsOf(app, caller(ws), dana.id, 10)).facts.length).toBeLessThanOrEqual(1);
    }
  });
});

describe('merge suggestions (4.2)', () => {
  it('suggests records sharing a phone or a domain, and similar names, once per pair', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(app, caller(ws), 'person', {
      name: 'Dana Cohen',
      emails: email(),
      phones: '+972 54 111 2233',
    });
    const danaHome = await createRecord(app, caller(ws), 'person', {
      name: 'D. C.',
      emails: email(),
      phones: '+972-54-111-2233',
    });
    const danaTypo = await createRecord(app, caller(ws), 'person', {
      name: 'Dana Coheen',
      emails: email(),
    });
    await createRecord(app, caller(ws), 'person', { name: 'Ron Peretz', emails: email() });
    const acme = await createRecord(app, caller(ws), 'company', {
      name: 'Acme',
      domain: 'https://acme.example',
    });
    const acme2 = await createRecord(app, caller(ws), 'company', {
      name: 'ACME Industries',
      domain: 'http://www.acme.example/?utm_source=mail',
    });
    // Same name, different object: never suggested.
    await createRecord(app, caller(ws), 'task', { title: 'Dana Cohen' });

    const stats = await consolidateWorkspace(app, ws);
    expect(stats?.mergeSuggestions).toBe(3);
    const rows = await suggestions(ws);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          a: pair(acme.id, acme2.id)[0],
          b: pair(acme.id, acme2.id)[1],
          reason: 'shared domain',
          status: 'pending',
        },
        {
          a: pair(dana.id, danaHome.id)[0],
          b: pair(dana.id, danaHome.id)[1],
          reason: 'shared phone',
          status: 'pending',
        },
        {
          a: pair(dana.id, danaTypo.id)[0],
          b: pair(dana.id, danaTypo.id)[1],
          reason: 'similar names',
          status: 'pending',
        },
      ]),
    );
    expect(rows).toHaveLength(3);
    // The reason never copies personal data.
    for (const row of rows)
      expect(row.reason).toMatch(/^(shared (email|phone|domain)|similar names)$/);

    const queue = await reviewQueue(app, caller(ws, USER), 100);
    expect(queue.mergeSuggestions).toHaveLength(3);
  });

  it('still suggests shared non-unique emails and requires a human decision', async () => {
    const ws = await newWorkspace();
    await inWorkspace(app, ws, (tx) =>
      runSchemaChange(tx, {
        workspaceId: ws,
        actor: USER,
        scopes: ['schema:write', 'admin'],
        operations: [
          {
            op: 'create_field',
            object: 'company',
            field: {
              name: 'billing',
              label: 'Billing email',
              type: 'emails',
            },
          },
        ],
      }),
    );
    for (const [name, billing] of [
      ['Granite', ' TEAM@example.test '],
      ['Pelican', 'team@example.test'],
    ]) {
      await createRecord(app, caller(ws), 'company', { name, billing });
    }
    expect((await consolidateWorkspace(app, ws))?.mergeSuggestions).toBe(1);
    expect((await suggestions(ws)).map(({ reason, status }) => ({ reason, status }))).toEqual([
      { reason: 'shared email', status: 'pending' },
    ]);
    const [suggestion] = await db.owner<{ id: string }[]>`
      select id from merge_suggestions where workspace_id = ${ws}`;
    await expect(
      dismissSuggestion(app, caller(ws), suggestion?.id as string),
    ).rejects.toMatchObject({ status: 403 });
    await dismissSuggestion(app, caller(ws, USER), suggestion?.id as string);
    expect((await consolidateWorkspace(app, ws))?.mergeSuggestions).toBe(0);
    expect((await suggestions(ws))[0]?.status).toBe('dismissed');
  });

  it('does not confuse Fijoya and Wiz through their shared LinkedIn host', async () => {
    const ws = await newWorkspace();
    for (const [name, slug] of [
      ['Fijoya', 'fijoya'],
      ['Wiz', 'wiz'],
    ]) {
      await createRecord(app, caller(ws), 'company', {
        name,
        domain: {
          primary: { url: `https://${slug}.example` },
          additional: [{ url: `https://linkedin.com/company/${slug}` }],
        },
      });
    }
    // Legacy domain identifiers stay broad; consolidation must not trust them.
    const ids = await db.owner`select value from record_identifiers
      where workspace_id = ${ws} and kind = 'domain' and value = 'linkedin.com'`;
    expect(ids).toHaveLength(2);
    expect((await consolidateWorkspace(app, ws))?.mergeSuggestions).toBe(0);
    expect(await suggestions(ws)).toEqual([]);
  });

  it.each([
    [
      'https://linkedin.com/company/fijoya',
      'http://WWW.linkedin.com/company/fijoya/?utm_source=mail',
      true,
    ],
    ['https://directory.example/profile?id=1', 'https://directory.example/profile?id=2', false],
    ['https://directory.example/?id=1', 'https://directory.example/?id=2', false],
    ['https://directory.example/a', 'https://directory.example/b', false],
    [
      'https://directory.example/a?id=1',
      'http://www.directory.example/a?id=1&utm_campaign=mail',
      true,
    ],
    ['https://linkedin.com', 'https://www.linkedin.com/?trk=nav', false],
    ['https://github.com', 'http://www.github.com/', false],
    ['https://acme.example', 'http://www.acme.example/?fbclid=123', true],
  ])('compares full link evidence: %s and %s', async (left, right, matches) => {
    const ws = await newWorkspace();
    for (const [name, url] of [
      ['Granite', left],
      ['Pelican', right],
    ]) {
      await createRecord(app, caller(ws), 'company', { name, domain: url });
    }
    expect((await consolidateWorkspace(app, ws))?.mergeSuggestions).toBe(matches ? 1 : 0);
    expect(await suggestions(ws)).toHaveLength(matches ? 1 : 0);
  });

  it('preserves existing pending and human-decided URL suggestions', async () => {
    const ws = await newWorkspace();
    const ids: string[] = [];
    for (const name of ['Granite', 'Pelican', 'Saffron']) {
      ids.push(
        (
          await createRecord(app, caller(ws), 'company', {
            name,
            domain: `https://linkedin.com/company/${name}`,
          })
        ).id,
      );
    }
    // Reproduce pre-fix rows without relying on the new matcher to create them.
    for (const [i, status] of ['pending', 'accepted', 'dismissed'].entries()) {
      const [a, b] = pair(ids[i % 3] as string, ids[(i + 1) % 3] as string);
      await db.owner`insert into merge_suggestions
        (workspace_id, record_a_id, record_b_id, reason, status)
        values (${ws}, ${a}, ${b}, 'shared domain', ${status})`;
    }
    const before = await suggestions(ws);
    expect((await consolidateWorkspace(app, ws))?.mergeSuggestions).toBe(0);
    expect(await suggestions(ws)).toEqual(before);
  });

  it('never suggests two events, however alike (6.2)', async () => {
    const ws = await newWorkspace();
    // Same type, same title, same time: still two things that happened.
    await call(ws, '2026-10-01T10:00:00Z', 'Weekly pipeline review');
    await call(ws, '2026-10-01T10:00:00Z', 'Weekly pipeline review');
    await call(ws, '2026-10-08T10:00:00Z', 'Weekly pipeline revue');
    // Entities with the same labels in the same run are still suggested.
    const a = await createRecord(app, caller(ws), 'company', { name: 'Weekly Pipeline Co' });
    const b = await createRecord(app, caller(ws), 'company', { name: 'Weekly Pipeline Co.' });

    const stats = await consolidateWorkspace(app, ws);
    expect(stats?.mergeSuggestions).toBe(1);
    expect(await suggestions(ws)).toEqual([
      {
        a: pair(a.id, b.id)[0],
        b: pair(a.id, b.id)[1],
        reason: 'similar names',
        status: 'pending',
      },
    ]);
  });

  it('does not suggest a dismissed pair again, and compares only changed records later', async () => {
    const ws = await newWorkspace();
    const a = await createRecord(app, caller(ws), 'person', { name: 'Noa Levi', emails: email() });
    const b = await createRecord(app, caller(ws), 'person', { name: 'Noa Levy', emails: email() });
    await consolidateWorkspace(app, ws);
    const [suggestion] = await db.owner<{ id: string }[]>`
      select id from merge_suggestions where workspace_id = ${ws}`;
    await dismissSuggestion(app, caller(ws, USER), suggestion?.id as string);
    await consolidateWorkspace(app, ws);
    expect((await suggestions(ws)).map((s) => s.status)).toEqual(['dismissed']);
    expect([a.id, b.id]).toHaveLength(2);

    // A record created after the last run is compared on the next one.
    const c = await createRecord(app, caller(ws), 'person', { name: 'Noa Levi', emails: email() });
    expect((await consolidateWorkspace(app, ws))?.mergeSuggestions).toBe(2);
    const fresh = (await suggestions(ws)).filter((s) => s.status === 'pending');
    expect(fresh.flatMap((s) => [s.a, s.b])).toContain(c.id);
  });

  it('counts only new pairs toward the cap and picks up the rest on the next run', async () => {
    const ws = await newWorkspace();
    const names = [
      ['Granite', 'Pelican'],
      ['Saffron', 'Quokka'],
      ['Tundra', 'Marble'],
      ['Violet', 'Harbor'],
    ];
    for (const [i, [x, y]] of names.entries()) {
      for (const name of [x, y]) {
        await createRecord(app, caller(ws), 'company', { name, domain: `d${i}-${n}.example` });
      }
    }
    const comparedUntil = async () =>
      (
        await db.owner<{ compared_until: Date | null }[]>`
          select compared_until from consolidator_runs where workspace_id = ${ws}`
      )[0]?.compared_until;
    const run = async () =>
      (await consolidateWorkspace(app, ws, { maxNewSuggestions: 2 }))?.mergeSuggestions;

    expect(await run()).toBe(2);
    expect(await comparedUntil()).toEqual(new Date(0));
    // A decided pair and a pending one do not use the next run's budget.
    const [first] = await suggestions(ws);
    await db.owner`update merge_suggestions set status = 'dismissed'
      where record_a_id = ${first?.a as string} and record_b_id = ${first?.b as string}`;
    expect(await run()).toBe(2);
    expect(await run()).toBe(0);
    expect((await comparedUntil())?.getTime()).toBeGreaterThan(0);

    const rows = await suggestions(ws);
    expect(rows).toHaveLength(4);
    expect(rows.every((s) => s.reason === 'shared domain')).toBe(true);
    expect(rows.filter((s) => s.status === 'dismissed')).toHaveLength(1);
  });
});

describe('scheduling (4.2)', () => {
  it('runs a workspace once at a time and skips it until the interval passes', async () => {
    const ws = await newWorkspace();
    const results = await Promise.all([
      consolidateWorkspace(app, ws, { minInterval: '1 hour' }),
      consolidateWorkspace(app, ws, { minInterval: '1 hour' }),
      consolidateWorkspace(app, ws, { minInterval: '1 hour' }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await consolidateWorkspace(app, ws, { minInterval: '1 hour' })).toBeNull();
    await db.owner`
      update consolidator_runs set started_at = now() - interval '2 hours' where workspace_id = ${ws}`;
    expect(await consolidateWorkspace(app, ws, { minInterval: '1 hour' })).not.toBeNull();
  });

  it('the worker finds due workspaces through the runtime role and consolidates them', async () => {
    const ws = await newWorkspace();
    const dana = await createRecord(app, caller(ws), 'person', { emails: email() });
    const source = await call(ws);
    await remember(app, caller(ws), dana.id, { text: 'Uses Slack', source: source.id });
    await remember(app, caller(ws), dana.id, { text: 'Uses Slack', source: source.id });

    const lines: string[] = [];
    const worker = await startWorker({
      sql: app,
      intervalMinutes: 60,
      tickMs: 60_000,
      log: { info: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
    });
    await worker.tick();
    await worker.stop();
    expect((await factsOf(app, caller(ws), dana.id, 10)).facts).toHaveLength(1);
    const [run] = await db.owner<{ stats: object }[]>`
      select stats from consolidator_runs where workspace_id = ${ws}`;
    expect(run?.stats).toEqual({ supersededFacts: 1, mergeSuggestions: 0 });
    expect(lines.some((l) => l.includes(ws))).toBe(true);
  });
});
