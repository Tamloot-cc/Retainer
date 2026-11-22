import { randomUUID } from 'node:crypto';
import { tamlootManifest } from '@retainer/runner/tamloot-contract';
import { expect, it } from 'vitest';
import { inWorkspace } from '../../src/db/tx.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import { migrateExtensionBindings } from '../../src/workspaces/binding-migration.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const actor = { type: 'user', id: 'admin' } as const;
const manifest = tamlootManifest({
  version: '2.0.0',
  packageDigest: 'a'.repeat(64),
  handlerDigest: 'b'.repeat(64),
  serverRange: '>=0.1.0 <0.2.0',
});
const catalog = new ExtensionCatalog([
  { manifest, actorCeiling: 'integration', runtimeEnabled: true },
]);

async function legacy(name: string, operations: SchemaOperation[] = []) {
  const workspace = await createWorkspace(db.owner, { name, template: 'starter' });
  if (operations.length)
    await inWorkspace(db.owner, workspace.id, (tx) =>
      runSchemaChange(tx, {
        workspaceId: workspace.id,
        actor,
        scopes: ['admin'],
        operations,
      }),
    );
  const id = randomUUID();
  await db.owner`insert into extension_installations
    (id,workspace_id,registration_id,version,release_digest,state,granted_actor,granted_scopes,created_by,settings)
    values(${id},${workspace.id},${manifest.universalId},'1.0.0',${'c'.repeat(64)},'active',
      'integration','["read","write"]',${db.owner.json(actor)},'{"createPeople":"everyone"}')`;
  return id;
}

it('reports without writing and applies the same bindings or uninstall decisions', async () => {
  const normal = await legacy('Keep');
  const renamed = await legacy('Renamed', [
    {
      op: 'rename_object',
      object: 'conversation',
      nameSingular: 'session',
      namePlural: 'sessions',
    },
  ]);
  const deleted = await legacy('Deleted', [{ op: 'delete_object', object: 'conversation' }]);
  const read = () =>
    db.owner`select id,state,version,release_digest,bindings from extension_installations order by id`;
  const before = await read();
  const report = await migrateExtensionBindings(db.owner, catalog, true);
  expect(await read()).toEqual(before);
  expect(report).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        installationId: normal,
        action: 'bind',
        plan: expect.objectContaining({
          bindings: expect.objectContaining({
            meeting: expect.objectContaining({
              objects: expect.arrayContaining([expect.objectContaining({ name: 'conversation' })]),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        installationId: renamed,
        action: 'bind',
        plan: expect.objectContaining({
          bindings: expect.objectContaining({
            meeting: expect.objectContaining({
              objects: expect.arrayContaining([expect.objectContaining({ name: 'session' })]),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        installationId: deleted,
        action: 'uninstall',
        reason: expect.stringContaining('meeting'),
      }),
    ]),
  );
  expect(await migrateExtensionBindings(db.owner, catalog, false)).toEqual(report);
  const after = await read();
  expect(after.find((row) => row.id === normal)).toMatchObject({
    state: 'active',
    version: '2.0.0',
  });
  expect(after.find((row) => row.id === renamed)?.bindings).toBeTruthy();
  expect(after.find((row) => row.id === deleted)?.state).toBe('uninstalled');
  expect(await migrateExtensionBindings(db.owner, catalog, true)).toEqual([]);
});
