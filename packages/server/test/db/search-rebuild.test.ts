import { readFileSync } from 'node:fs';
import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { logEventFor, remember } from '../../src/memory/service.js';
import { rebuildSearchText } from '../../src/records/rebuild-search.js';
import { createRecord, mergeRecord } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Sql;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };

/**
 * The data statements of migration 0010, which rewrites every stored vector.
 * Its `interactions` statement is left out: migration 0013 dropped that
 * table, and events are records, rebuilt with the rest.
 */
const migration = readFileSync(
  new URL('../../drizzle/0010_search_fold.sql', import.meta.url),
  'utf8',
)
  .split('--> statement-breakpoint')
  .filter((statement) => !statement.includes('CREATE FUNCTION'))
  .filter((statement) => !statement.includes('"interactions"'));

/** Every stored search vector, by table and ID. */
async function vectors(): Promise<Record<string, string | null>> {
  const rows = await db.owner<{ key: string; search: string | null }[]>`
    select 'records:' || id as key, search::text from records
    union all select 'facts:' || id, search::text from facts`;
  return Object.fromEntries(rows.map((r) => [r.key, r.search]));
}

async function runMigration(): Promise<void> {
  for (const statement of migration) await db.owner.unsafe(statement);
}

const nothingStale = async () =>
  (
    await db.owner<{ count: number }[]>`
    select count(*)::int as count from records where search is null and merged_into_id is null`
  )[0]?.count;

const mergedIds: string[] = [];

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 10 });
  // Two workspaces, so the rebuild uses each one's own schema.
  for (const name of ['Search A', 'Search B']) {
    const workspace = await createWorkspace(db.owner, { name, template: 'sales' });
    const as = (actor: Actor): Caller => ({
      workspaceId: workspace.id,
      actor,
      scopes: ['read', 'write', 'schema:write', 'admin'],
    });
    const acme = await createRecord(app, as(AGENT), 'company', {
      name: 'Société Générale',
      domain: 'https://www.acme.example/pricing',
    });
    const jose = await createRecord(app, as(AGENT), 'person', {
      name: 'José Muñoz',
      emails: 'jose@acme.example',
      company: acme.id,
    });
    const twin = await createRecord(app, as(AGENT), 'person', { name: 'José Muñoz' });
    const call = await logEventFor(app, as(AGENT), {
      type: 'conversation',
      channel: 'zoom',
      occurredAt: '2026-10-01T10:00:00Z',
      title: 'Café kickoff',
      summary: 'Pricing for the Zürich office.',
      fields: {},
      participants: [{ recordId: jose.id }],
      about: [],
    });
    await remember(app, as(AGENT), jose.id, { text: 'Prefers crème brûlée', source: call.id });
    // An uncited fact also logs an internal note event with no title.
    await remember(app, as(AGENT), jose.id, { text: 'Lives in Malmö' });
    mergedIds.push((await mergeRecord(app, as(USER), jose.id, { recordId: twin.id })).mergedId);
  }
});

describe('rebuilding search text after migration 0010 (5.1)', () => {
  it('ends with the vectors the write path stores, in batches', async () => {
    const written = await vectors();
    for (const id of mergedIds) expect(written[`records:${id}`]).toBeNull();

    await runMigration();
    // Three records, two events and each workspace's profile, in both workspaces.
    expect(await nothingStale()).toBe(10);
    // Facts are already rewritten by the migration.
    expect(Object.entries(await vectors()).filter(([key]) => !key.startsWith('records:'))).toEqual(
      Object.entries(written).filter(([key]) => !key.startsWith('records:')),
    );

    // Four records per workspace (a company, a person, the call and the
    // internal note) in batches of two: two full batches, then an empty one.
    expect(await rebuildSearchText(db.connect({ max: 1 }), { batch: 2 })).toBe(10);
    expect(await vectors()).toEqual(written);
    expect(await rebuildSearchText(db.connect({ max: 1 }))).toBe(0);
  });

  it('folds accents and indexes email and link domains', async () => {
    const text = Object.values(await vectors()).join(' ');
    for (const lexeme of ["'societe'", "'munoz'", "'cafe'", "'zurich'", "'malmo'", "'creme'"]) {
      expect(text).toContain(lexeme);
    }
    expect(text).toContain("'acme.example'");
    expect(text).not.toContain('é');
  });

  it('rebuilds each record once when several servers boot together', async () => {
    const written = await vectors();
    await runMigration();
    const runs = await Promise.all(
      Array.from({ length: 3 }, () => rebuildSearchText(db.connect({ max: 1 }), { batch: 1 })),
    );
    expect(runs.reduce((sum, n) => sum + n, 0)).toBe(10);
    expect(await nothingStale()).toBe(0);
    expect(await vectors()).toEqual(written);
  });
});
