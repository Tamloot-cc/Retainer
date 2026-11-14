import { randomUUID } from 'node:crypto';
import type { ExtensionManifest, Invocation } from '@retainer/extension';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import type { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { MODEL_USE_NOTICE } from '../../src/extensions/service.js';
import { ExecutionRegistry, ExtensionExecutor } from '../../src/worker/extensions.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';
import {
  claimRun,
  fakeAnthropic,
  installModelRelease,
  modelFunction,
  modelRelease,
  PICK,
  PLAIN,
  testRunTokens,
  type Upstream,
} from '../helpers/model.js';

// Model calls spec 3.1, 3.2 and 7 (grant and tokens, configure): model use is
// access an admin approves, and only a function that declares it on an
// installation granted it gets a model token.
const db = useTestDatabase();
const CONFIGURE = '7a2e7c81-3d4f-4e5a-8b6c-7d8e9fa0b123';

const single = modelRelease();
/** A release with configure: access is approved first, uses included. */
const withConfigure = (version: string, configureUses: boolean, pickUses = true) =>
  extensionFixture({
    universalId: '9b4a9ea3-5f6b-4a7c-9d8e-9fa0b1c2d345',
    version,
    requestedActor: 'agent',
    scopes: ['read', 'write'],
    settings: {
      enabled: {
        type: 'boolean',
        label: 'Enabled',
        secret: false,
        required: true,
        reconnect: false,
      },
    },
    functions: [
      modelFunction(CONFIGURE, 'configure', {
        trigger: { kind: 'configure' },
        scopes: ['read'],
        ...(configureUses ? { uses: ['model'] } : {}),
      }),
      modelFunction(PICK, 'pick', pickUses ? { uses: ['model'] } : {}),
    ],
  });
const configured = withConfigure('1.0.0', true);
const plainConfigure = withConfigure('1.0.0', false, false);
const plainV1 = extensionFixture({
  ...single,
  universalId: 'ac5bafb4-6a7c-4b8d-8e9f-a0b1c2d3e456',
  functions: [modelFunction(PICK, 'pick'), modelFunction(PLAIN, 'plain')],
});
const modelV2 = extensionFixture({ ...plainV1, version: '2.0.0', functions: single.functions });
const upgradeV2 = extensionFixture({
  ...withConfigure('2.0.0', true),
  universalId: '0c7e1f26-8b9c-4dae-9f01-b2c3d4e5f678',
});
const upgradeV1 = extensionFixture({
  ...plainConfigure,
  universalId: '0c7e1f26-8b9c-4dae-9f01-b2c3d4e5f678',
});
const releases: ExtensionManifest[] = [single, configured, plainV1, modelV2, upgradeV1, upgradeV2];
const catalog = new ExtensionCatalog(
  releases.map((manifest) => ({ manifest, actorCeiling: 'agent' as const, runtimeEnabled: true })),
);
const digestOf = (manifest: ExtensionManifest) =>
  catalog.get(manifest.universalId, manifest.version).digest;
let t: TestApp, tokens: RunTokens, upstream: Upstream;
beforeAll(async () => {
  upstream = await fakeAnthropic();
  ({ tokens } = await testRunTokens());
  t = startTestApp(db, {
    extensionCatalog: catalog,
    runTokens: tokens,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    model: { apiKey: 'sk-test', upstream: upstream.origin },
  });
});

async function workspace() {
  return t.setupWorkspace(
    { name: `Model grant ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
}
async function approve(key: string, body: Record<string, unknown>) {
  const preview = await t.request('/v1/extensions/preview', { key, body });
  expect(preview.status).toBe(200);
  const committed = await t.request('/v1/extensions', {
    key,
    body: { ...body, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(committed.status).toBe(201);
  return { preview: preview.body, installation: committed.body };
}
const installation = async (id: string) =>
  (
    await db.owner<{ granted_uses: string[]; state: string }[]>`
    select granted_uses,state from extension_installations where id=${id}`
  )[0];
async function claimConfigure(workspaceId: string, id: string, digest?: string) {
  const [row] = await db.owner`select id from extension_jobs where installation_id=${id}
    and status='queued' and trigger_kind='configure' ${digest ? db.owner`and release_digest=${digest}` : db.owner``}
    order by id desc limit 1`;
  if (!row) throw new Error('configure job missing');
  const job = await new ExtensionQueue(t.sql, catalog.runtime).claim(
    workspaceId,
    row.id,
    randomUUID(),
  );
  if (!job) throw new Error('claim failed');
  return job;
}
const callModel = (token: string) =>
  t.app.request('http://retainer.test/v1/extensions/runtime/model/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': token, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 10, messages: [] }),
  });

describe('access preview and approval', () => {
  it('lists the uses with the access, says what model use means, and stores the grant', async () => {
    const { preview, id } = await installModelRelease(t, db, single);
    expect(preview.grants).toEqual({ actor: 'agent', scopes: ['read', 'write'], uses: ['model'] });
    expect(preview.warnings).toContain(MODEL_USE_NOTICE);
    expect((await installation(id))?.granted_uses).toEqual(['model']);
    const read = await t.request(`/v1/extensions/${id}`, {
      key: (await workspace()).keys.admin,
    });
    // Another workspace can't see it; its own admin sees grantedUses.
    expect(read.status).toBe(404);
  });

  it('a release without model use lists none and shows no notice', async () => {
    const { preview, id } = await installModelRelease(t, db, plainV1);
    expect(preview.grants.uses).toEqual([]);
    expect(preview.warnings).not.toContain(MODEL_USE_NOTICE);
    expect((await installation(id))?.granted_uses).toEqual([]);
  });

  it('grants model use at access approval, so configure can call the model before turn-on', async () => {
    const { workspace: ws, keys } = await workspace();
    const body = {
      registrationId: configured.universalId,
      version: '1.0.0',
      settings: { enabled: true },
    };
    const { preview, installation: created } = await approve(keys.admin, body);
    expect(preview.grants).toEqual({ actor: 'agent', scopes: ['read'], uses: ['model'] });
    expect(preview.warnings).toContain(MODEL_USE_NOTICE);
    expect(created.state).toBe('configuring');
    expect(created.grantedUses).toEqual(['model']);
    const job = await claimConfigure(ws.id, created.id);
    expect(job.scopes).toEqual(['read']);
    expect(job.uses).toEqual(['model']);
    const response = await callModel(await tokens.issueModel(job));
    expect(response.status).toBe(200);
    await response.text();
  });

  it("a preview's digest covers the uses: the same plan with different uses is a different plan", async () => {
    const { keys } = await workspace();
    const a = await t.request('/v1/extensions/preview', {
      key: keys.admin,
      body: { registrationId: plainV1.universalId, version: '1.0.0', settings: {} },
    });
    const b = await t.request('/v1/extensions/preview', {
      key: keys.admin,
      body: { registrationId: plainV1.universalId, version: '2.0.0', settings: {} },
    });
    expect(a.body.grants.uses).toEqual([]);
    expect(b.body.grants.uses).toEqual(['model']);
    expect(a.body.planDigest).not.toBe(b.body.planDigest);
  });
});

describe('model tokens per run', () => {
  it('only a function that declares model, on an installation granted it, gets a token', async () => {
    const { workspace: ws, id } = await installModelRelease(t, db, single);
    const pick = await claimRun(t, catalog, ws, id, PICK);
    expect(pick.uses).toEqual(['model']);
    await db.owner`update extension_jobs set status='succeeded',lease_until=null where id=${pick.jobId}`;
    const plain = await claimRun(t, catalog, ws, id, PLAIN);
    expect(plain.uses).toEqual([]);
    await expect(tokens.issueModel(plain)).rejects.toMatchObject({ code: 'forbidden' });
    await db.owner`update extension_jobs set status='succeeded',lease_until=null where id=${plain.jobId}`;
    // A grant without model: the declaring function gets nothing.
    await db.owner`update extension_installations set granted_uses='[]' where id=${id}`;
    const ungranted = await claimRun(t, catalog, ws, id, PICK);
    expect(ungranted.uses).toEqual([]);
  });

  it('the coordinator puts { origin, token } in the invocation only for those runs', async () => {
    const { workspace: ws, id } = await installModelRelease(t, db, single);
    const digest = digestOf(single);
    const invocations: Invocation[] = [];
    const executor = (modelOrigin?: string) =>
      new ExtensionExecutor({
        sql: t.sql,
        discoverySql: db.owner,
        catalog,
        registry: new ExecutionRegistry(
          [PICK, PLAIN].map((functionId) => ({
            registrationId: single.universalId,
            releaseDigest: digest,
            functionId,
            handlerDigest: 'b'.repeat(64),
            packageDigest: single.packageDigest,
            runtimeVersion: 'node24' as const,
            driverTarget: 'test',
          })),
        ),
        tokens,
        driver: {
          invoke: async (_executable, invocation) => {
            invocations.push(invocation);
            return { status: 'succeeded' };
          },
        },
        apiOrigin: 'https://api.retainer.test/',
        ...(modelOrigin ? { modelOrigin } : {}),
        owner: 'test-executor',
      });
    await executor().execute(await claimRun(t, catalog, ws, id, PICK));
    await executor().execute(await claimRun(t, catalog, ws, id, PLAIN));
    await executor('https://model.retainer.test/').execute(
      await claimRun(t, catalog, ws, id, PICK),
    );
    const [pick, plain, hosted] = invocations;
    expect(pick?.model?.origin).toBe('https://api.retainer.test/v1/extensions/runtime/model');
    expect(await tokens.verifyModel(pick?.model?.token ?? '')).toMatchObject({
      kind: 'model',
      workspaceId: ws,
      installationId: id,
      functionId: PICK,
      jobId: pick?.runId,
      attempt: pick?.attempt,
    });
    expect(plain?.model).toBeUndefined();
    expect(hosted?.model?.origin).toBe('https://model.retainer.test/');
  });
});

describe('upgrades', () => {
  it('a release that adds model use needs its access approved before a reviewed upgrade', async () => {
    const { id, key } = await installModelRelease(t, db, plainV1);
    const body = {
      installationId: id,
      registrationId: modelV2.universalId,
      version: '2.0.0',
      settings: {},
    };
    const refused = await t.request('/v1/extensions/preview', { key, body });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('grant_required');
    const { preview } = await approve(key, { ...body, grantChange: true });
    expect(preview.previousGrants).toEqual({ actor: 'agent', scopes: ['read', 'write'], uses: [] });
    expect(preview.grants.uses).toEqual(['model']);
    expect(preview.warnings).toContain(MODEL_USE_NOTICE);
    expect((await installation(id))?.granted_uses).toEqual(['model']);
  });

  it("an upgrade's configure run needs the new access approved, then runs with the target approval's uses", async () => {
    const { workspace: ws, keys } = await workspace();
    const first = {
      registrationId: upgradeV1.universalId,
      version: '1.0.0',
      settings: { enabled: true },
    };
    const { installation: created } = await approve(keys.admin, first);
    await db.owner`update extension_installations set state='active' where id=${created.id}`;
    await db.owner`update extension_jobs set status='succeeded',lease_until=null where installation_id=${created.id}`;
    // Asking configure to suggest for v2 without approving its new access is refused.
    const early = await t.request(`/v1/extensions/${created.id}/configure`, {
      key: keys.admin,
      body: { version: '2.0.0' },
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('grant_required');
    const { preview } = await approve(keys.admin, {
      ...first,
      installationId: created.id,
      version: '2.0.0',
      accessOnly: true,
    });
    expect(preview.grants.uses).toEqual(['model']);
    const [approval] = await db.owner`select uses from extension_access_approvals
      where installation_id=${created.id}`;
    expect(approval?.uses).toEqual(['model']);
    // The installation itself is still on v1, without model use.
    expect((await installation(created.id))?.granted_uses).toEqual([]);
    const digest = digestOf(upgradeV2);
    const job = await claimConfigure(ws.id, created.id, digest);
    expect(job.releaseDigest).toBe(digest);
    expect(job.uses).toEqual(['model']);
  });
});
