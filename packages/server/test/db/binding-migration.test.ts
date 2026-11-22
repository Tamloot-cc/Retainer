import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { enrichmentManifest } from '@retainer/runner/enrichment-contract';
import { tamlootManifest } from '@retainer/runner/tamloot-contract';
import { expect, it } from 'vitest';
import { inWorkspace } from '../../src/db/tx.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { runSchemaChange } from '../../src/schema-engine/engine.js';
import type { SchemaOperation } from '../../src/schema-engine/operations.js';
import {
  bindingsMigrationPending,
  migrateExtensionBindings,
} from '../../src/workspaces/binding-migration.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

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
  expect(await bindingsMigrationPending(db.owner)).toBe(true);
  // The hosted preflight runs against the schema before the bindings columns exist.
  await db.owner`alter table extension_installations rename column bindings to test_bindings`;
  await db.owner`alter table extension_installations rename column bindings_revision to test_bindings_revision`;
  let report: unknown;
  try {
    const { stdout } = await promisify(execFile)('pnpm', ['--silent', 'migrate:bindings-report'], {
      env: {
        ...process.env,
        DATABASE_URL: db.url,
        RETAINER_EXTENSION_CATALOG: JSON.stringify(
          catalog.list().map(({ digest, ...entry }) => entry),
        ),
        RETAINER_EXTENSION_CATALOG_FILE: '',
        RETAINER_EXTENSION_CATALOG_SHA256: '',
        PGOPTIONS: '-c default_transaction_read_only=on',
      },
    });
    report = JSON.parse(stdout);
  } finally {
    await db.owner`alter table extension_installations rename column test_bindings to bindings`;
    await db.owner`alter table extension_installations rename column test_bindings_revision to bindings_revision`;
  }
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
  expect(await bindingsMigrationPending(db.owner)).toBe(false);
});

it('uses a captured output choice after the old mapping column is dropped', async () => {
  const enrichment = enrichmentManifest({
    version: '2.0.0',
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  const workspace = await createWorkspace(db.owner, {
    name: 'Old enrichment',
    template: 'starter',
  });
  const id = randomUUID();
  const [address] = await db.owner<{ universal_id: string }[]>`
    select f.universal_id from fields f join object_types o on o.id=f.object_type_id
    where o.workspace_id=${workspace.id} and o.name_singular='company' and f.name='address'`;
  if (!address) throw new Error('missing starter address field');
  const archived = {
    legacyMapping: { outputs: { headquarters: { fieldUniversalId: address.universal_id } } },
  };
  await db.owner`insert into extension_installations
    (id,workspace_id,registration_id,version,release_digest,state,granted_actor,granted_scopes,created_by,bindings)
    values(${id},${workspace.id},${enrichment.universalId},'1.0.0',${'e'.repeat(64)},'active',
      'agent','["read","write"]',${db.owner.json(actor)},${db.owner.json(archived)})`;
  const rebuilt = new ExtensionCatalog([
    { manifest: enrichment, actorCeiling: 'agent', runtimeEnabled: true },
  ]);
  const report = await migrateExtensionBindings(db.owner, rebuilt, true);
  expect(report).toEqual([
    expect.objectContaining({
      installationId: id,
      action: 'bind',
      plan: expect.objectContaining({
        bindings: expect.objectContaining({
          company: expect.objectContaining({
            fields: expect.objectContaining({
              headquarters: expect.objectContaining({ name: 'address' }),
            }),
          }),
        }),
      }),
    }),
  ]);
  expect(await migrateExtensionBindings(db.owner, rebuilt, false)).toEqual(report);
  const [installed] =
    await db.owner`select bindings,bindings_revision from extension_installations where id=${id}`;
  expect(installed).toMatchObject({
    bindings_revision: 1,
    bindings: {
      destinations: { company: { fields: { headquarters: { id: address.universal_id } } } },
    },
  });
  expect(installed?.bindings.legacyMapping).toBeUndefined();
});

it('leaves a new installation without bindings alone when migrations run again', async () => {
  const standalone = extensionFixture({ execution: 'standalone', scopes: ['read'] });
  const current = new ExtensionCatalog([{ manifest: standalone, actorCeiling: 'integration' }]);
  const app = startTestApp(db, { extensionCatalog: current });
  const { keys } = await app.setupWorkspace(
    { name: 'A new standalone installation' },
    { admin: { actor, scopes: ['admin'] } },
  );
  const input = {
    registrationId: standalone.universalId,
    version: standalone.version,
    settings: {},
  };
  const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status, JSON.stringify(installed.body)).toBe(201);
  expect(await migrateExtensionBindings(db.owner, current, false)).toEqual([]);
  expect(await bindingsMigrationPending(db.owner)).toBe(false);
  const [row] = await db.owner`
    select bindings, bindings_revision, state from extension_installations where id=${installed.body.id}`;
  expect(row).toMatchObject({ bindings: null, bindings_revision: 1, state: 'active' });
});
