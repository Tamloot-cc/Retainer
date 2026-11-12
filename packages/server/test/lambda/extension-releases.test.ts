import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const ops = () => createOpsHandler(loadConfig({ DATABASE_URL: db.url, LOG_LEVEL: 'error' }));
const status = (releaseDigests: string[] = []) =>
  ops()({
    command: 'extension-release-status',
    protocolVersion: 1,
    runtimeVersion: 'node24',
    releaseDigests,
  });

it('reports only release hashes/counts and refuses to drop disabled or cleanup-capable installations', async () => {
  const manifest = extensionFixture({ execution: 'standalone' }),
    catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]);
  const app = startTestApp(db, { extensionCatalog: catalog });
  const { workspace, keys } = await app.setupWorkspace(
    { name: 'Private workspace name' },
    { admin: { actor: { type: 'user', id: 'Private person' }, scopes: ['admin'] } },
  );
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const digest = installed.body.releaseDigest as string;
  const required = await status();
  expect(required).toEqual({
    command: 'extension-release-status',
    protocol: 1,
    compatible: false,
    activeLeases: 0,
    references: [{ releaseDigest: digest, installations: 1 }],
    missingReleaseDigests: [digest],
  });
  expect(JSON.stringify(required)).not.toContain(workspace.id);
  expect(JSON.stringify(required)).not.toContain('Private');
  expect(await status([digest])).toMatchObject({ compatible: true, missingReleaseDigests: [] });
  expect(
    (
      await app.request(`/v1/extensions/${installed.body.id}/disable`, {
        key: keys.admin,
        method: 'POST',
      })
    ).status,
  ).toBe(200);
  expect(await status()).toMatchObject({ compatible: false });
  await db.owner`update extension_installations set state='uninstalled',cleanup_deadline=clock_timestamp()+interval '1 hour' where id=${installed.body.id}`;
  expect(await status()).toMatchObject({ compatible: false });
  await db.owner`update extension_installations set cleanup_deadline=clock_timestamp()-interval '1 second' where id=${installed.body.id}`;
  expect(await status()).toMatchObject({ compatible: true, references: [] });
  await expect(
    ops()({
      command: 'extension-release-status',
      protocolVersion: 2,
      runtimeVersion: 'node24',
      releaseDigests: [],
    }),
  ).rejects.toThrow('Expected');
});

it('supports pre-extension bootstrap without querying tables that are not migrated yet', async () => {
  await db.owner`alter table extension_installations rename to saved_extension_installations`;
  try {
    expect(await status()).toMatchObject({ compatible: true, references: [] });
  } finally {
    await db.owner`alter table saved_extension_installations rename to extension_installations`;
  }
});
