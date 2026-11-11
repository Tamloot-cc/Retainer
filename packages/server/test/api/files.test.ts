import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import type { FileStorage } from '../../src/file-storage/contract.js';
import { createFileServer, LocalFileStorage } from '../../src/file-storage/local.js';
import { FileMaintenance } from '../../src/worker/files.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';

const db = useTestDatabase(),
  bytes = Buffer.from('private transcript fixture'),
  metadata = {
    name: 'meeting.txt',
    mediaType: 'text/plain',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
let t: TestApp,
  storage: LocalFileStorage,
  server: ReturnType<typeof createFileServer>,
  directory: string,
  maintenance: FileMaintenance;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'retainer-file-api-'));
  const key = randomBytes(32);
  server = createFileServer({ directory, key });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('file service address missing');
  storage = new LocalFileStorage(`http://127.0.0.1:${address.port}`, key);
  t = startTestApp(db, { fileStorage: storage, fileQuota: metadata.bytes * 2 });
  maintenance = new FileMaintenance(t.sql, db.connect({ role: 'retainer_executor' }), storage);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const { workspace, keys } = await t.setupWorkspace(
    { name: `Files ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] },
      agent: { actor: { type: 'agent', id: 'agent' }, scopes: ['read', 'write'] },
    },
  );
  const schema = await t.request('/v1/schema/changes', {
    key: keys.admin,
    body: {
      operations: [
        {
          op: 'create_field',
          object: 'person',
          field: { name: 'attachments', label: 'Attachments', type: 'files' },
        },
      ],
    },
  });
  expect(schema.status).toBe(200);
  return { workspace: workspace.id, key: keys.admin, agent: keys.agent };
}
async function upload(key: string, receipt = randomUUID()) {
  const response = await t.request('/v1/files/intents', {
    key,
    body: metadata,
    headers: { 'Idempotency-Key': receipt },
  });
  expect(response.status).toBe(201);
  const { id, upload } = response.body;
  expect(
    (await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes })).status,
  ).toBe(201);
  const finalized = await t.request(`/v1/files/${id}/finalize`, { key, method: 'POST' });
  expect(finalized.status).toBe(200);
  return { id, upload };
}
describe('authorized immutable files with real Postgres and real byte service', () => {
  it('requires finalized ownership, attaches assertion history, authorizes downloads and isolates workspaces', async () => {
    const a = await setup(),
      b = await setup();
    const intent = await t.request('/v1/files/intents', {
      key: a.key,
      body: metadata,
      headers: { 'Idempotency-Key': 'pending' },
    });
    expect(
      (
        await t.request('/v1/objects/person/records', {
          key: a.key,
          body: { values: { name: 'Pending', attachments: [intent.body.id] } },
        })
      ).body.error.code,
    ).toBe('invalid_files');
    const file = await upload(a.key);
    expect(
      (await t.request(`/v1/files/${file.id}/download`, { key: a.key, method: 'POST' })).status,
    ).toBe(404);
    expect(
      (await t.request(`/v1/files/${file.id}/finalize`, { key: a.agent, method: 'POST' })).status,
    ).toBe(404);
    const record = await t.request('/v1/objects/person/records', {
      key: a.key,
      body: { values: { name: 'Attached', attachments: [file.id] } },
    });
    expect(record.status).toBe(201);
    const download = await t.request(`/v1/files/${file.id}/download`, {
      key: a.key,
      method: 'POST',
    });
    expect(download.status).toBe(200);
    expect(await (await fetch(download.body.url)).text()).toBe(bytes.toString());
    expect((await t.request(`/v1/files/${file.id}`, { key: b.key })).status).toBe(404);
    expect(
      (
        await t.request('/v1/objects/person/records', {
          key: b.key,
          body: { values: { name: 'Cross tenant', attachments: [file.id] } },
        })
      ).body.error.code,
    ).toBe('invalid_files');
    // Clearing the current field preserves the historical assertion and its storage reference.
    await t.request(`/v1/records/${record.body.record.id}`, {
      key: a.key,
      method: 'PATCH',
      body: { values: { attachments: [] } },
    });
    await db.owner`update files set expires_at=clock_timestamp()-interval '1 hour' where id=${file.id}`;
    await maintenance.tick();
    expect((await t.request(`/v1/files/${file.id}`, { key: a.key })).status).toBe(200);
  });
  it('serializes quota reservation and durable retries instead of overcommitting storage', async () => {
    const { key } = await setup();
    const responses = await Promise.all(
      [1, 2, 3].map((n) =>
        t.request('/v1/files/intents', {
          key,
          body: metadata,
          headers: { 'Idempotency-Key': `quota-${n}` },
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 429]);
    const accepted = responses.find((r) => r.status === 201);
    if (!accepted) throw new Error('quota accepted no upload');
    const retry = await t.request('/v1/files/intents', {
      key,
      body: metadata,
      headers: { 'Idempotency-Key': `quota-${responses.indexOf(accepted) + 1}` },
    });
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(accepted?.body.id);
  });
  it('forget revokes all shared copies and historical references before durable byte erasure', async () => {
    const { key } = await setup(),
      file = await upload(key);
    const people = [];
    for (const name of ['Forget me', 'Shared copy'])
      people.push(
        (
          await t.request('/v1/objects/person/records', {
            key,
            body: { values: { name, attachments: [file.id] } },
          })
        ).body.record.id as string,
      );
    const oldDownload = await t.request(`/v1/files/${file.id}/download`, { key, method: 'POST' });
    const erased = await t.request(`/v1/records/${people[0]}/forget`, { key, method: 'POST' });
    expect(erased.status).toBe(200);
    expect(erased.body.storage.pending).toBe(1);
    expect(
      (
        await t.request('/v1/files/erasure-status', {
          key,
          body: { ids: erased.body.storage.deletionIds },
        })
      ).body.pending,
    ).toBe(1);
    expect((await t.request(`/v1/files/${file.id}/download`, { key, method: 'POST' })).status).toBe(
      404,
    );
    const remaining = await t.request(`/v1/records/${people[1]}`, { key });
    expect(remaining.body.fields.attachments).toEqual([]);
    const [row] = await db.owner`select metadata,state from files where id=${file.id}`;
    expect(row).toEqual({ metadata: {}, state: 'erasing' });
    expect((await maintenance.tick()).erased).toBeGreaterThanOrEqual(1);
    expect(
      (
        await t.request('/v1/files/erasure-status', {
          key,
          body: { ids: erased.body.storage.deletionIds },
        })
      ).body.pending,
    ).toBe(0);
    expect((await fetch(oldDownload.body.url)).status).toBe(404);
    expect(
      (await fetch(file.upload.url, { method: 'PUT', headers: file.upload.headers, body: bytes }))
        .status,
    ).toBe(409);
  });
  it('binds upload ownership to live installation credentials and fences finalization after revocation', async () => {
    const manifests = [0, 1].map(() =>
      extensionFixture({
        scopes: ['read', 'write'],
        functions: [
          {
            universalId: randomUUID(),
            name: 'job',
            description: 'File fixture',
            handlerDigest: 'b'.repeat(64),
            timeoutSeconds: 120,
            trigger: { kind: 'job' },
            inputSchema: { type: 'object', additionalProperties: false },
          },
        ],
      }),
    );
    const catalog = new ExtensionCatalog(
      manifests.map((manifest) => ({
        manifest,
        actorCeiling: 'integration' as const,
        runtimeEnabled: true,
      })),
    );
    const keys = await generateKeyPair('EdDSA'),
      tokens = new RunTokens({
        issuer: 'https://retainer.test',
        keyId: 'files',
        signingKey: keys.privateKey,
        verificationKey: keys.publicKey,
      });
    const app = startTestApp(db, {
      fileStorage: storage,
      extensionCatalog: catalog,
      extensionActivation: new Set(catalog.list().map((r) => r.digest)),
      runTokens: tokens,
    });
    const { workspace, keys: credentials } = await app.setupWorkspace(
      { name: 'Installation file boundaries' },
      { admin: { actor: { type: 'user', id: 'admin' }, scopes: ['admin'] } },
    );
    const queue = new ExtensionQueue(app.sql, catalog.runtime);
    const runs: { id: string; token: string }[] = [];
    for (const manifest of manifests) {
      const input = {
        registrationId: manifest.universalId,
        version: manifest.version,
        settings: {},
      };
      const plan = await app.request('/v1/extensions/preview', {
        key: credentials.admin,
        body: input,
      });
      const install = await app.request('/v1/extensions', {
        key: credentials.admin,
        body: { ...input, planDigest: plan.body.planDigest },
        headers: { 'Idempotency-Key': manifest.universalId },
      });
      expect(install.status).toBe(201);
      const [setup] =
        await db.owner`select id from extension_jobs where installation_id=${install.body.id} and trigger_kind='install'`;
      const lease = await queue.claim(workspace.id, setup?.id, 'setup');
      if (!lease) throw new Error('setup missing');
      await queue.complete(lease, { status: 'succeeded' });
      const fn = manifest.functions[0];
      if (!fn) throw new Error('function missing');
      const job = await queue.enqueue(workspace.id, install.body.id, {
        functionId: fn.universalId,
        input: {},
        dedupeKey: 'files',
      });
      const run = await queue.claim(workspace.id, job.id, 'file-worker');
      if (!run) throw new Error('run missing');
      runs.push({
        id: install.body.id,
        token: await tokens.issue(app.sql, run, manifest.universalId, run.scopes),
      });
    }
    const [first, second] = runs;
    if (!first || !second) throw new Error('file runs missing');
    const intent = await app.request('/v1/files/intents', {
      key: first.token,
      body: metadata,
      headers: { 'Idempotency-Key': 'run-file' },
    });
    expect(intent.status).toBe(201);
    expect(
      (
        await fetch(intent.body.upload.url, {
          method: 'PUT',
          headers: intent.body.upload.headers,
          body: bytes,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(`/v1/files/${intent.body.id}/finalize`, {
          key: second.token,
          method: 'POST',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/v1/files/${intent.body.id}/finalize`, {
          key: first.token,
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    const event = {
      type: 'conversation',
      title: 'Owned file',
      occurredAt: '2026-11-11T10:00:00Z',
      channel: 'fixture',
      fields: { transcript: [intent.body.id] },
    };
    expect((await app.request('/v1/events', { key: second.token, body: event })).status).toBe(403);
    expect((await app.request('/v1/events', { key: first.token, body: event })).status).toBe(201);
    await app.request(`/v1/extensions/${first.id}/disable`, {
      key: credentials.admin,
      method: 'POST',
    });
    expect(
      (
        await app.request(`/v1/files/${intent.body.id}/finalize`, {
          key: first.token,
          method: 'POST',
        })
      ).status,
    ).toBe(409);
    await app.request(`/v1/extensions/${second.id}/disable`, {
      key: credentials.admin,
      method: 'POST',
    });
  });
  it('provides the same upload/finalize/authorized download contract over MCP without accepting bytes or a workspace selector', async () => {
    const { key, agent } = await setup(),
      client = await t.mcpClient(key),
      reader = await t.mcpClient(agent);
    try {
      const result = await client.call('create_file_upload', {
        ...metadata,
        idempotencyKey: 'mcp-upload',
      });
      expect(result.isError).toBe(false);
      const { id, upload } = result.body;
      expect(
        (await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: bytes })).status,
      ).toBe(201);
      expect((await client.call('finalize_file', { id })).body.state).toBe('ready');
      expect((await client.call('download_file', { id })).isError).toBe(true);
      await t.request('/v1/objects/person/records', {
        key,
        body: { values: { name: 'MCP attachment', attachments: [id] } },
      });
      expect((await reader.call('get_file', { id })).body.name).toBe('meeting.txt');
      const download = await reader.call('download_file', { id });
      expect(download.isError).toBe(false);
      expect(await (await fetch(download.body.url)).text()).toBe(bytes.toString());
      expect(
        (
          await client.call('create_file_upload', {
            ...metadata,
            idempotencyKey: 'bytes',
            bytes: Buffer.from('do not accept bytes'),
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await reader.close();
    }
  });
  it('preserves historical file ownership and authorization across record merge', async () => {
    const { key } = await setup(),
      file = await upload(key);
    const source = (
      await t.request('/v1/objects/person/records', {
        key,
        body: { values: { name: 'Merged file source', attachments: [file.id] } },
      })
    ).body.record.id;
    const target = (
      await t.request('/v1/objects/person/records', { key, body: { values: { name: 'Survivor' } } })
    ).body.record.id;
    expect(
      (await t.request(`/v1/records/${target}/merge`, { key, body: { recordId: source } })).status,
    ).toBe(200);
    expect((await t.request(`/v1/files/${file.id}`, { key })).status).toBe(200);
    // Hard removal of the already merged row must not remove surviving assertion references.
    await db.owner`delete from records where id=${source}`;
    await db.owner`update files set expires_at=clock_timestamp()-interval '1 hour' where id=${file.id}`;
    await maintenance.tick();
    expect((await t.request(`/v1/files/${file.id}/download`, { key, method: 'POST' })).status).toBe(
      200,
    );
  });
  it('serializes attachment against orphan collection and never references erased bytes', async () => {
    const { key } = await setup(),
      file = await upload(key);
    await db.owner`update files set expires_at=clock_timestamp()-interval '1 hour' where id=${file.id}`;
    const [write] = await Promise.all([
      t.request('/v1/objects/person/records', {
        key,
        body: { values: { name: 'Racing attachment', attachments: [file.id] } },
      }),
      maintenance.tick(),
    ]);
    const metadataResponse = await t.request(`/v1/files/${file.id}`, { key });
    if (write.status === 201) expect(metadataResponse.status).toBe(200);
    else {
      expect(write.body.error.code).toBe('invalid_files');
      expect(metadataResponse.status).toBe(404);
    }
  });
  it('keeps unavailable storage visibly pending, bounds a pass, and retries without exposing provider errors', async () => {
    const { key } = await setup(),
      file = await upload(key);
    const record = (
      await t.request('/v1/objects/person/records', {
        key,
        body: { values: { name: 'Pending storage', attachments: [file.id] } },
      })
    ).body.record.id;
    const erased = await t.request(`/v1/records/${record}/forget`, { key, method: 'POST' });
    const unavailable: FileStorage = {
      id: storage.id,
      upload: storage.upload.bind(storage),
      head: storage.head.bind(storage),
      download: storage.download.bind(storage),
      erase: async (_key, signal) =>
        new Promise((_resolve, reject) => {
          if (!signal || signal.aborted) {
            reject(new Error('sensitive provider body'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('sensitive provider body')), {
            once: true,
          });
        }),
    };
    const worker = new FileMaintenance(
      t.sql,
      db.connect({ role: 'retainer_executor' }),
      unavailable,
    );
    expect(await worker.tick({ budgetMs: 100 })).toEqual({ erased: 0, failed: 1 });
    const pending = await t.request('/v1/files/erasure-status', {
      key,
      body: { ids: erased.body.storage.deletionIds },
    });
    expect(pending.body.pending).toBe(1);
    expect(JSON.stringify(pending.body)).not.toContain('sensitive provider');
    expect(pending.body.jobs[0].code).toBe('storage_erasure_unavailable');
    await db.owner`update file_deletions set available_at=clock_timestamp() where id=any(${erased.body.storage.deletionIds}::uuid[])`;
    await maintenance.tick();
    expect(
      (
        await t.request('/v1/files/erasure-status', {
          key,
          body: { ids: erased.body.storage.deletionIds },
        })
      ).body.pending,
    ).toBe(0);
  });
  it('claims an erasure once across competing workers without holding a DB transaction over storage I/O', async () => {
    const { key } = await setup(),
      file = await upload(key);
    const record = (
      await t.request('/v1/objects/person/records', {
        key,
        body: { values: { name: 'Competing storage', attachments: [file.id] } },
      })
    ).body.record.id;
    await t.request(`/v1/records/${record}/forget`, { key, method: 'POST' });
    let release = () => {},
      entered = () => {},
      calls = 0;
    const paused = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const provider: FileStorage = {
      id: storage.id,
      upload: storage.upload.bind(storage),
      head: storage.head.bind(storage),
      download: storage.download.bind(storage),
      erase: async (objectKey, signal) => {
        calls++;
        entered();
        await paused;
        await storage.erase(objectKey, signal);
      },
    };
    const a = new FileMaintenance(t.sql, db.connect({ role: 'retainer_executor' }), provider),
      b = new FileMaintenance(t.sql, db.connect({ role: 'retainer_executor' }), provider);
    const first = a.tick();
    await started;
    try {
      expect(await b.tick()).toEqual({ erased: 0, failed: 0 });
      expect(calls).toBe(1);
    } finally {
      release();
    }
    expect(await first).toEqual({ erased: 1, failed: 0 });
  });
  it('persists erasure obligations across a hard workspace cascade', async () => {
    const { workspace, key } = await setup();
    await upload(key);
    await db.owner`delete from workspaces where id=${workspace}`;
    const jobs =
      await db.owner`select object_key,status from file_deletions where workspace_id=${workspace}`;
    expect(jobs).toHaveLength(1);
    expect((await maintenance.tick()).erased).toBeGreaterThanOrEqual(1);
    expect(await storage.head(jobs[0]?.object_key)).toBeNull();
  });
});
