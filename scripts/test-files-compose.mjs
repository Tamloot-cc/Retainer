#!/usr/bin/env node
// Disposable Compose/real-Postgres/real-volume proof. Never prints credentials or edits other projects.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { RetainerClient } from '../packages/sdk/dist/index.js';

const exec = promisify(execFile),
  root = process.cwd(),
  project = `retainer-files-${randomUUID().slice(0, 8)}`,
  temporary = mkdtempSync(resolve(tmpdir(), 'retainer-files-compose-'));
const freePort = async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  assert(a && typeof a !== 'string');
  await new Promise((r) => server.close(r));
  return a.port;
};
const port = await freePort(),
  filePort = await freePort(),
  pgPort = await freePort(),
  origin = `http://127.0.0.1:${port}`;
const environment = {
  ...process.env,
  RETAINER_PUBLIC_ORIGIN: origin,
  RETAINER_FILE_PUBLIC_ORIGIN: `http://127.0.0.1:${filePort}`,
  RETAINER_FILE_SIGNING_KEY: randomBytes(32).toString('base64'),
  RETAINER_SUPPRESSION_KEY: randomBytes(32).toString('hex'),
  RETAINER_SUPPRESSION_PREVIOUS_KEYS: '',
};
const override = resolve(temporary, 'ports.yml');
writeFileSync(
  override,
  `services:\n  postgres:\n    ports: !override ["127.0.0.1:${pgPort}:5432"]\n  retainer:\n    image: retainer:files-review\n    ports: !override ["127.0.0.1:${port}:8787"]\n  file-bytes:\n    ports: !override ["127.0.0.1:${filePort}:8790"]\n`,
  { mode: 0o600 },
);
const base = [
  'compose',
  '-p',
  project,
  '-f',
  resolve(root, 'docker/compose.yml'),
  '-f',
  resolve(root, 'docker/compose.files.yml'),
  '-f',
  override,
];
const compose = async (...args) =>
  (
    await exec('docker', [...base, ...args], {
      cwd: root,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120');
  const credential = JSON.parse(
    await compose(
      'exec',
      '-T',
      'retainer',
      'retainer',
      'key',
      'create',
      '--workspace',
      'default',
      '--name',
      'File fixture',
      '--actor',
      'user:file-fixture',
      '--scopes',
      'admin',
      '--json',
    ),
  );
  const sdk = new RetainerClient({ baseUrl: origin, apiKey: credential.key });
  // API startup has no healthcheck in the base file; retry reads while migrations/bootstrap finish.
  for (let n = 0; n < 100; n++) {
    try {
      await sdk.me();
      break;
    } catch {
      if (n === 99) throw new Error('API did not start');
      await delay(100);
    }
  }
  const bytes = Buffer.from('Compose private transcript fixture'),
    metadata = {
      name: 'transcript.txt',
      mediaType: 'text/plain',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  const intent = await sdk.createFileIntent(metadata, 'compose-file-upload');
  assert.equal(
    (await fetch(intent.upload.url, { method: 'PUT', headers: intent.upload.headers, body: bytes }))
      .status,
    201,
  );
  await sdk.finalizeFile(intent.id);
  const event = await sdk.logEvent({
    type: 'conversation',
    channel: 'fixture',
    externalId: 'compose-files',
    title: 'File fixture',
    occurredAt: '2026-11-11T10:00:00Z',
    fields: { transcript: [intent.id] },
  });
  const transfer = await sdk.downloadFile(intent.id);
  assert.equal(await (await fetch(transfer.url)).text(), bytes.toString());
  const forgotten = await sdk.forget(event.id);
  assert.equal(forgotten.storage?.pending, 1);
  let denied = false;
  try {
    await sdk.downloadFile(intent.id);
  } catch (error) {
    denied = error.status === 404;
  }
  assert(denied, 'new downloads must be revoked before byte erasure');
  const deletionIds = forgotten.storage.deletionIds;
  let pending = 1;
  for (let n = 0; n < 1000; n++) {
    pending = (await sdk.fileErasureStatus(deletionIds)).pending;
    if (!pending) break;
    await delay(100);
  }
  assert.equal(pending, 0, 'the independent storage worker must confirm durable erasure');
  assert(
    [400, 404].includes((await fetch(transfer.url)).status),
    'old download must be expired or refer to erased bytes',
  );
  assert.equal(
    (await fetch(intent.upload.url, { method: 'PUT', headers: intent.upload.headers, body: bytes }))
      .status,
    409,
    'a late signed upload must not recreate erased bytes',
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      database: 'real-postgres',
      storage: 'dedicated-service-and-volume',
      uploadFinalize: true,
      assertionReference: true,
      authorizedDownload: true,
      revocationBeforeDeletion: true,
      scheduledDurableErasure: true,
      lateUploadBlocked: true,
    }),
  );
} finally {
  await compose('down', '--volumes', '--remove-orphans', '--timeout', '30').catch(() => {});
  rmSync(temporary, { recursive: true, force: true });
}
