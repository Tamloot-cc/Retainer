import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { createRecord } from '../../src/records/service.js';
import { applyTemplate } from '../../src/templates/apply.js';
import { definitionsFor } from '../../src/templates/definitions.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const ops = () => createOpsHandler(loadConfig({ DATABASE_URL: db.url, LOG_LEVEL: 'error' }));

describe('read-only migration status', () => {
  it('refuses an unknown applied migration before an older build can migrate or rewrite definitions', async () => {
    const [future] = await db.owner`insert into drizzle.__drizzle_migrations(hash,created_at)
      select ${'f'.repeat(64)},max(created_at)+1 from drizzle.__drizzle_migrations returning id`;
    if (!future) throw new Error('missing future migration fixture');
    try {
      const before = await db.owner`select id,definitions_digest from workspaces order by id`;
      expect(await ops()({ command: 'migration-status' })).toEqual({
        command: 'migration-status',
        protocol: 1,
        historyChecked: true,
        needsStop: true,
        reasons: ['incompatible_migrations'],
      });
      await expect(ops()({ command: 'migrate' })).rejects.toThrow(
        'migration history is incompatible',
      );
      expect(await db.owner`select id,definitions_digest from workspaces order by id`).toEqual(
        before,
      );
      expect(
        await db.owner`select id from drizzle.__drizzle_migrations where id=${future.id}`,
      ).toHaveLength(1);
    } finally {
      await db.owner`delete from drizzle.__drizzle_migrations where id=${future.id}`;
    }
  });
  it('reports no work on a migrated database without changing its journal', async () => {
    const before = await db.owner`select * from drizzle.__drizzle_migrations`;
    expect(await ops()({ command: 'migration-status' })).toEqual({
      command: 'migration-status',
      protocol: 1,
      historyChecked: true,
      needsStop: false,
      reasons: [],
    });
    expect(await db.owner`select * from drizzle.__drizzle_migrations`).toEqual(before);
  });
  it('does not need a stop after operator or account workspace creation', async () => {
    await createWorkspace(db.owner, { name: 'Current base' });
    await createWorkspace(db.owner, { name: 'Current template', template: 'clinic' });
    const account = startAccountsApp(db);
    const { cookie } = await account.signIn();
    const response = await account.account('/account/workspaces', {
      method: 'POST',
      cookie,
      body: { name: 'Current signup', template: 'sales' },
    });
    expect(response.status).toBe(201);
    expect(await ops()({ command: 'migration-status' })).toMatchObject({ needsStop: false });
  });

  it('stamps concurrent template applications without losing a digest', async () => {
    const workspace = await createWorkspace(db.owner, { name: 'Template concurrency' });
    const runtime = db.connect({ role: RUNTIME_ROLE });
    await Promise.all(
      ['clinic', 'clinic'].map((name) =>
        inWorkspace(runtime, workspace.id, (tx) =>
          applyTemplate(tx, {
            workspaceId: workspace.id,
            actor: { type: 'user', id: 'status' },
            scopes: ['admin'],
            name,
          }),
        ),
      ),
    );
    const [row] =
      await db.owner`select templates, definitions_digest from workspaces where id = ${workspace.id}`;
    expect(row?.templates).toHaveLength(1);
    expect(row?.definitions_digest).toBe(definitionsFor(row?.templates).digest);
    expect(await ops()({ command: 'migration-status' })).toMatchObject({ needsStop: false });
  });

  it('does not hide a stale base digest when applying a new template', async () => {
    for (const stale of [null, 'older-release']) {
      const workspace = await createWorkspace(db.owner, { name: `Stale ${stale}` });
      await db.owner`update workspaces set definitions_digest = ${stale} where id = ${workspace.id}`;
      await inWorkspace(db.connect({ role: RUNTIME_ROLE }), workspace.id, (tx) =>
        applyTemplate(tx, {
          workspaceId: workspace.id,
          actor: { type: 'user', id: 'status' },
          scopes: ['admin'],
          name: 'clinic',
        }),
      );
      const [row] =
        await db.owner`select definitions_digest from workspaces where id = ${workspace.id}`;
      expect(row?.definitions_digest).toBe(stale);
      expect(await ops()({ command: 'migration-status' })).toMatchObject({
        needsStop: true,
        reasons: ['definitions'],
      });
    }
    await ops()({ command: 'migrate' });
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
