import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGranola } from '@retainer/runner/granola';
import { GRANOLA, granolaManifest } from '@retainer/runner/granola-contract';
import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ClaimedJob, ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { SecretBroker, SecretCipher } from '../../src/extension-runtime/secrets.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { createFileServer, LocalFileStorage } from '../../src/file-storage/local.js';
import { Webhooks } from '../../src/webhooks/service.js';
import { ExecutionRegistry } from '../../src/worker/extensions.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
let directory: string,
  storage: LocalFileStorage,
  fileServer: ReturnType<typeof createFileServer>,
  tokens: RunTokens,
  broker: SecretBroker;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'retainer-granola-'));
  const key = randomBytes(32);
  fileServer = createFileServer({ directory, key });
  await new Promise<void>((r) => fileServer.listen(0, '127.0.0.1', r));
  const address = fileServer.address();
  if (!address || typeof address === 'string') throw new Error('missing byte server');
  storage = new LocalFileStorage(`http://127.0.0.1:${address.port}`, key);
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'granola',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
  broker = new SecretBroker(
    db.connect({ role: 'retainer_secret_broker' }),
    new SecretCipher('test', new Map([['test', randomBytes(32)]])),
  );
});
afterAll(async () => {
  await new Promise<void>((r) => fileServer.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const manifest = granolaManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    verifierDigest: 'c'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  const catalog = new ExtensionCatalog([
    { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  ]);
  const base = startTestApp(db),
    webhooks = new Webhooks({
      sql: base.sql,
      catalog,
      broker,
      registry: new ExecutionRegistry([]),
      publicOrigin: 'http://retainer.test',
      driver: { verify: async () => ({ status: 'rejected' }) },
    });
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    extensionActivation: new Set(catalog.list().map((r) => r.digest)),
    runTokens: tokens,
    extensionSecrets: broker,
    fileStorage: storage,
    webhooks,
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Granola ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
  );
  const settings = {
    shareAccessibleNotes: true,
    createPeople: 'never',
    backfillDays: 1,
    webhooks: false,
  };
  const stage = await app.request('/v1/extensions/secrets', {
    key: keys.admin,
    body: {
      registrationId: manifest.universalId,
      version: manifest.version,
      name: 'apiKey',
      value: 'fixture-provider-key',
    },
  });
  expect(stage.status).toBe(201);
  const input = {
    registrationId: manifest.universalId,
    version: manifest.version,
    settings,
    secretRefs: { apiKey: stage.body.pendingSecretId },
  };
  const preview = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
  expect(preview.status).toBe(200);
  const installed = await app.request('/v1/extensions', {
    key: keys.admin,
    body: { ...input, planDigest: preview.body.planDigest },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  expect(installed.status).toBe(201);
  const id = installed.body.id as string,
    queue = new ExtensionQueue(app.sql, catalog.runtime);
  const providerId = 'not_123456789abcde';
  let version = 1,
    status = 200,
    expectedKey = 'fixture-provider-key';
  const providerNote = () => ({
    id: providerId,
    title: `Meeting ${version}`,
    owner: { email: 'organizer@example.com', name: 'Owner' },
    created_at: '2026-11-10T08:00:00Z',
    updated_at: `2026-11-10T1${version}:00:00Z`,
    deleted_at: null,
    web_url: 'https://notes.granola.ai/d/fixture',
    summary_text: `Shared summary ${version}`,
    private_notes_text: 'MUST NEVER LEAVE PROVIDER',
    private_notes_markdown: 'MUST NEVER LEAVE PROVIDER',
    attachments: [{ url: 'https://private.example/NEVER-FETCH' }],
    attendees: [{ email: 'attendee@example.com', name: 'Attendee' }],
    calendar_event: {
      organiser: 'organizer@example.com',
      invitees: [{ email: 'attendee@example.com' }],
      scheduled_start_time: '2026-11-10T09:00:00Z',
    },
    transcript: [
      {
        speaker: { source: 'microphone', name: 'Owner' },
        text: `Transcript version ${version}`,
        start_time: '2026-11-10T09:00:00Z',
        end_time: '2026-11-10T09:01:00Z',
      },
    ],
  });
  const seenApiBodies: string[] = [];
  const transport: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    if (target.origin === 'https://public-api.granola.ai') {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${expectedKey}`);
      if (target.pathname === '/v1/notes')
        return Response.json({
          notes: [{ id: providerId, updated_at: providerNote().updated_at }],
          hasMore: false,
          cursor: null,
        });
      expect(target.pathname).toBe(`/v1/notes/${providerId}`);
      return status === 200
        ? Response.json(providerNote())
        : Response.json({ sensitive: 'provider failure' }, { status });
    }
    if (target.origin === 'https://retainer.test') {
      if (init?.body) seenApiBodies.push(String(init.body));
      return app.inProcessFetch(url, init);
    }
    // Only the byte URL returned by this API may receive the transcript; no bearer is forwarded.
    expect(target.origin).toBe(new URL(storageOrigin()).origin);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    return fetch(url, init);
  };
  function storageOrigin() {
    const a = fileServer.address();
    if (!a || typeof a === 'string') throw new Error('missing address');
    return `http://127.0.0.1:${a.port}`;
  }
  async function execute(job: ClaimedJob) {
    const token = await tokens.issue(app.sql, job, manifest.universalId, job.scopes);
    const result = await executeGranola(
      {
        protocolVersion: 1,
        runId: job.jobId,
        attempt: job.attempt,
        installationId: id,
        releaseDigest: job.releaseDigest,
        functionId: job.functionId,
        input: job.input as any,
        apiOrigin: 'https://retainer.test',
        runToken: token,
        deadline: job.deadline.toISOString(),
      },
      new AbortController().signal,
      transport,
    );
    await queue.complete(job, result);
    return result;
  }
  async function drain() {
    const results = [];
    for (let i = 0; i < 10; i++) {
      const [next] =
        await db.owner`select id from extension_jobs where installation_id=${id} and status='queued' and available_at<=clock_timestamp() order by created_at,id limit 1`;
      if (!next) return results;
      const run = await queue.claim(workspace.id, next.id, 'granola-fixture');
      if (!run) throw new Error('missing claimed job');
      results.push(await execute(run));
    }
    throw new Error('Granola fixture did not drain bounded queue');
  }
  async function sync() {
    const [item] =
      await db.owner`select s.id from source_items s join source_bindings b on b.account_id=s.account_id where b.installation_id=${id}`;
    const enqueued = await queue.enqueue(workspace.id, id, {
      functionId: GRANOLA.sync,
      input: { sourceItemId: item?.id },
      dedupeKey: randomUUID(),
    });
    const run = await queue.claim(workspace.id, enqueued.id, 'granola-fixture');
    if (!run) throw new Error('missing sync run');
    return execute(run);
  }
  return {
    app,
    id,
    workspace,
    keys,
    queue,
    drain,
    sync,
    seenApiBodies,
    setCredential: (value: string) => {
      expectedKey = value;
    },
    setVersion: (v: number) => {
      version = v;
    },
    setStatus: (v: number) => {
      status = v;
    },
  };
}

describe('Granola provider fixture through real API, RLS Postgres and file byte storage', () => {
  it('imports history, stores complete transcripts as files, preserves edits and reports unavailable notes without deleting evidence', async () => {
    const h = await setup();
    expect(await h.drain()).toEqual([
      { status: 'succeeded' },
      { status: 'succeeded' },
      { status: 'succeeded' },
    ]);
    const initial =
      await db.owner`select r.id,r.event_id,r.content_digest from source_revisions r where r.workspace_id=${h.workspace.id}`;
    expect(initial).toHaveLength(1);
    const [counts] =
      await db.owner`select count(*)::int as count from records where workspace_id=${h.workspace.id} and deleted_at is null and object_type_id in (select id from object_types where workspace_id=${h.workspace.id} and name_singular='person')`;
    expect(counts?.count).toBe(0);
    const [file] =
      await db.owner`select id from files where workspace_id=${h.workspace.id} and state='ready'`;
    const download = await h.app.request(`/v1/files/${file?.id}/download`, {
      key: h.keys.admin,
      method: 'POST',
    });
    expect(download.status).toBe(200);
    expect(await (await fetch(download.body.url)).json()).toMatchObject([
      { text: 'Transcript version 1' },
    ]);
    expect(h.seenApiBodies.join('\n')).not.toContain('MUST NEVER LEAVE PROVIDER');
    expect(h.seenApiBodies.join('\n')).not.toContain('Transcript version 1');
    expect(h.seenApiBodies.join('\n')).not.toContain('NEVER-FETCH');
    const status = await h.app.request(`/v1/extensions/${h.id}/source-sync`, { key: h.keys.admin });
    expect(status.body).toMatchObject({ activeScan: null, pendingItems: 0, failedItems: 0 });
    expect(status.body.lastSuccessfulScanAt).toBeTruthy();
    h.setVersion(2);
    expect(await h.sync()).toEqual({ status: 'succeeded' });
    const revisions =
      await db.owner`select event_id from source_revisions where workspace_id=${h.workspace.id}`;
    expect(revisions).toHaveLength(2);
    expect(new Set(revisions.map((r) => r.event_id)).size).toBe(2);
    h.setStatus(404);
    expect(await h.sync()).toMatchObject({ status: 'retry', code: 'provider_note_unavailable' });
    expect(
      (await db.owner`select state from source_items where workspace_id=${h.workspace.id}`)[0]
        ?.state,
    ).toBe('unavailable');
    expect(
      (
        await db.owner`select count(*)::int as count from source_revisions where workspace_id=${h.workspace.id}`
      )[0]?.count,
    ).toBe(2);
    h.setStatus(200);
    expect(await h.sync()).toEqual({ status: 'succeeded' });
    expect(
      (await db.owner`select state from source_items where workspace_id=${h.workspace.id}`)[0]
        ?.state,
    ).toBe('live');
    expect(
      (
        await db.owner`select count(*)::int as count from source_revisions where workspace_id=${h.workspace.id}`
      )[0]?.count,
    ).toBe(2);
    h.setStatus(401);
    expect(await h.sync()).toEqual({ status: 'failed', code: 'provider_unauthorized' });
    expect(
      (await db.owner`select connection_health from extension_installations where id=${h.id}`)[0]
        ?.connection_health,
    ).toBe('needs_reconnect');
  });
  it('reconnects reviewed credentials without duplicating source history, and runs credential-scoped uninstall cleanup', async () => {
    const h = await setup();
    await h.drain();
    const [before] =
      await db.owner`select account_id from source_bindings where installation_id=${h.id}`;
    h.setStatus(401);
    expect(await h.sync()).toMatchObject({ status: 'failed', code: 'provider_unauthorized' });
    const stage = await h.app.request('/v1/extensions/secrets', {
      key: h.keys.admin,
      body: {
        registrationId: GRANOLA.registration,
        version: '1.0.0',
        installationId: h.id,
        name: 'apiKey',
        value: 'rotated-provider-key',
      },
    });
    expect(stage.status).toBe(201);
    const [installation] =
      await db.owner`select settings from extension_installations where id=${h.id}`;
    const input = {
      registrationId: GRANOLA.registration,
      version: '1.0.0',
      installationId: h.id,
      reconnect: true,
      settings: installation?.settings,
      secretRefs: { apiKey: stage.body.pendingSecretId },
    };
    const preview = await h.app.request('/v1/extensions/preview', {
      key: h.keys.admin,
      body: input,
    });
    expect(preview.status).toBe(200);
    const connected = await h.app.request(`/v1/extensions/${h.id}/reconnect`, {
      key: h.keys.admin,
      body: { ...input, planDigest: preview.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(connected.status).toBe(200);
    expect(
      (await h.app.request(`/v1/extensions/${h.id}/source-sync`, { key: h.keys.admin })).body
        .lastSuccessfulScanAt,
    ).toBeNull();
    h.setCredential('rotated-provider-key');
    h.setStatus(200);
    expect((await h.drain()).every((r) => r.status === 'succeeded')).toBe(true);
    expect(
      (await db.owner`select account_id from source_bindings where installation_id=${h.id}`)[0]
        ?.account_id,
    ).toBe(before?.account_id);
    expect(
      (
        await db.owner`select count(*)::int as count from source_revisions where workspace_id=${h.workspace.id}`
      )[0]?.count,
    ).toBe(1);
    expect(
      (await h.app.request(`/v1/extensions/${h.id}/uninstall`, { key: h.keys.admin, body: {} }))
        .status,
    ).toBe(200);
    expect(await h.drain()).toEqual([{ status: 'succeeded' }]);
    expect(
      (await db.owner`select state from extension_installations where id=${h.id}`)[0]?.state,
    ).toBe('uninstalled');
    expect(
      (
        await db.owner`select count(*)::int as count from source_revisions where workspace_id=${h.workspace.id}`
      )[0]?.count,
    ).toBe(1);
  });
  it('suppresses reimport after source erasure and cancels queued source runs when settings change', async () => {
    const h = await setup();
    await h.drain();
    const [revision] =
      await db.owner`select event_id from source_revisions where workspace_id=${h.workspace.id}`;
    expect(
      (
        await h.app.request(`/v1/records/${revision?.event_id}/forget`, {
          key: h.keys.admin,
          body: {},
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await db.owner`select state,external_id from source_items where workspace_id=${h.workspace.id}`
      )[0],
    ).toMatchObject({ state: 'erased', external_id: null });
    expect(
      (
        await db.owner`select count(*)::int as count from extension_kv where installation_id=${h.id}`
      )[0]?.count,
    ).toBe(0);
    await h.queue.enqueue(h.workspace.id, h.id, {
      functionId: GRANOLA.scan,
      input: {
        scanId: randomUUID(),
        mode: 'created',
        from: '2026-11-10T00:00:00Z',
        through: '2026-11-10T01:00:00Z',
      },
      dedupeKey: randomUUID(),
    });
    expect(
      (
        await db.owner`select count(*)::int as count from extension_jobs where installation_id=${h.id} and status='queued'`
      )[0]?.count,
    ).toBe(1);
    const [installation] =
      await db.owner`select settings,settings_revision,generation,grant_generation from extension_installations where id=${h.id}`;
    const changed = await h.app.request(`/v1/extensions/${h.id}/settings`, {
      key: h.keys.admin,
      method: 'PATCH',
      body: {
        expectedRevision: installation?.settings_revision,
        settings: { ...installation?.settings, backfillDays: 2 },
      },
    });
    expect(changed.status).toBe(200);
    // Settings update in place: the connection stays on and re-runs setup at the
    // new generation, like an upgrade, instead of being disabled.
    expect(changed.body).toMatchObject({
      state: 'upgrading',
      generation: (installation?.generation ?? 0) + 1,
      grantGeneration: installation?.grant_generation,
    });
    expect(
      (
        await db.owner`select count(*)::int as count from extension_jobs where installation_id=${h.id}
          and status in ('queued','running') and trigger_kind<>'install'`
      )[0]?.count,
    ).toBe(0);
    expect(
      (await h.app.request(`/v1/extensions/${h.id}/source-sync`, { key: h.keys.admin })).body
        .lastSuccessfulScanAt,
    ).toBeNull();
    expect(
      (await h.app.request(`/v1/extensions/${h.id}/enable`, { key: h.keys.admin, body: {} }))
        .status,
    ).toBe(200);
    expect((await h.drain()).every((r) => r.status === 'succeeded')).toBe(true);
    expect(
      (
        await db.owner`select count(*)::int as count from source_revisions where workspace_id=${h.workspace.id}`
      )[0]?.count,
    ).toBe(0);
    expect(
      (
        await db.owner`select state,external_id from source_items where workspace_id=${h.workspace.id}`
      )[0],
    ).toMatchObject({ state: 'erased', external_id: null });
  });
});
