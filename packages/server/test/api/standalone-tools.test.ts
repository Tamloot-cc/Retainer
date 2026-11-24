import { randomBytes, randomUUID } from 'node:crypto';
import { executeRoutine } from '@retainer/runner/routine';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { inWorkspace } from '../../src/db/tx.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import type { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { RoutineExecutor } from '../../src/worker/routines.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { bindingStamp, extensionFixture } from '../helpers/extensions.js';
import { testRunTokens } from '../helpers/model.js';

/**
 * A standalone app with a hosted tool (extensions spec 8, 9.4), against real
 * Postgres: its own key writes the tool's generated secret, the tool is ready
 * only with a live credential and that secret, a routine calls it, and the
 * app's write citing the tool call carries the routine in its cause chain.
 * The app's contributed fields are installation-owned.
 */
const db = useTestDatabase(),
  workspaces: string[] = [];
let tokens: RunTokens, broker: SecretBroker;
beforeAll(async () => {
  ({ tokens } = await testRunTokens());
  broker = new SecretBroker(
    db.connect({ role: 'retainer_secret_broker' }),
    new SecretCipher('k1', new Map([['k1', randomBytes(32)]])),
  );
});
afterEach(async () => {
  if (workspaces.length)
    await db.owner`delete from workspaces where id=any(${workspaces.splice(0)}::uuid[])`;
});

const setting = (generated: boolean) => ({
  type: 'string' as const,
  label: generated ? 'Tool key' : 'Provider key',
  secret: true,
  reconnect: false,
  required: false,
  ...(generated ? { generated: true } : {}),
});

async function setup(execution: 'standalone' | 'hosted' = 'standalone') {
  const toolId = randomUUID();
  const jobId = randomUUID();
  const manifest = extensionFixture({
    execution,
    scopes: ['read', 'write'],
    settings: { toolKey: setting(true), providerKey: setting(false) },
    ...(execution === 'standalone'
      ? {
          bindings: [
            {
              key: 'order',
              label: 'Orders',
              description: 'Orders tracked by the app.',
              class: 'entity',
              access: 'write',
              required: true,
              owned: true,
              creates: true,
              create: {
                universalId: randomUUID(),
                nameSingular: 'order',
                namePlural: 'orders',
                labelSingular: 'Order',
                labelPlural: 'Orders',
                description: 'Fixture description.',
                labelField: 'title',
                fields: [],
              },
              fields: [
                {
                  key: 'orderId',
                  label: 'Order ID',
                  description: 'Fixture description.',
                  types: ['text'],
                  required: true,
                  owned: true,
                  installationOwned: true,
                  create: {
                    universalId: randomUUID(),
                    name: 'orderId',
                    label: 'Order ID',
                    type: 'text',
                    description: 'Fixture description.',
                    isUnique: true,
                  },
                },
                {
                  key: 'title',
                  label: 'Title',
                  description: 'Fixture description.',
                  types: ['text'],
                  required: true,
                  owned: true,
                  installationOwned: true,
                  create: {
                    universalId: randomUUID(),
                    name: 'title',
                    label: 'Title',
                    type: 'text',
                    description: 'Fixture description.',
                  },
                },
                {
                  key: 'note',
                  label: 'Note',
                  description: 'Fixture description.',
                  types: ['text'],
                  required: false,
                  create: {
                    universalId: randomUUID(),
                    name: 'note',
                    label: 'Note',
                    type: 'text',
                    description: 'Fixture description.',
                  },
                },
              ],
            },
          ],
        }
      : {}),
    functions: [
      {
        universalId: toolId,
        name: 'find_slots',
        description: 'Finds open times.',
        handlerDigest: 'b'.repeat(64),
        timeoutSeconds: 60,
        secrets: ['toolKey'],
        trigger: {
          kind: 'tool',
          title: 'Find open times',
          effect: 'read',
          connection: 'workspace',
          outputSchema: { type: 'object', additionalProperties: false },
        },
        inputSchema: { type: 'object', additionalProperties: false },
      },
      {
        universalId: jobId,
        name: 'maintain-slots',
        description: 'Maintains open times.',
        handlerDigest: 'c'.repeat(64),
        timeoutSeconds: 60,
        secrets: ['toolKey'],
        trigger: { kind: 'job' },
        inputSchema: { type: 'object', additionalProperties: false },
      },
    ],
  });
  const catalog = new ExtensionCatalog([
      { manifest, actorCeiling: 'integration', runtimeEnabled: true },
    ]),
    release = catalog.get(manifest.universalId, manifest.version);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set([release.digest]),
    extensionSecrets: broker,
    runTokens: tokens,
    routines: { available: true, modelAvailable: false },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Standalone tools ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin', name: 'Ada' }, scopes: ['admin'] } },
  );
  workspaces.push(workspace.id);
  const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
  const plan = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: plan.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status, JSON.stringify(installed.body)).toBe(201);
  const installationId = installed.body.id as string;
  const queue = new ExtensionQueue(app.sql, catalog.runtime);
  const claim = (id: string) => queue.claim(workspace.id, id, 'test-executor');
  const jobs = await db.owner<
    { id: string }[]
  >`select id from extension_jobs where installation_id=${installationId}`;
  if (execution === 'hosted') {
    expect(installed.body.state).toBe('installing');
    const setupJob = jobs[0] && (await claim(jobs[0].id));
    if (!setupJob) throw new Error('setup job not claimed');
    await queue.complete(setupJob, { status: 'succeeded' });
  } else {
    expect(installed.body.state).toBe('active');
    expect(jobs).toHaveLength(0);
  }
  const issue = async () => {
    const [row] = await db.owner<{ grant_generation: number }[]>`
      select grant_generation from extension_installations where id=${installationId}`;
    const issued = await app.request(`/v1/extensions/${installationId}/keys`, {
      key: keys.admin,
      body: { expectedGeneration: row?.grant_generation, scopes: ['read', 'write'] },
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    return issued.body as { id: string; key: string };
  };
  const stamp = async (key: string) => {
    const response = await app.request(`/v1/extensions/${installationId}/bindings`, { key });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return bindingStamp(response.body, 'order');
  };
  const writeSecret = (key: string, expectedRevision: number | null, name = 'toolKey') =>
    app.request(`/v1/extensions/${installationId}/generated-secrets/${name}`, {
      key,
      method: 'PUT',
      body: { expectedRevision, value: `https://app.test|${randomUUID()}` },
    });
  const revoke = async (credentialId: string) => {
    const response = await app.request(
      `/v1/extensions/${installationId}/credentials/${credentialId}`,
      { key: keys.admin, method: 'DELETE' },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  };
  const enqueue = async (kind: 'tool' | 'job') => {
    const id = randomUUID();
    await db.owner`insert into extension_jobs
      (id,workspace_id,installation_id,generation,release_digest,function_id,trigger_kind,input,input_hash,dedupe_key)
      select ${id},workspace_id,id,generation,release_digest,${kind === 'tool' ? toolId : jobId},${kind},'{}',${id},${id}
      from extension_installations where id=${installationId}`;
    return id;
  };
  const secret = {
    workspaceId: workspace.id,
    installationId,
    registrationId: manifest.universalId,
    name: 'toolKey',
  };
  const readSecret = (key: string) =>
    app.request(`/v1/extensions/${installationId}/runtime/secrets/toolKey`, { key });
  const toolStatus = async () => {
    const capabilities = await app.request('/v1/routines/capabilities', { key: keys.admin });
    expect(capabilities.status, JSON.stringify(capabilities.body)).toBe(200);
    return (capabilities.body.tools as { name: string; status: string }[]).find(
      (tool) => tool.name === 'find_slots',
    )?.status;
  };
  return {
    app,
    catalog,
    workspace: workspace.id,
    keys,
    installationId,
    issue,
    stamp,
    revoke,
    claim,
    enqueue,
    secret,
    readSecret,
    writeSecret,
    toolStatus,
  };
}

describe('standalone app with a hosted tool', () => {
  it('is ready only with a live credential and the secret its own credential wrote', async () => {
    const s = await setup();
    expect(await s.toolStatus()).toBe('not_connected');
    const credential = await s.issue();
    // A live credential alone is not enough: the tool needs its key.
    expect(await s.toolStatus()).toBe('not_connected');

    const first = await s.writeSecret(credential.key, null);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual({ revision: 1 });
    expect(await s.toolStatus()).toBe('ready');

    // A stale revision gets the current one back, never the value.
    const stale = await s.writeSecret(credential.key, null);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'revision_conflict',
      details: { revision: 1 },
    });
    expect(JSON.stringify(stale.body)).not.toContain('app.test');
    expect((await s.writeSecret(credential.key, 1)).body).toEqual({ revision: 2 });

    // Only generated secrets, only by the app's own credential, never a read.
    expect((await s.writeSecret(credential.key, null, 'providerKey')).status).toBe(404);
    expect((await s.writeSecret(s.keys.admin, 2)).status).toBe(403);
    expect(
      (
        await s.app.request(`/v1/extensions/${s.installationId}/runtime/secrets/toolKey`, {
          key: credential.key,
        })
      ).status,
    ).toBe(403);

    // Revocation does not change connection health; readiness still ends.
    const revoked = await s.app.request(
      `/v1/extensions/${s.installationId}/credentials/${credential.id}`,
      { key: s.keys.admin, method: 'DELETE' },
    );
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(await s.toolStatus()).toBe('not_connected');
    expect((await s.writeSecret(credential.key, 2)).status).toBe(401);
  });

  it('lets one of two concurrent writes with the same revision through', async () => {
    const s = await setup();
    const { key } = await s.issue();
    expect((await s.writeSecret(key, null)).status).toBe(200);
    const results = await Promise.all([s.writeSecret(key, 1), s.writeSecret(key, 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.error.details).toEqual({ revision: 2 });
  });

  it('carries a routine through its tool call into the write that cites it', async () => {
    const s = await setup();
    const { key } = await s.issue();
    expect((await s.writeSecret(key, null)).status).toBe(200);
    const executor = new RoutineExecutor({
      sql: s.app.sql,
      discoverySql: db.connect({ role: 'retainer_executor', max: 1 }),
      tokens,
      driver: {
        invoke: (_e, invocation, signal) =>
          executeRoutine(invocation, signal, s.app.inProcessFetch),
      },
      executable: { releaseDigest: 'a'.repeat(64) } as never,
      apiOrigin: 'http://retainer.test/',
      owner: 'test-executor',
      config: { catalog: s.catalog.runtime, modelAvailable: false },
    });
    const source = {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Find times' },
        uses: { tools: ['find_slots'], model: false },
      },
      code: `export async function main({ retainer }: RoutineContext<'company'>) {
  return await retainer.tools.find_slots({});
}
`,
    };
    const validated = await s.app.request('/v1/routines/validate', {
      key: s.keys.admin,
      body: source,
    });
    expect(validated.body.problems).toEqual([]);
    await executor.tick();
    const proposed = await s.app.request('/v1/routines', {
      key: s.keys.admin,
      body: {
        ...source,
        name: 'Find times',
        description: 'Finds open times.',
        summary: 'Finds open times.',
        report: { verdict: 'full', gaps: [] },
      },
    });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
    const { routineId, versionId } = proposed.body;
    await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/approve`, {
      key: s.keys.admin,
      body: {},
    });
    const company = await s.app.request('/v1/objects/company/records', {
      key: s.keys.admin,
      body: { values: { name: 'Acme' } },
    });
    const pressed = await s.app.request(`/v1/routines/${routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [company.body.id] },
    });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(202);
    const claimed = await executor.claim(s.workspace, pressed.body.runs[0]);
    if (!claimed) throw new Error('run not claimed');
    const runToken = await tokens.issueRoutine(
      s.workspace,
      { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'run', tools: claimed.tools },
      new Date(Date.now() + 60000),
    );
    const called = await s.app.request('/v1/routines/runtime/effects', {
      key: runToken,
      body: { position: 1, operation: 'tool', args: { name: 'find_slots', input: {} } },
    });
    expect(called.status, JSON.stringify(called.body)).toBe(200);
    const callId = called.body.tool.callId as string;

    // The tool's function hands the call ID to the app; the app's write names it.
    const bindings = await s.stamp(key);
    const write = (causes: string[]) =>
      s.app.request('/v1/objects/order/records', {
        key,
        headers: { 'Retainer-Caused-By': causes.join(', ') },
        body: { values: { orderId: randomUUID(), title: 'Intro call' }, bindings },
      });
    const written = await write([callId]);
    expect(written.status, JSON.stringify(written.body)).toBe(201);
    const [change] = await db.owner<{ cause: string[]; cause_depth: number }[]>`
      select cause,cause_depth from record_changes where record_id=${written.body.id}`;
    expect(change?.cause).toEqual(expect.arrayContaining([routineId, s.installationId]));
    expect(change?.cause_depth).toBe(1);

    // A call that is not this app's retained tool call: write without it.
    expect((await write([randomUUID()])).body.error?.code).toBe('cause_expired');
    expect((await write(Array.from({ length: 9 }, () => callId))).status).toBe(400);
    // Only the app's own credential may name causes.
    const asAdmin = await s.app.request('/v1/objects/company/records', {
      key: s.keys.admin,
      headers: { 'Retainer-Caused-By': callId },
      body: { values: { name: 'Globex' } },
    });
    expect(asAdmin.status).toBe(400);
  });
});

describe('standalone tool admission', () => {
  it('cancels a queued tool after the last credential is revoked', async () => {
    const s = await setup();
    const credential = await s.issue();
    expect((await s.writeSecret(credential.key, null)).status).toBe(200);
    expect(await s.toolStatus()).toBe('ready');
    const id = await s.enqueue('tool');
    await s.revoke(credential.id);

    expect(await s.claim(id)).toBeNull();
    expect(await db.owner`select status,code,attempt from extension_jobs where id=${id}`).toEqual([
      { status: 'cancelled', code: 'connection_required', attempt: 0 },
    ]);
    expect(await s.claim(id)).toBeNull();
  });

  it('refuses a claimed tool secret after the last credential is revoked', async () => {
    const s = await setup();
    const credential = await s.issue();
    expect((await s.writeSecret(credential.key, null)).status).toBe(200);
    const run = await s.claim(await s.enqueue('tool'));
    if (!run) throw new Error('tool not claimed');
    const token = await tokens.issue(s.app.sql, run, run.registrationId, ['read']);
    const before = await s.readSecret(token);
    expect(before.status).toBe(200);
    expect(before.body.value).toContain('https://app.test');

    await s.revoke(credential.id);

    const refused = await s.readSecret(token);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('installation_disabled');
    expect(refused.body).not.toHaveProperty('value');
  });

  it('admits a standalone non-tool job after revocation', async () => {
    const s = await setup();
    const credential = await s.issue();
    expect((await s.writeSecret(credential.key, null)).status).toBe(200);
    await s.revoke(credential.id);
    const run = await s.claim(await s.enqueue('job'));
    if (!run) throw new Error('job not claimed');
    expect(await broker.readRuntime(s.secret, run)).toMatchObject({ revision: 1 });
  });

  it('admits a hosted tool without any installation credential', async () => {
    const s = await setup('hosted');
    const run = await s.claim(await s.enqueue('tool'));
    if (!run) throw new Error('tool not claimed');
    await broker.writeRuntime(s.secret, run, null, 'hosted tool secret');
    expect(await broker.readRuntime(s.secret, run)).toEqual({
      revision: 1,
      value: 'hosted tool secret',
    });
  });

  it('serializes revoke against broker admission and queue claim', async () => {
    const s = await setup();
    const credential = await s.issue();
    expect((await s.writeSecret(credential.key, null)).status).toBe(200);
    const run = await s.claim(await s.enqueue('tool'));
    if (!run) throw new Error('tool not claimed');
    const queued = await s.enqueue('tool');
    const registrationKey = `${s.workspace}:${run.registrationId}`;
    const waitForBlocked = (count: number) =>
      vi.waitFor(async () => {
        const [locks] = await db.owner<{ waiting: number }[]>`
          select count(*)::int as waiting from pg_locks
          where locktype='advisory' and classid=21061 and objsubid=2
            and objid=hashtext(${registrationKey})::oid and not granted`;
        expect(locks?.waiting).toBe(count);
      });

    const { outcomes } = await inWorkspace(
      db.connect({ role: 'retainer_secret_broker' }),
      s.workspace,
      async (tx) => {
        // Hold the locks of a successful admission while revocation queues behind it.
        const [admission] = await tx<{ admitted: boolean }[]>`select retainer_admit_secret_run(
          ${run.registrationId}::uuid,${run.installationId}::uuid,${run.generation},${run.jobId}::uuid,
          ${run.owner},${run.fence}::bigint,${run.releaseDigest},${run.functionId}::uuid,'toolKey',false) as admitted`;
        expect(admission?.admitted).toBe(true);
        const revoke = Promise.allSettled([s.revoke(credential.id)]);
        await waitForBlocked(1);
        const outcomes = Promise.all([
          revoke,
          Promise.allSettled([s.claim(queued)]),
          Promise.allSettled([broker.readRuntime(s.secret, run)]),
        ]);
        await waitForBlocked(3);
        return { outcomes };
      },
    );
    expect(await outcomes).toEqual([
      [{ status: 'fulfilled', value: undefined }],
      [{ status: 'fulfilled', value: null }],
      [{ status: 'rejected', reason: expect.objectContaining({ code: 'installation_disabled' }) }],
    ]);
    await expect(broker.readRuntime(s.secret, run)).rejects.toMatchObject({
      code: 'installation_disabled',
    });
    expect(await db.owner`select status,code from extension_jobs where id=${queued}`).toEqual([
      { status: 'cancelled', code: 'connection_required' },
    ]);
  });
});

describe('sidebar link credentials', () => {
  it('forbids installation credentials with read scope', async () => {
    const s = await setup();
    const { key } = await s.issue();
    const response = await s.app.request('/v1/extensions/links', { key });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('forbids hosted run tokens with read scope', async () => {
    const s = await setup('hosted');
    const run = await s.claim(await s.enqueue('tool'));
    if (!run) throw new Error('tool not claimed');
    const key = await tokens.issue(s.app.sql, run, run.registrationId, ['read']);
    const response = await s.app.request('/v1/extensions/links', { key });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });
});

describe('installation-owned fields', () => {
  it('are written, merged and deleted only by their installation', async () => {
    const s = await setup();
    const { key } = await s.issue();
    const bindings = await s.stamp(key);
    const create = async (title: string) => {
      const created = await s.app.request('/v1/objects/order/records', {
        key,
        body: { values: { orderId: randomUUID(), title }, bindings },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.id as string;
    };
    const first = await create('Intro call'),
      second = await create('Follow-up');
    const patch = (credential: string, values: Record<string, unknown>) =>
      s.app.request(`/v1/records/${first}`, {
        key: credential,
        method: 'PATCH',
        body: { values, ...(credential === key ? { bindings } : {}) },
      });

    // A person cannot outrank the app's value; their own fields stay theirs.
    const refused = await patch(s.keys.admin, { title: 'Renamed' });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: 'installation_owned',
      details: { field: 'title' },
    });
    expect((await patch(s.keys.admin, { note: 'Bring the contract' })).status).toBe(200);
    expect((await patch(key, { title: 'Intro call (moved)' })).status).toBe(200);
    const upserted = await s.app.request('/v1/objects/order/upsert', {
      key: s.keys.admin,
      body: { match: { orderId: randomUUID() }, ifMissing: 'create', values: { note: 'x' } },
    });
    expect(upserted.status, JSON.stringify(upserted.body)).toBe(403);

    // Read-only to everyone but the app.
    const fields = async (credential: string) =>
      Object.fromEntries(
        (
          (await s.app.request('/v1/schema', { key: credential })).body.objects as {
            nameSingular: string;
            fields: { name: string; readOnly: boolean }[];
          }[]
        )
          .find((o) => o.nameSingular === 'order')
          ?.fields.map((f) => [f.name, f.readOnly]) ?? [],
      );
    expect(await fields(s.keys.admin)).toMatchObject({
      orderId: true,
      title: true,
      note: false,
    });
    expect(await fields(key)).toMatchObject({ orderId: false, title: false, note: false });

    // Merge and delete of a record keyed by an owned field.
    const merged = await s.app.request(`/v1/records/${first}/merge`, {
      key: s.keys.admin,
      body: { recordId: second },
    });
    expect(merged.status).toBe(403);
    expect(merged.body.error.code).toBe('installation_owned');
    const deleted = await s.app.request(`/v1/records/${first}`, {
      key: s.keys.admin,
      method: 'DELETE',
    });
    expect(deleted.status).toBe(403);
    expect(
      (
        await s.app.request(`/v1/records/${second}`, {
          key,
          method: 'DELETE',
          body: { bindings },
        })
      ).status,
    ).toBe(200);
    // An admin's erasure still works.
    const forgotten = await s.app.request(`/v1/records/${first}/forget`, {
      key: s.keys.admin,
      body: {},
    });
    expect(forgotten.status, JSON.stringify(forgotten.body)).toBe(200);

    // Uninstalled, the app no longer owns its fields.
    const third = await create('Later');
    expect(
      (
        await s.app.request(`/v1/extensions/${s.installationId}`, {
          key: s.keys.admin,
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await s.app.request(`/v1/records/${third}`, {
          key: s.keys.admin,
          method: 'PATCH',
          body: { values: { title: 'Kept by the workspace' } },
        })
      ).status,
    ).toBe(200);
  });
});
