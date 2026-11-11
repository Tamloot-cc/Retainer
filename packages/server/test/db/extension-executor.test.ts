import { randomUUID } from 'node:crypto';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import {
  type ExecutionDriver,
  ExecutionRegistry,
  ExtensionExecutor,
} from '../../src/worker/extensions.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase(),
  functionId = randomUUID();
const manifest = extensionFixture({
  scopes: ['read', 'write'],
  functions: [
    {
      universalId: functionId,
      name: 'sync',
      description: 'Deterministic fixture',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 120,
      trigger: { kind: 'job' },
      inputSchema: { type: 'object', additionalProperties: false },
    },
  ],
});
const catalog = new ExtensionCatalog([{ manifest, actorCeiling: 'integration' }]),
  release = catalog.get(manifest.universalId, manifest.version);
const executable = {
  registrationId: manifest.universalId,
  releaseDigest: release.digest,
  functionId,
  handlerDigest: 'b'.repeat(64),
  packageDigest: manifest.packageDigest,
  runtimeVersion: 'node24' as const,
  driverTarget: 'fixture:immutable-bundle',
};
let t: TestApp, tokens: RunTokens;
beforeAll(async () => {
  const keys = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: keys.privateKey,
    verificationKey: keys.publicKey,
  });
  t = startTestApp(db, { extensionCatalog: catalog, runTokens: tokens });
});
async function setup() {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Executor ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const install = await t.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': 'install' },
  });
  expect(install.status).toBe(201);
  const id = install.body.id as string;
  await db.owner`update extension_installations set state='active' where id=${id}`;
  const queue = new ExtensionQueue(t.sql, (id, version) => catalog.get(id, version).manifest);
  const { id: jobId } = await queue.enqueue(workspace.id, id, {
    functionId,
    input: {},
    dedupeKey: 'fixture',
  });
  const executor = (driver: ExecutionDriver, registry = new ExecutionRegistry([executable])) =>
    new ExtensionExecutor({
      sql: t.sql,
      discoverySql: db.connect({ role: 'retainer_executor' }),
      catalog,
      registry,
      tokens,
      driver,
      apiOrigin: 'https://retainer.test',
      owner: randomUUID(),
    });
  return { workspace: workspace.id, id, jobId, queue, executor };
}
describe('trusted executor protocol with an explicitly in-process test driver', () => {
  it('claims once across two coordinators and runs the deterministic adapter with only its scoped API credential', async () => {
    const { id, jobId, executor } = await setup();
    let calls = 0;
    const driver: ExecutionDriver = {
      invoke: async (target, invocation) => {
        calls++;
        expect(target.driverTarget).toBe(executable.driverTarget);
        expect(invocation).not.toHaveProperty('databaseUrl');
        const response = await t.request('/v1/objects/company/records', {
          key: invocation.runToken,
          body: { values: { name: 'Deterministic fixture' } },
        });
        expect(response.status).toBe(201);
        return { status: 'succeeded' };
      },
    };
    const results = await Promise.all([executor(driver).tick(), executor(driver).tick()]);
    expect(results.reduce((sum, r) => sum + r.executed, 0)).toBe(1);
    expect(calls).toBe(1);
    const [job] = await db.owner`select status from extension_jobs where id=${jobId}`;
    expect(job?.status).toBe('succeeded');
    const [assertion] =
      await db.owner`select actor from field_assertions where actor->>'id'=${id} limit 1`;
    expect(assertion?.actor).toEqual({ type: 'integration', id });
  });
  it('keeps provider exceptions out of stored diagnostics and does not execute an unregistered artifact', async () => {
    const { jobId, executor } = await setup();
    const result = await executor({
      invoke: async () => {
        throw new Error('sensitive provider response');
      },
    }).tick();
    expect(result.executed).toBe(1);
    const [job] = await db.owner`select status,code from extension_jobs where id=${jobId}`;
    expect(job).toEqual({ status: 'queued', code: 'execution_unavailable' });
    const next = await setup();
    let calls = 0;
    await next
      .executor(
        {
          invoke: async () => {
            calls++;
            return { status: 'succeeded' };
          },
        },
        new ExecutionRegistry([]),
      )
      .tick();
    expect(calls).toBe(0);
    const [failed] = await db.owner`select status,code from extension_jobs where id=${next.jobId}`;
    expect(failed).toEqual({ status: 'failed', code: 'incompatible_runtime' });
  });
});
