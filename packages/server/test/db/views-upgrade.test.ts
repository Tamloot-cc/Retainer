import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();

it('discards dormant board settings left by older versions while preserving real boards', async () => {
  const app = startTestApp(db);
  const { keys } = await app.setupWorkspace(
    { name: 'Upgrade views', template: 'sales' },
    { user: { actor: { type: 'user', id: 'owner' }, scopes: ['read', 'write'] } },
  );
  const key = keys.user;
  const filter = { stage: { neq: 'won' } };
  const groupAggregate = { field: 'amount', op: 'sum' };
  const createBoard = async (name: string) => {
    const response = await app.request('/v1/objects/deal/views', {
      key,
      body: {
        name,
        kind: 'board',
        filter,
        groupBy: 'stage',
        hiddenGroups: ['lost'],
        groupAggregate,
      },
    });
    expect(response.status).toBe(201);
    return response.body.id as string;
  };
  const formerBoard = await createBoard('Former board');
  const orphanedBoard = await createBoard('Missing group');
  const board = await createBoard('Active board');
  // Recreate what the old layout change and schema repair left in storage.
  await db.owner`update views set kind = 'table' where id = ${formerBoard}`;
  await db.owner`update views set config = config - 'groupBy' where id = ${orphanedBoard}`;

  const migration = await readFile(
    new URL('../../drizzle/0157_normalize_legacy_view_groups.sql', import.meta.url),
    'utf8',
  );
  await db.owner.unsafe(migration);

  const read = (id: string) => app.request(`/v1/views/${id}`, { key });
  expect((await read(formerBoard)).body).toMatchObject({
    kind: 'table',
    filter,
    groupBy: null,
    hiddenGroups: [],
    groupAggregate: null,
  });
  expect((await read(board)).body).toMatchObject({
    kind: 'board',
    filter,
    groupBy: 'stage',
    hiddenGroups: ['lost'],
    groupAggregate,
  });
  const renamed = await app.request(`/v1/views/${orphanedBoard}`, {
    key,
    method: 'PATCH',
    body: { name: 'Needs a grouping field' },
  });
  expect(renamed.status).toBe(200);
  expect(renamed.body).toMatchObject({
    name: 'Needs a grouping field',
    kind: 'board',
    filter,
    groupBy: null,
    hiddenGroups: [],
    groupAggregate: null,
  });

  const groupedTable = await app.request('/v1/objects/deal/views', {
    key,
    body: { name: 'Grouped table', kind: 'table', groupBy: 'stage', hiddenGroups: ['lost'] },
  });
  expect(groupedTable.status).toBe(201);
  expect(groupedTable.body).toMatchObject({ groupBy: 'stage', hiddenGroups: ['lost'] });
});
