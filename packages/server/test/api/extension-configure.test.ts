import { randomBytes, randomUUID } from 'node:crypto';
import { BASE_OBJECT_IDS } from '@retainer/shared';
import { generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { Extensions } from '../../src/extensions/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase();
const configureId = randomUUID(),
  jobId = randomUUID();
const base = extensionFixture({
  scopes: ['read', 'write'],
  settings: {
    enabled: { type: 'boolean', label: 'Enabled', secret: false, required: true, reconnect: false },
    apiKey: { type: 'string', label: 'API key', secret: true, required: true, reconnect: true },
  },
  functions: [
    {
      universalId: configureId,
      name: 'configure',
      description: 'Suggest settings',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'configure' },
      timeoutSeconds: 120,
      inputSchema: { type: 'object', additionalProperties: false },
      scopes: ['read'],
      secrets: ['apiKey'],
    },
    {
      universalId: jobId,
      name: 'job',
      description: 'Ordinary writes',
      handlerDigest: 'b'.repeat(64),
      trigger: { kind: 'job' },
      timeoutSeconds: 120,
      inputSchema: { type: 'object', additionalProperties: false },
      scopes: ['read', 'write'],
      secrets: ['apiKey'],
    },
  ],
});
const next = extensionFixture({
  ...base,
  version: '2.0.0',
  settings: {
    ...base.settings,
    extraKey: { type: 'string', label: 'New key', secret: true, required: true, reconnect: true },
  },
  functions: base.functions.map((f) =>
    f.trigger.kind === 'configure' ? { ...f, secrets: ['apiKey', 'extraKey'] } : f,
  ),
});
const mapped = extensionFixture({
  ...base,
  version: '3.0.0',
  mapping: {
    objectId: BASE_OBJECT_IDS.company,
    outputs: [
      { key: 'company_name', label: 'Company name', description: 'Company name', types: ['text'] },
    ],
  },
});
const other = extensionFixture({
  ...base,
  universalId: randomUUID(),
  settings: {
    enabled: { type: 'boolean', label: 'Enabled', secret: false, required: true, reconnect: false },
  },
  functions: base.functions.map((fn) => ({ ...fn, secrets: [] })),
});
const standalone = extensionFixture({ execution: 'standalone', scopes: ['read'] });
const catalog = new ExtensionCatalog(
  [base, next, mapped, other, standalone].map((manifest) => ({
    manifest,
    actorCeiling: 'integration' as const,
    runtimeEnabled: true,
  })),
);
let t: TestApp, tokens: RunTokens;
const queue = () => new ExtensionQueue(t.sql, catalog.runtime);
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'test',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
  const broker = new SecretBroker(
    db.connect({ role: 'retainer_secret_broker' }),
    new SecretCipher('test', new Map([['test', randomBytes(32)]])),
  );
  t = startTestApp(db, {
    extensionCatalog: catalog,
    extensionSecrets: broker,
    runTokens: tokens,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
  });
});
async function setup(target = base) {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Configure ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['admin'] },
    },
  );
  const staged = await t.request('/v1/extensions/secrets', {
    key: keys.admin,
    body: {
      registrationId: base.universalId,
      version: target.version,
      name: 'apiKey',
      value: 'original',
    },
  });
  expect(staged.status).toBe(201);
  const input = {
    registrationId: base.universalId,
    version: target.version,
    settings: { enabled: true },
    secretRefs: { apiKey: staged.body.pendingSecretId },
  };
  const preview = await t.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(preview.status).toBe(200);
  expect(preview.body.operations).toEqual([]);
  expect(preview.body.grants.scopes).toEqual(['read']);
  const installed = await t.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  expect(installed.body.state).toBe('configuring');
  return {
    workspace: workspace.id,
    key: keys.admin,
    agent: keys.agent,
    id: installed.body.id as string,
  };
}
async function claim(workspace: string, id: string) {
  const [row] =
    await db.owner`select id from extension_jobs where installation_id=${id} and status='queued' and trigger_kind='configure' order by id desc limit 1`;
  if (!row) throw new Error('configure job missing');
  const job = await queue().claim(workspace, row.id, randomUUID());
  expect(job).not.toBeNull();
  if (!job) throw new Error('claim failed');
  const token = await tokens.issue(t.sql, job, job.registrationId, job.scopes);
  return { job, token };
}
async function turnOn(key: string, id: string) {
  const input = {
    installationId: id,
    registrationId: base.universalId,
    version: base.version,
    settings: { enabled: true },
    turnOn: true,
  };
  const preview = await t.request('/v1/extensions/preview', { key, body: input });
  expect(preview.status).toBe(200);
  const result = await t.request(`/v1/extensions/${id}/turn-on`, {
    key,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(result.status).toBe(200);
  expect(result.body.state).toBe('installing');
  return result;
}

describe('configuration before installation approval', () => {
  it('admits reads and secret reads, refuses writes and runtime mutations, and fences on turn-on', async () => {
    const { workspace, key, id } = await setup();
    const { job, token } = await claim(workspace, id);
    expect(job.scopes).toEqual(['read']);
    expect((await t.request('/v1/schema', { key: token })).status).toBe(200);
    expect(
      (await t.request(`/v1/extensions/${id}/runtime/secrets/apiKey`, { key: token })).body.value,
    ).toBe('original');
    expect(
      (
        await t.request('/v1/objects/company/records', {
          key: token,
          body: { values: { name: 'forbidden' } },
        })
      ).status,
    ).toBe(403);
    for (const input of [
      { children: [{ functionId: jobId, input: {}, dedupeKey: 'child' }] },
      { children: [], kv: { key: 'x', expectedRevision: null, value: 1 } },
    ])
      expect(
        (await t.request(`/v1/extensions/${id}/runtime/checkpoint`, { key: token, body: input }))
          .status,
      ).toBe(403);
    const saved = await t.request(`/v1/extensions/${id}/runtime/suggestions`, {
      method: 'PUT',
      key: token,
      body: { settings: { enabled: false } },
    });
    expect(saved.status).toBe(200);
    const before = await t.request(`/v1/extensions/${id}/suggestions`, { key });
    expect(before.body.status).toBe('running');
    expect(before.body.settings).toBeUndefined();
    await turnOn(key, id);
    expect(
      (
        await t.request(`/v1/extensions/${id}/runtime/suggestions`, {
          method: 'PUT',
          key: token,
          body: {},
        })
      ).status,
    ).toBe(409);
    const rows =
      await db.owner`select trigger_kind,status from extension_jobs where installation_id=${id}`;
    expect(rows.some((r) => r.trigger_kind === 'install' && r.status === 'queued')).toBe(true);
    expect(rows.some((r) => r.trigger_kind === 'configure' && r.status === 'running')).toBe(false);
    expect(
      await db.owner`select 1 from extension_suggestions where installation_id=${id}`,
    ).toHaveLength(0);
  });

  it('deduplicates concurrent requests, validates suggestions, and exposes only successful results', async () => {
    const { workspace, key, id } = await setup();
    const requests = await Promise.all(
      [1, 2].map(() => t.request(`/v1/extensions/${id}/configure`, { key, body: {} })),
    );
    expect(requests.map((r) => r.status)).toEqual([202, 202]);
    expect(requests[0]?.body.id).toBe(requests[1]?.body.id);
    const { job, token } = await claim(workspace, id);
    for (const body of [
      { settings: { apiKey: 'leak' } },
      { settings: { enabled: 'wrong' } },
      { mapping: { unknown: { action: 'skip' } } },
    ])
      expect(
        (
          await t.request(`/v1/extensions/${id}/runtime/suggestions`, {
            method: 'PUT',
            key: token,
            body,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await t.request(`/v1/extensions/${id}/runtime/suggestions`, {
          method: 'PUT',
          key: token,
          body: { settings: { enabled: false } },
        })
      ).status,
    ).toBe(200);
    await queue().complete(job, { status: 'succeeded' });
    const ready = await t.request(`/v1/extensions/${id}/suggestions`, { key });
    expect(ready.body).toMatchObject({ status: 'ready', settings: { enabled: false }, issues: {} });
    await t.request(`/v1/extensions/${id}/configure`, { key, body: {} });
    expect((await t.request(`/v1/extensions/${id}/suggestions`, { key })).body.status).toBe(
      'queued',
    );
  });

  it('resolves suggestions against schema changes and preserves invalid choices with issues', async () => {
    const a = await setup(mapped);
    const { job, token } = await claim(a.workspace, a.id);
    const saved = await t.request(`/v1/extensions/${a.id}/runtime/suggestions`, {
      method: 'PUT',
      key: token,
      body: {
        mapping: {
          company_name: {
            action: 'existing',
            field: 'name',
            reason: 'Use the existing company name.',
          },
        },
      },
    });
    expect(saved.status).toBe(200);
    await queue().complete(job, { status: 'succeeded' });
    expect(
      (await t.request(`/v1/extensions/${a.id}/suggestions`, { key: a.key })).body.issues,
    ).toEqual({});
    const changed = await t.request('/v1/schema/changes', {
      key: a.key,
      body: {
        operations: [{ op: 'rename_field', object: 'company', field: 'name', name: 'companyName' }],
      },
    });
    expect(changed.status).toBe(200);
    const read = await t.request(`/v1/extensions/${a.id}/suggestions`, { key: a.key });
    expect(read.body.mapping.company_name.field).toBe('name');
    expect(read.body.issues.company_name).toBe('field_not_found');
  });

  it('serializes suggestion saves with turn-on and rejects stale plans', async () => {
    const a = await setup();
    const { token } = await claim(a.workspace, a.id);
    const input = {
      installationId: a.id,
      registrationId: base.universalId,
      version: base.version,
      settings: { enabled: true },
      turnOn: true,
    };
    const preview = await t.request('/v1/extensions/preview', { key: a.key, body: input });
    const [save, commit] = await Promise.all([
      t.request(`/v1/extensions/${a.id}/runtime/suggestions`, {
        method: 'PUT',
        key: token,
        body: { settings: { enabled: false } },
      }),
      t.request(`/v1/extensions/${a.id}/turn-on`, {
        key: a.key,
        body: { ...input, planDigest: preview.body.planDigest },
        headers: { 'Idempotency-Key': randomUUID() },
      }),
    ]);
    expect([200, 409]).toContain(save.status);
    expect(commit.status).toBe(200);
    expect(
      await db.owner`select 1 from extension_suggestions where installation_id=${a.id}`,
    ).toHaveLength(0);
    const stale = await t.request(`/v1/extensions/${a.id}/turn-on`, {
      key: a.key,
      body: { ...input, planDigest: preview.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(stale.status).toBe(409);
  });

  it('clears suggestions on erasure and fences a run that read the erased data', async () => {
    const a = await setup();
    const person = await t.request('/v1/objects/person/records', {
      key: a.key,
      body: { values: { name: 'Private name' } },
    });
    expect(person.status).toBe(201);
    const { job, token } = await claim(a.workspace, a.id);
    await t.request(`/v1/extensions/${a.id}/runtime/suggestions`, {
      method: 'PUT',
      key: token,
      body: { settings: { enabled: false } },
    });
    const erased = await t.request(`/v1/records/${person.body.id}/forget`, {
      key: a.key,
      body: {},
    });
    expect(erased.status).toBe(200);
    expect(
      await db.owner`select 1 from extension_suggestions where installation_id=${a.id}`,
    ).toHaveLength(0);
    expect(
      (
        await t.request(`/v1/extensions/${a.id}/runtime/suggestions`, {
          method: 'PUT',
          key: token,
          body: { settings: { enabled: true } },
        })
      ).status,
    ).toBe(409);
    await expect(queue().renew(job)).rejects.toMatchObject({ status: 409 });
  });

  it("discards a failed attempt's partial suggestions before a successful retry", async () => {
    const a = await setup();
    const first = await claim(a.workspace, a.id);
    await t.request(`/v1/extensions/${a.id}/runtime/suggestions`, {
      method: 'PUT',
      key: first.token,
      body: { settings: { enabled: false } },
    });
    await queue().complete(first.job, {
      status: 'retry',
      code: 'provider_busy',
      retryAfterSeconds: 1,
    });
    await db.owner`update extension_jobs set available_at=now() where id=${first.job.jobId}`;
    const retry = await claim(a.workspace, a.id);
    await queue().complete(retry.job, { status: 'succeeded' });
    expect(
      (await t.request(`/v1/extensions/${a.id}/suggestions`, { key: a.key })).body.settings,
    ).toBeUndefined();
  });

  it('keeps suggestion metadata private to its installation for run tokens and standalone keys', async () => {
    const a = await setup();
    const install = async (target: typeof standalone, settings: Record<string, boolean> = {}) => {
      const input = { registrationId: target.universalId, version: target.version, settings };
      const preview = await t.request('/v1/extensions/preview', { key: a.key, body: input });
      expect(preview.status).toBe(200);
      const result = await t.request('/v1/extensions', {
        key: a.key,
        body: { ...input, planDigest: preview.body.planDigest },
        headers: { 'Idempotency-Key': randomUUID() },
      });
      expect(result.status).toBe(201);
      return result.body;
    };
    const b = await install(other, { enabled: true });
    const bRun = await claim(a.workspace, b.id);
    expect(
      (
        await t.request(`/v1/extensions/${b.id}/runtime/suggestions`, {
          method: 'PUT',
          key: bRun.token,
          body: { settings: { enabled: false } },
        })
      ).status,
    ).toBe(200);
    await queue().complete(bRun.job, { status: 'succeeded' });
    const aRun = await claim(a.workspace, a.id);
    expect(
      (await t.request(`/v1/extensions/${a.id}/suggestions`, { key: aRun.token })).status,
    ).toBe(200);
    expect(
      (await t.request(`/v1/extensions/${b.id}/suggestions`, { key: aRun.token })).status,
    ).toBe(404);
    expect(
      (await t.request(`/v1/extensions/${b.id}/suggestions`, { key: a.key })).body.settings,
    ).toEqual({ enabled: false });

    const app = await install(standalone);
    const credential = await t.request(`/v1/extensions/${app.id}/keys`, {
      key: a.key,
      body: { expectedGeneration: app.generation, scopes: ['read'] },
    });
    expect(credential.status).toBe(201);
    expect(
      (await t.request(`/v1/extensions/${b.id}/suggestions`, { key: credential.body.key })).status,
    ).toBe(404);
  });

  it('rechecks admission for previously authenticated run and installation callers', async () => {
    const a = await setup();
    const run = await claim(a.workspace, a.id);
    const caller = await tokens.authenticate(t.sql, run.token);
    const service = new Extensions(t.sql, catalog);
    expect((await service.suggestions(caller, a.id)).status).toBe('running');
    await queue().complete(run.job, { status: 'succeeded' });
    await expect(service.suggestions(caller, a.id)).rejects.toMatchObject({ status: 409 });

    const input = {
      registrationId: standalone.universalId,
      version: standalone.version,
      settings: {},
    };
    const preview = await t.request('/v1/extensions/preview', { key: a.key, body: input });
    const app = await t.request('/v1/extensions', {
      key: a.key,
      body: { ...input, planDigest: preview.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    const credential = await t.request(`/v1/extensions/${app.body.id}/keys`, {
      key: a.key,
      body: { expectedGeneration: app.body.generation, scopes: ['read'] },
    });
    const installedCaller: Caller = {
      workspaceId: a.workspace,
      actor: { type: 'integration', id: app.body.id },
      scopes: ['read'],
      installation: {
        installationId: app.body.id,
        registrationId: standalone.universalId,
        grantGeneration: app.body.grantGeneration,
        credentialId: credential.body.id,
        kind: 'key',
        scopes: ['read'],
      },
    };
    expect((await service.suggestions(installedCaller, app.body.id)).status).toBe('failed');
    await t.request(`/v1/extensions/${app.body.id}/disable`, { key: a.key, body: {} });
    await expect(service.suggestions(installedCaller, app.body.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('cancel and expiry remove jobs, secrets and suggestions without running uninstall', async () => {
    const a = await setup();
    expect(
      (await t.request(`/v1/extensions/${a.id}`, { method: 'DELETE', key: a.key })).body.state,
    ).toBe('uninstalled');
    const b = await setup();
    await db.owner`update extension_installations set created_at=now()-interval '15 days' where id=${b.id}`;
    await queue().maintain(db.connect({ role: 'retainer_executor' }));
    for (const id of [a.id, b.id]) {
      expect(
        (await db.owner`select state from extension_installations where id=${id}`)[0]?.state,
      ).toBe('uninstalled');
      for (const table of ['extension_jobs', 'extension_suggestions', 'extension_secrets'])
        expect(
          await db.owner.unsafe(`select 1 from ${table} where installation_id=$1`, [id]),
        ).toHaveLength(0);
    }
  });

  it('requires human approval and keeps an active release isolated while configuring an upgrade', async () => {
    const a = await setup();
    await turnOn(a.key, a.id);
    const [setupJob] =
      await db.owner`select id from extension_jobs where installation_id=${a.id} and trigger_kind='install'`;
    const install = await queue().claim(a.workspace, setupJob?.id, randomUUID());
    if (!install) throw new Error('install claim failed');
    await queue().complete(install, { status: 'succeeded' });
    expect(
      (await t.request(`/v1/extensions/${a.id}/configure`, { key: a.agent, body: {} })).status,
    ).toBe(403);
    expect(
      (
        await t.request(`/v1/extensions/${a.id}/configure`, {
          key: a.key,
          body: { version: next.version },
        })
      ).status,
    ).toBe(409);
    const staged = await t.request('/v1/extensions/secrets', {
      key: a.key,
      body: {
        installationId: a.id,
        registrationId: base.universalId,
        version: next.version,
        name: 'extraKey',
        value: 'target-only',
      },
    });
    const input = {
      installationId: a.id,
      registrationId: base.universalId,
      version: next.version,
      settings: { enabled: true },
      accessOnly: true,
      secretRefs: { extraKey: staged.body.pendingSecretId },
    };
    const preview = await t.request('/v1/extensions/preview', { key: a.key, body: input });
    expect(preview.status).toBe(200);
    const approval = await t.request(`/v1/extensions/${a.id}/access`, {
      key: a.key,
      body: { ...input, planDigest: preview.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(approval.status).toBe(200);
    expect(approval.body).toMatchObject({
      state: 'active',
      version: base.version,
      grantedScopes: ['read', 'write'],
    });
    const review = await t.request(`/v1/extensions/${a.id}/suggestions?version=${next.version}`, {
      key: a.key,
    });
    expect(review.body.access).toEqual({ settings: { enabled: true }, secrets: ['extraKey'] });
    expect(JSON.stringify(review.body)).not.toContain('target-only');
    const { job, token } = await claim(a.workspace, a.id);
    expect(job.releaseDigest).toBe(catalog.get(base.universalId, next.version).digest);
    expect(job.scopes).toEqual(['read']);
    expect(
      (await t.request(`/v1/extensions/${a.id}/runtime/secrets/extraKey`, { key: token })).body
        .value,
    ).toBe('target-only');
    expect(
      await db.owner`select 1 from extension_secrets where installation_id=${a.id} and name='extraKey'`,
    ).toHaveLength(0);
    await queue().renew(job);
    await queue().complete(job, { status: 'succeeded' });
    const upgradedInput = {
      installationId: a.id,
      registrationId: base.universalId,
      version: next.version,
      settings: { enabled: true },
    };
    const finalPreview = await t.request('/v1/extensions/preview', {
      key: a.key,
      body: upgradedInput,
    });
    expect(finalPreview.status).toBe(200);
    const upgraded = await t.request(`/v1/extensions/${a.id}/upgrade`, {
      key: a.key,
      body: { ...upgradedInput, planDigest: finalPreview.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(upgraded.status).toBe(200);
    expect(upgraded.body.version).toBe(next.version);
    expect(
      await db.owner`select 1 from extension_access_approvals where installation_id=${a.id}`,
    ).toHaveLength(0);
  });
});
