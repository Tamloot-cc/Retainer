import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { queryInputSchema } from '../../src/records/query.js';
import { createRecord, deleteRecord, findRecords } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let app: Sql;
let caller: Caller;
const ids: Record<string, string> = {};

const query = (object: string, input: Record<string, unknown>) =>
  findRecords(app, caller, object, queryInputSchema.parse(input));
const labels = async (object: string, input: Record<string, unknown>) =>
  (await query(object, input)).records.map((r) => r.label);

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE });
  const workspace = await createWorkspace(db.owner, { name: 'Sales', template: 'sales' });
  const actor: Actor = { type: 'agent', id: 'bot' };
  caller = { workspaceId: workspace.id, actor, scopes: ['read', 'write'] };

  const acme = await createRecord(app, caller, 'company', { name: 'Acme', employeeCount: 120 });
  const globex = await createRecord(app, caller, 'company', { name: 'Globex', employeeCount: 15 });
  ids.acme = acme.id;
  ids.globex = globex.id;
  const people = [
    { name: 'Dana Levi', emails: 'dana@acme.com', jobTitle: 'CTO', company: acme.id },
    { name: 'Noa Cohen', emails: 'noa@globex.com', jobTitle: 'Head of Sales', company: globex.id },
    { name: 'Avi Ben', emails: 'avi@acme.com', company: acme.id },
  ];
  for (const person of people) {
    ids[person.name] = (await createRecord(app, caller, 'person', person)).id;
  }
  const deals = [
    {
      name: 'Acme renewal',
      stage: 'won',
      amount: { amountMicros: 50_000_000_000, currency: 'USD' },
      closeDate: '2026-03-01',
    },
    {
      name: 'Globex pilot',
      stage: 'proposal',
      amount: { amountMicros: 5_000_000_000, currency: 'USD' },
      closeDate: '2026-12-15',
    },
    { name: 'Acme expansion', stage: 'negotiation', closeDate: '2027-01-10' },
  ];
  for (const deal of deals) await createRecord(app, caller, 'deal', deal);
  const deleted = await createRecord(app, caller, 'deal', { name: 'Deleted deal', stage: 'won' });
  await deleteRecord(app, caller, deleted.id);
});

describe('query_records', () => {
  it('searches by word prefix, ignoring accents, and by email domain', async () => {
    expect(await labels('person', { search: 'Da' })).toEqual(['Dana Levi']);
    expect(await labels('person', { search: 'dana le' })).toEqual(['Dana Levi']);
    expect(await labels('person', { search: 'dana co' })).toEqual([]);
    expect(await labels('person', { search: 'acme' })).toEqual(['Dana Levi', 'Avi Ben']);
    expect(await labels('company', { search: 'glob' })).toEqual(['Globex']);
    const accented = await createRecord(app, caller, 'company', { name: 'Société Mondiale' });
    expect(await labels('company', { search: 'societe' })).toEqual(['Société Mondiale']);
    expect(await labels('company', { search: 'SOCIÉ' })).toEqual(['Société Mondiale']);
    await deleteRecord(app, caller, accented.id);
  });

  it('returns live records in creation order by default', async () => {
    expect(await labels('deal', {})).toEqual(['Acme renewal', 'Globex pilot', 'Acme expansion']);
  });

  it('filters by equality, in, and negation on selects', async () => {
    expect(await labels('deal', { filter: { stage: 'won' } })).toEqual(['Acme renewal']);
    expect(await labels('deal', { filter: { stage: { in: ['won', 'proposal'] } } })).toEqual([
      'Acme renewal',
      'Globex pilot',
    ]);
    expect(await labels('deal', { filter: { stage: { neq: 'won' } } })).toEqual([
      'Globex pilot',
      'Acme expansion',
    ]);
  });

  it('compares numbers, dates and money by value, not text', async () => {
    expect(await labels('company', { filter: { employeeCount: { gt: 100 } } })).toEqual(['Acme']);
    expect(await labels('deal', { filter: { closeDate: { gte: '2026-06-01' } } })).toEqual([
      'Globex pilot',
      'Acme expansion',
    ]);
    expect(await labels('deal', { filter: { amount: { gt: 10_000_000_000 } } })).toEqual([
      'Acme renewal',
    ]);
  });

  it('matches text, names, emails and relations', async () => {
    expect(await labels('deal', { filter: { name: { contains: 'acme' } } })).toEqual([
      'Acme renewal',
      'Acme expansion',
    ]);
    expect(await labels('person', { filter: { emails: 'DANA@acme.com' } })).toEqual(['Dana Levi']);
    expect(await labels('person', { filter: { company: ids.acme } })).toEqual([
      'Dana Levi',
      'Avi Ben',
    ]);
    expect(await labels('person', { filter: { jobTitle: { isNull: true } } })).toEqual(['Avi Ben']);
  });

  it('combines and, or and not', async () => {
    expect(
      await labels('deal', {
        filter: {
          or: [{ stage: 'won' }, { closeDate: { gt: '2027-01-01' } }],
          not: { name: { contains: 'renewal' } },
        },
      }),
    ).toEqual(['Acme expansion']);
  });

  it('sorts by typed values and pages with a cursor', async () => {
    const sort = [{ field: 'closeDate', direction: 'desc' }];
    const first = await query('deal', { sort, limit: 2 });
    expect(first.records.map((r) => r.label)).toEqual(['Acme expansion', 'Globex pilot']);
    expect(first.nextCursor).not.toBeNull();
    const second = await query('deal', { sort, limit: 2, cursor: first.nextCursor });
    expect(second.records.map((r) => r.label)).toEqual(['Acme renewal']);
    expect(second.nextCursor).toBeNull();
  });

  it('explains what can be filtered and how', async () => {
    await expect(query('person', { filter: { address: { contains: 'x' } } })).rejects.toMatchObject(
      {
        code: 'invalid_filter',
        details: { field: 'address', allowed: expect.arrayContaining(['emails', 'jobTitle']) },
      },
    );
    await expect(query('deal', { filter: { stage: { gt: 'a' } } })).rejects.toMatchObject({
      details: { allowed: ['eq', 'neq', 'in', 'isNull'] },
    });
    await expect(query('deal', { filter: { stage: 'closed' } })).rejects.toMatchObject({
      details: { allowed: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] },
    });
    await expect(query('deal', { sort: [{ field: 'amount' }] })).rejects.toMatchObject({
      message: 'cannot sort by "amount"',
    });
  });

  it('describes a bad filter value as a write would, without the stored format', async () => {
    const failure = (filter: Record<string, unknown>) =>
      query('deal', { filter }).then(
        () => expect.unreachable(),
        (error: { details: Record<string, unknown> }) => error.details,
      );
    expect(await failure({ stage: 'closed' })).toEqual({
      field: 'stage',
      message: 'expected one of the options',
      allowed: ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'],
    });
    // A money filter compares the amount alone, unlike the stored
    // { amountMicros, currency }, so no `expected` points at that format.
    expect(await failure({ amount: { gt: { amountMicros: 1, currency: 'USD' } } })).toEqual({
      field: 'amount',
      message: 'expected amountMicros as a number',
    });
  });
});
