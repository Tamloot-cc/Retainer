import { randomUUID } from 'node:crypto';
import {
  executeLastContact,
  LAST_CONTACT,
  lastContactManifest,
} from '@retainer/runner/last-contact';
import { generateKeyPair } from 'jose';
import { expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { ExecutionRegistry, ExtensionExecutor } from '../../src/worker/extensions.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
it('coalesces due Last Contact recovery and executes its real scheduled payload without blocking scans', async () => {
  const manifest = lastContactManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  const catalog = new ExtensionCatalog([
    { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  ]);
  const release = catalog.get(manifest.universalId, manifest.version);
  const pair = await generateKeyPair('EdDSA');
  const tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'schedule-test',
    verificationKey: pair.publicKey,
    signingKey: pair.privateKey,
  });
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set([release.digest]),
    runTokens: tokens,
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: 'Last Contact recovery' },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string;
  const queue = new ExtensionQueue(app.sql, catalog.runtime);
  const [pending] =
    await db.owner`select id from extension_jobs where installation_id=${id} and trigger_kind='install'`;
  const setup = await queue.claim(workspace.id, pending?.id, 'setup');
  if (!setup) throw new Error('missing setup');
  await queue.complete(setup, { status: 'succeeded' });
  expect(await queue.scheduleTick(workspace.id, id)).toEqual({ scheduled: 0 });
  const past = new Date('2026-01-01T00:00:00Z');
  await db.owner`update extension_schedules set next_due_at=${past} where installation_id=${id}`;
  const scheduled = await Promise.all([
    queue.scheduleTick(workspace.id, id),
    queue.scheduleTick(workspace.id, id),
  ]);
  expect(scheduled.map((result) => result.scheduled).sort()).toEqual([0, 1]);
  const [job] =
    await db.owner`select input from extension_jobs where installation_id=${id} and trigger_kind='schedule'`;
  expect(job?.input).toEqual({ scheduledAt: past.toISOString() });
  const executor = new ExtensionExecutor({
    sql: app.sql,
    discoverySql: db.connect({ role: 'retainer_executor', max: 1 }),
    catalog,
    tokens,
    owner: 'recovery-test',
    apiOrigin: 'https://retainer.test',
    registry: new ExecutionRegistry(
      manifest.functions.map((fn) => ({
        registrationId: manifest.universalId,
        releaseDigest: release.digest,
        functionId: fn.universalId,
        handlerDigest: fn.handlerDigest,
        packageDigest: manifest.packageDigest,
        runtimeVersion: 'node24',
        driverTarget: 'last-contact',
      })),
    ),
    driver: {
      invoke: (_executable, invocation, signal) =>
        executeLastContact(invocation, signal, app.inProcessFetch),
    },
  });
  expect(await executor.tick(1)).toMatchObject({ executed: 1 });
  expect(await executor.tick(1)).toMatchObject({ executed: 1 });
  const jobs =
    await db.owner`select function_id,status from extension_jobs where installation_id=${id} and trigger_kind<>'install' order by created_at`;
  expect(jobs).toEqual([
    { function_id: LAST_CONTACT.schedule, status: 'succeeded' },
    { function_id: LAST_CONTACT.scan, status: 'succeeded' },
  ]);
  const [state] =
    await db.owner`select value from extension_kv where installation_id=${id} and key='last-contact-scan'`;
  expect(state?.value.done).toBe(true);
  expect(await queue.scheduleTick(workspace.id, id)).toEqual({ scheduled: 0 });
});
