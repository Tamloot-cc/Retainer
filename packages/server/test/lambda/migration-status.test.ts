import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { createRecord } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const ops = () => createOpsHandler(loadConfig({ DATABASE_URL: db.url, LOG_LEVEL: 'error' }));

describe('read-only migration status', () => {
  it('reports no work on a migrated database without changing its journal', async () => {
    const before = await db.owner`select * from drizzle.__drizzle_migrations`;
    expect(await ops()({ command: 'migration-status' })).toEqual({
      command: 'migration-status',
      protocol: 1,
      needsStop: false,
      reasons: [],
    });
    expect(await db.owner`select * from drizzle.__drizzle_migrations`).toEqual(before);
  });
  it('reports stale definitions, leaves them untouched, and clears after migrate', async () => {
    const workspace = await createWorkspace(db.owner, { name: 'Status' });
    await db.owner`update workspaces set definitions_digest = null where id = ${workspace.id}`;
    expect(await ops()({ command: 'migration-status' })).toMatchObject({
      needsStop: true,
      reasons: ['definitions'],
    });
    const [row] =
      await db.owner`select definitions_digest from workspaces where id = ${workspace.id}`;
    expect(row?.definitions_digest).toBeNull();
    await ops()({ command: 'migrate' });
    expect(await ops()({ command: 'migration-status' })).toMatchObject({ needsStop: false });
  });
  it('reports stale search text without rebuilding it', async () => {
    const workspace = await createWorkspace(db.owner, { name: 'Search status' });
    const result = await createRecord(
      db.owner,
      { workspaceId: workspace.id, actor: { type: 'user', id: 'status' }, scopes: ['admin'] },
      'person',
      { name: 'Search' },
    );
    await ops()({ command: 'migrate' });
    await db.owner`update records set search = null where id = ${result.record.id}`;
    expect(await ops()({ command: 'migration-status' })).toMatchObject({
      needsStop: true,
      reasons: ['search'],
    });
    const [row] = await db.owner`select search from records where id = ${result.record.id}`;
    expect(row?.search).toBeNull();
    await ops()({ command: 'migrate' });
    expect(await ops()({ command: 'migration-status' })).toMatchObject({ needsStop: false });
  });

  it('reports a missing migration journal without trying newer-schema queries', async () => {
    await db.owner`alter schema drizzle rename to saved_drizzle`;
    try {
      expect(await ops()({ command: 'migration-status' })).toMatchObject({
        needsStop: true,
        reasons: ['migrations'],
      });
      const [row] = await db.owner`select to_regnamespace('drizzle') as name`;
      expect(row?.name).toBeNull();
    } finally {
      await db.owner`alter schema saved_drizzle rename to drizzle`;
    }
  });
});
