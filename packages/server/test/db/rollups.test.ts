import type { Actor, Via } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { attachedEventPage, eventHistory, type LogEventInput } from '../../src/memory/events.js';
import { logEventFor } from '../../src/memory/service.js';
import { createRecord, deleteRecord, patchRecord, withRead } from '../../src/records/service.js';
import { contextFor } from '../../src/retrieval/service.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { describeSchema } from '../../src/schema-engine/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

/**
 * Event rollups (spec 7.2): events attached to a record also show in the
 * history of the records it points at through a `rollUpEvents` field, one
 * hop, read-time, each event once.
 */

const db = useTestDatabase();
let app: Sql;
let workspaceId: string;

const AGENT: Actor = { type: 'agent', id: 'inbox' };
const USER: Actor = { type: 'user', id: 'maya' };
const as = (actor: Actor, ws = workspaceId): Caller => ({
  workspaceId: ws,
  actor,
  scopes: ['read', 'write', 'schema:write', 'admin'],
});
const schemaChange = (operations: SchemaOperation[], ws = workspaceId) =>
  inWorkspace(app, ws, (tx) =>
    runSchemaChange(tx, {
      workspaceId: ws,
      actor: USER,
      scopes: ['schema:write', 'admin'],
      operations,
    }),
  );
const rollUp = (object: string, field: string, on = true) =>
  schemaChange([{ op: 'update_field', object, field, rollUpEvents: on }]);

let n = 0;
/** Distinct, increasing times, so history order is the logging order reversed. */
const at = () => new Date(Date.UTC(2026, 0, 1) + ++n * 60_000).toISOString();
const log = (input: Partial<LogEventInput> = {}) =>
  logEventFor(app, as(AGENT), {
    type: 'conversation',
    channel: 'zoom',
    externalId: `evt-${++n}`,
    occurredAt: at(),
    title: 'Call',
    fields: {},
    participants: [],
    about: [],
    ...input,
  });
const create = (object: string, values: Record<string, unknown>) =>
  createRecord(app, as(AGENT), object, values);
const company = () => create('company', { name: `Co ${++n}` });
const person = () => create('person', { emails: `p${++n}@acme.test` });
const deal = (values: Record<string, unknown> = {}) =>
  create('deal', { name: `Deal ${++n}`, ...values });

const page = (recordId: string, limit = 50, cursor?: string) =>
  withRead(app, as(AGENT), (tx, schema) =>
    attachedEventPage(tx, schema, workspaceId, recordId, limit, cursor),
  );
const history = async (recordId: string): Promise<[string, Via][]> =>
  (await page(recordId)).items.map((e) => [e.id, e.via]);
const ids = async (recordId: string) => (await history(recordId)).map(([id]) => id);

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE, max: 20 });
  workspaceId = (await createWorkspace(db.owner, { name: 'Acme', template: 'sales' })).id;
  const result = await schemaChange([
    {
      op: 'create_field',
      object: 'deal',
      field: {
        name: 'contacts',
        label: 'Contacts',
        type: 'relation',
        settings: {
          targetObject: 'person',
          relationCardinality: 'many_to_many',
          rollUpEvents: true,
        },
      },
    },
    {
      op: 'create_field',
      object: 'deal',
      field: {
        name: 'customer',
        label: 'Customer',
        type: 'relation',
        settings: { targetObjects: ['company', 'person'], rollUpEvents: true },
      },
    },
    {
      op: 'create_field',
      object: 'company',
      field: {
        name: 'parent',
        label: 'Parent',
        type: 'relation',
        settings: { targetObject: 'company', rollUpEvents: true },
      },
    },
    {
      op: 'create_object',
      object: {
        nameSingular: 'invoice',
        namePlural: 'invoices',
        labelSingular: 'Invoice',
        labelPlural: 'Invoices',
        labelField: 'number',
        fields: [
          { name: 'number', label: 'Number', type: 'text' },
          {
            name: 'company',
            label: 'Company',
            type: 'relation',
            settings: { targetObject: 'company', rollUpEvents: true },
          },
        ],
      },
    },
    {
      op: 'create_object',
      object: {
        class: 'event',
        nameSingular: 'payment',
        namePlural: 'payments',
        labelSingular: 'Payment',
        labelPlural: 'Payments',
        fields: [
          {
            name: 'invoice',
            label: 'Invoice',
            type: 'relation',
            settings: { targetObject: 'invoice' },
          },
        ],
      },
    },
  ]);
  expect(result.status).toBe('applied');
  // deal.company is the sales template's; it starts off (7.2 defaults).
  expect((await rollUp('deal', 'company')).status).toBe('applied');
});

describe('the rollUpEvents setting', () => {
  it('is off by default on mutable affiliations and reported when on', async () => {
    const described = await describeSchema(app, as(AGENT));
    const settings = (object: string, field: string) =>
      described.objects.find((o) => o.nameSingular === object)?.fields.find((f) => f.name === field)
        ?.settings;
    expect(settings('person', 'company')?.rollUpEvents).toBeUndefined();
    expect(settings('deal', 'pointOfContact')?.rollUpEvents).toBeUndefined();
    expect(settings('deal', 'company')?.rollUpEvents).toBe(true);
  });

  it('changes without review, and can be turned off', async () => {
    const on = await rollUp('person', 'company');
    expect(on.status).toBe('applied');
    expect(on.change?.isDestructive).toBe(false);
    expect((await rollUp('person', 'company')).status).toBe('unchanged');
    expect((await rollUp('person', 'company', false)).status).toBe('applied');
  });

  it('is refused on inverses, event types and other field types', async () => {
    for (const [object, field] of [
      ['company', 'deals'],
      ['payment', 'invoice'],
      ['deal', 'amount'],
    ] as const) {
      await expect(rollUp(object, field)).rejects.toMatchObject({
        issues: [expect.objectContaining({ message: expect.stringContaining('rollUpEvents') })],
      });
    }
  });
});

describe('rolled-up history', () => {
  it('lists events attached to a record pointing at it, single, set and polymorphic', async () => {
    const [acme, dana] = [await company(), await person()];
    const single = await deal({ company: acme.id });
    const set = await deal({ contacts: [dana.id] });
    const poly = await deal({ customer: acme.id });
    const a = await log({ about: [single.id] });
    const b = await log({ participants: [{ recordId: set.id }] });
    const c = await log({ about: [poly.id] });

    expect(await history(acme.id)).toEqual([
      [c.id, { kind: 'rollup', field: 'customer', record: poly.id }],
      [a.id, { kind: 'rollup', field: 'company', record: single.id }],
    ]);
    expect(await history(dana.id)).toEqual([
      [b.id, { kind: 'rollup', field: 'contacts', record: set.id }],
    ]);
    // Direction is source to target only.
    const onAcme = await log({ about: [acme.id] });
    expect(await ids(single.id)).toEqual([a.id]);
    expect(await ids(acme.id)).toEqual([onAcme.id, c.id, a.id]);
  });

  it('follows the setting and the current relation', async () => {
    const [acme, globex] = [await company(), await company()];
    const d = await deal({ company: acme.id });
    const e = await log({ about: [d.id] });
    expect(await ids(acme.id)).toEqual([e.id]);

    await rollUp('deal', 'company', false);
    expect(await ids(acme.id)).toEqual([]);
    await rollUp('deal', 'company', true);
    expect(await ids(acme.id)).toEqual([e.id]);

    await patchRecord(app, as(USER), d.id, { values: { company: globex.id } });
    expect(await ids(acme.id)).toEqual([]);
    expect(await ids(globex.id)).toEqual([e.id]);

    await deleteRecord(app, as(USER), d.id);
    expect(await ids(globex.id)).toEqual([]);
  });

  it('rolls up one hop, whatever attached the event to the source', async () => {
    const [parent, child] = [await company(), await company()];
    await patchRecord(app, as(USER), child.id, { values: { parent: parent.id } });
    const invoice = await create('invoice', { number: `INV-${++n}`, company: child.id });
    // Attached to the invoice by the payment's own field (6.3), which does
    // not use up the hop: it rolls up once, to the child, never onward.
    const payment = await log({ type: 'payment', fields: { invoice: invoice.id } });
    const about = await log({ about: [invoice.id] });
    const onChild = await log({ participants: [{ recordId: child.id }] });

    expect(await history(invoice.id)).toEqual([
      [about.id, { kind: 'about' }],
      [payment.id, { kind: 'field', field: 'invoice' }],
    ]);
    expect(await history(child.id)).toEqual([
      [onChild.id, { kind: 'participant' }],
      [about.id, { kind: 'rollup', field: 'company', record: invoice.id }],
      [payment.id, { kind: 'rollup', field: 'company', record: invoice.id }],
    ]);
    // The parent gets the child's own events, not what the child has by rollup.
    expect(await history(parent.id)).toEqual([
      [onChild.id, { kind: 'rollup', field: 'parent', record: child.id }],
    ]);
  });

  it('lists an event once, by precedence, and picks one rollup path deterministically', async () => {
    const acme = await company();
    const [d1, d2] = [await deal({ company: acme.id }), await deal({ company: acme.id })];
    const both = await log({ about: [d1.id, d2.id] });
    const direct = await log({ about: [d1.id, acme.id] });
    const participant = await log({
      participants: [{ recordId: acme.id }],
      about: [acme.id, d2.id],
    });

    const first = [d1.id, d2.id].sort()[0];
    expect(await history(acme.id)).toEqual([
      [participant.id, { kind: 'participant' }],
      [direct.id, { kind: 'about' }],
      [both.id, { kind: 'rollup', field: 'company', record: first }],
    ]);

    // Two rollup fields: the smaller field ID wins, the same on every read.
    const poly = await deal({ company: acme.id, customer: acme.id });
    const twoFields = await log({ about: [poly.id] });
    const [via] = (await history(acme.id)).filter(([id]) => id === twoFields.id);
    const fields = await db.owner<{ name: string }[]>`
      select f.name from fields f join object_types o on o.id = f.object_type_id
      where o.workspace_id = ${workspaceId} and o.name_singular = 'deal'
        and f.name in ('company', 'customer')
      order by f.id limit 1`;
    expect(via?.[1]).toEqual({ kind: 'rollup', field: fields[0]?.name, record: poly.id });
  });

  it('pages through direct and rolled-up events without gaps or repeats', async () => {
    const acme = await company();
    const deals = [await deal({ company: acme.id }), await deal({ company: acme.id })];
    const logged: string[] = [];
    for (let i = 0; i < 7; i++) {
      const target = i % 3 === 0 ? acme.id : (deals[i % 2] as { id: string }).id;
      // Some events reach the company by both paths; they still count once.
      const about = i % 4 === 0 ? [target, (deals[0] as { id: string }).id] : [target];
      logged.unshift((await log({ about: [...new Set(about)] })).id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await page(acme.id, 3, cursor);
      seen.push(...result.items.map((e) => e.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(logged);
  });

  it('counts and budgets each event once in the context pack', async () => {
    const acme = await company();
    const [d1, d2] = [await deal({ company: acme.id }), await deal({ company: acme.id })];
    for (let i = 0; i < 6; i++) await log({ about: [d1.id, d2.id] });
    await log({ about: [acme.id, d1.id] });

    const full = await contextFor(app, as(AGENT), acme.id, { tokenBudget: 8000 });
    expect(full.recentEvents).toHaveLength(7);
    expect(full.omitted.recentEvents).toBe(0);
    expect(full.recentEvents[0]?.via).toEqual({ kind: 'about' });
    expect(full.recentEvents[1]?.via).toMatchObject({ kind: 'rollup', field: 'company' });

    const small = await contextFor(app, as(AGENT), acme.id, { tokenBudget: 250 });
    expect(small.recentEvents.length).toBeLessThan(7);
    expect(small.recentEvents.length + small.omitted.recentEvents).toBe(7);
  });

  it('finds open tasks through set and polymorphic relations, once each', async () => {
    await schemaChange([
      {
        op: 'create_field',
        object: 'task',
        field: {
          name: 'regarding',
          label: 'Regarding',
          type: 'relation',
          settings: { targetObjects: ['company', 'deal'], relationCardinality: 'many_to_many' },
        },
      },
    ]);
    const acme = await company();
    const d = await deal({ company: acme.id });
    const task = await create('task', { title: 'Follow up', regarding: [acme.id, d.id] });
    for (const id of [acme.id, d.id]) {
      const pack = await contextFor(app, as(AGENT), id, { tokenBudget: 4000 });
      expect(pack.openTasks.map((t) => t.id)).toEqual([task.id]);
    }
  });
});

describe('the rollup query on a large fan-out', () => {
  it('merges each source’s newest events by index, never the whole set', async () => {
    // DIAGNOSTIC (not for merge): log what this database is doing.
    const t0 = Date.now();
    const mark = (what: string) => console.log(`DIAG ${what} at ${Date.now() - t0}ms`);
    const spy = db.connect({ max: 1 });
    const dbName = db.name;
    const timer = setInterval(() => {
      void spy`
        select a.pid, a.state, a.wait_event_type, a.wait_event, a.backend_type,
          (now() - a.query_start)::text as running, pg_blocking_pids(a.pid) as blocked_by,
          left(regexp_replace(a.query, '\s+', ' ', 'g'), 400) as query
        from pg_stat_activity a
        where a.pid <> pg_backend_pid() and (a.datname = ${dbName} or a.backend_type <> 'client backend')
          and a.state is distinct from 'idle'`
        .then((rows) => console.log(`DIAG ${Date.now() - t0}ms activity`, JSON.stringify(rows)))
        .catch((e) => console.log('DIAG spy failed', e.message));
    }, 10_000);
    try {
      const ws = (await createWorkspace(db.owner, { name: 'Fan-out', template: 'sales' })).id;
      await schemaChange(
        [
          { op: 'update_field', object: 'deal', field: 'company', rollUpEvents: true },
          // An event relation field, so attachment through one is looked up too.
          {
            op: 'create_field',
            object: 'conversation',
            field: {
              name: 'deal',
              label: 'Deal',
              type: 'relation',
              settings: { targetObject: 'deal' },
            },
          },
        ],
        ws,
      );
      const acme = await createRecord(app, as(AGENT, ws), 'company', { name: 'Acme' });
      const other = await createRecord(app, as(AGENT, ws), 'company', { name: 'Other' });
      // More events per source than one page, so the per-source cut matters,
      // in a workspace far larger than the fan-out, as a real one is.
      const sources = 300;
      const perSource = 30;
      const fanOut = sources * perSource;
      await db.owner.begin(async (tx) => {
        // DIAGNOSTIC: log the plan of any statement, nested ones included, over 3 s.
        await tx`load 'auto_explain'`;
        await tx`set local auto_explain.log_min_duration = '3s'`;
        await tx`set local auto_explain.log_nested_statements = on`;
        await tx`set local auto_explain.log_analyze = on`;
        await tx`set local auto_explain.log_timing = off`;
        const [types] = await tx<{ deal: string; call: string; field: string }[]>`
        select d.id as deal, c.id as call, f.id as field
        from object_types d, object_types c, fields f
        where d.workspace_id = ${ws} and d.name_singular = 'deal'
          and c.workspace_id = ${ws} and c.name_singular = 'conversation'
          and f.object_type_id = d.id and f.name = 'company'`;
        if (!types) throw new Error('sales template objects missing');
        const actor = tx.json(AGENT);
        // Deals pointing at a company, each with events about it. Acme's are
        // the newest, after every one of the other company's.
        const seed = async (target: string, deals: number, offset: number) => {
          await tx`
          create temp table seed on commit drop as
          select gen_random_uuid() as deal_id, g as n from generate_series(1, ${deals}) g`;
          await tx`
          insert into records (id, workspace_id, object_type_id, data, created_by, updated_by)
          select deal_id, ${ws}, ${types.deal}, '{}'::jsonb, ${actor}, ${actor} from seed`;
          await tx`
          insert into record_links
            (workspace_id, field_id, source_record_id, target_record_id, created_by)
          select ${ws}, ${types.field}, deal_id, ${target}, ${actor} from seed`;
          await tx`
          create temp table seed_events on commit drop as
          select gen_random_uuid() as event_id, s.deal_id, ${offset} + s.n * ${perSource} + k as n
          from seed s cross join generate_series(1, ${perSource}) k`;
          await tx`
          insert into records (id, workspace_id, object_type_id, data, created_by, updated_by)
          select event_id, ${ws}, ${types.call}, '{}'::jsonb, ${actor}, ${actor}
          from seed_events`;
          await tx`
          insert into event_records (workspace_id, record_id, occurred_at, channel)
          select ${ws}, event_id, timestamptz '2025-01-01' + n * interval '1 minute', 'api'
          from seed_events`;
          await tx`
          insert into event_links (workspace_id, event_id, position, record_id, link)
          select ${ws}, event_id, 0, deal_id, 'about' from seed_events`;
          await tx`drop table seed, seed_events`;
        };
        const noise = 2000;
        await seed(other.id, noise, 0);
        await tx`set local auto_explain.log_min_duration = '5ms'`;
        await seed(acme.id, sources, (noise + 1) * perSource);
      });
      mark('seeded');
      await db.owner`analyze records, record_links, event_records, event_links`;
      mark('analyzed');

      const limit = 10;
      const [plan, newest] = await withRead(app, as(AGENT, ws), async (tx, schema) => {
        const history = () => eventHistory(tx, schema, ws, acme.id, { limit: limit + 1 });
        const [row] = await tx<{ 'QUERY PLAN': PlanRoot[] }[]>`
        explain (analyze, format json)
        select h.event_id from ${history()} h
        order by h.occurred_at desc, h.event_id desc limit ${limit + 1}`;
        const rows = await tx<{ event_id: string }[]>`
        select h.event_id from ${history()} h
        order by h.occurred_at desc, h.event_id desc limit ${limit + 1}`;
        return [row?.['QUERY PLAN'][0]?.Plan as PlanNode, rows];
      });

      mark('queried');
      console.log('DIAG plan', JSON.stringify(plan));
      // The newest events overall are the last-seeded ones.
      const expected = await db.owner<{ record_id: string }[]>`
      select record_id from event_records where workspace_id = ${ws}
      order by occurred_at desc, record_id desc limit ${limit + 1}`;
      expect(newest.map((r) => r.event_id)).toEqual(expected.map((r) => r.record_id));

      const nodes = flatten(plan);
      const tables = ['record_links', 'event_links', 'event_records', 'records'];
      const scans = nodes.filter((p) => p['Relation Name'] && tables.includes(p['Relation Name']));
      // Every table is read by index, and only for the fan-out: no scan
      // returns more rows, in all its loops, than the fan-out has events.
      expect(scans.filter((p) => p['Node Type'] === 'Seq Scan')).toEqual([]);
      for (const scan of scans) {
        const read = (scan['Actual Rows'] ?? 0) + (scan['Rows Removed by Filter'] ?? 0);
        expect(read * (scan['Actual Loops'] ?? 0)).toBeLessThanOrEqual(fanOut);
      }
      // Each source is cut to its own newest page, so the merge sees at most
      // sources × (limit + 1) rows, not every event.
      const perSourceLimit = nodes.find(
        (p) => p['Node Type'] === 'Limit' && (p['Actual Loops'] ?? 0) >= sources,
      );
      expect(perSourceLimit).toBeDefined();
      expect(perSourceLimit?.['Actual Rows'] ?? Infinity).toBeLessThanOrEqual(limit + 1);
      const merged = nodes.find((p) => p['Node Type'] === 'Append');
      expect(merged?.['Actual Rows'] ?? Infinity).toBeLessThanOrEqual(sources * (limit + 1));
    } finally {
      clearInterval(timer);
    }
  }, 900_000);
});

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
};
type PlanRoot = { Plan: PlanNode };

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}
