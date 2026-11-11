#!/usr/bin/env node
// A real Compose/API/Postgres/worker/launcher/runner scenario. Only this project's resources are removed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { RetainerClient } from '../packages/sdk/dist/index.js';

const withWebhook = process.argv.includes('--webhook'),
  withLastContact = process.argv.includes('--last-contact'),
  withFiles = process.argv.includes('--files');
assert(!(withWebhook && withLastContact));
assert(!withFiles || withWebhook);
const fixture = withWebhook ? 'webhook-fixture' : withLastContact ? 'last-contact' : 'fixture';
const exec = promisify(execFile),
  root = process.cwd(),
  project = `retainer-extension-compose-${randomUUID().slice(0, 8)}`;
const temp = mkdtempSync(resolve(tmpdir(), 'retainer-extension-compose-'));
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
};
const port = await freePort(),
  pgPort = await freePort(),
  filePort = await freePort(),
  origin = `http://127.0.0.1:${port}`;
const catalog = JSON.parse(readFileSync(`artifacts/extensions/${fixture}/catalog.json`));
const executables = JSON.parse(readFileSync(`artifacts/extensions/${fixture}/executables.json`));
const metadata = JSON.parse(readFileSync(`artifacts/extensions/${fixture}/metadata.json`));
const runner = JSON.parse(
  (
    await exec(
      'docker',
      [
        'image',
        'inspect',
        withWebhook
          ? 'retainer:extension-webhook-fixture'
          : withLastContact
            ? 'retainer:extension-last-contact'
            : 'retainer:extension-runner-fixture',
      ],
      {
        encoding: 'utf8',
      },
    )
  ).stdout,
)[0];
assert.equal(
  runner.Config.Labels['retainer.extension.release'],
  metadata.releaseDigest,
  'build the fixture runner using the generated release digest first',
);
const keypair = generateKeyPairSync('ed25519');
const dockerHost = (
  await exec('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
    encoding: 'utf8',
  })
).stdout.trim();
assert(dockerHost.startsWith('unix://'));
const environment = {
  ...process.env,
  RETAINER_PUBLIC_ORIGIN: origin,
  RETAINER_EXTENSION_ISSUER: origin,
  RETAINER_SUPPRESSION_KEY: randomBytes(32).toString('hex'),
  RETAINER_LAUNCHER_TOKEN: randomBytes(32).toString('hex'),
  RETAINER_EXTENSION_SECRET_KEYS: withWebhook
    ? JSON.stringify({
        currentVersion: 'fixture',
        keys: { fixture: randomBytes(32).toString('base64') },
      })
    : '',
  RETAINER_EXTENSION_VERIFIER_ORIGIN: withWebhook ? 'http://extension-launcher:9000' : '',
  RETAINER_VERIFIER_TOKEN: withWebhook ? randomBytes(32).toString('hex') : '',
  ...(withFiles
    ? {
        RETAINER_FILE_PUBLIC_ORIGIN: `http://127.0.0.1:${filePort}`,
        RETAINER_FILE_SIGNING_KEY: randomBytes(32).toString('base64'),
      }
    : {}),
  RETAINER_SUPPRESSION_PREVIOUS_KEYS: '',
  RETAINER_EXTENSION_CATALOG: JSON.stringify(catalog),
  RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(executables),
  RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(keypair.publicKey.export({ format: 'jwk' })),
  RETAINER_EXTENSION_RUN_PRIVATE_KEY: JSON.stringify(keypair.privateKey.export({ format: 'jwk' })),
  RETAINER_EXTENSION_BUNDLES: JSON.stringify([
    {
      id: fixture,
      image: runner.Id,
      releaseDigest: metadata.releaseDigest,
      functionIds: metadata.functionIds,
      verifierFunctionIds: metadata.verifierFunctionIds ?? [],
    },
  ]),
  RETAINER_DOCKER_SOCKET: dockerHost.slice('unix://'.length),
  RETAINER_EXECUTION_API_CONTAINER: `${project}-api`,
  RETAINER_EXECUTION_PROXY_CONTAINER: `${project}-egress`,
  RETAINER_EXECUTION_NETWORK_PREFIX: `${project}-run`,
};
const override = resolve(temp, 'ports.yml');
writeFileSync(
  override,
  `services:\n  postgres:\n    ports: !override ["127.0.0.1:${pgPort}:5432"]\n  retainer:\n    ports: !override ["127.0.0.1:${port}:8787"]\n${withFiles ? `  file-bytes:\n    image: retainer:extensions-review\n    ports: !override ["127.0.0.1:${filePort}:8790"]\n  file-maintenance:\n    image: retainer:extensions-review\n` : ''}`,
  { mode: 0o600 },
);
const base = [
  'compose',
  '-p',
  project,
  '-f',
  resolve(root, 'docker/compose.yml'),
  '-f',
  resolve(root, 'docker/compose.extensions.yml'),
  ...(withFiles
    ? [
        '-f',
        resolve(root, 'docker/compose.files.yml'),
        '-f',
        resolve(root, 'docker/compose.extensions-files.yml'),
      ]
    : []),
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  const configured = JSON.parse(await compose('config', '--format', 'json'));
  for (const name of ['extension-egress', 'extension-launcher', 'extension-executor'])
    assert.deepEqual(configured.services[name].tmpfs, ['/tmp:rw,noexec,nosuid,size=16m']);
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
      'Compose fixture approval',
      '--actor',
      'user:compose-fixture',
      '--scopes',
      'admin',
      '--json',
    ),
  );
  const client = new RetainerClient({ baseUrl: origin, apiKey: credential.key });
  await client.me();
  let contactCompany, contactPerson;
  if (withLastContact) {
    await client.proposeSchemaChange([
      { op: 'update_field', object: 'person', field: 'company', rollUpEvents: true },
    ]);
    contactCompany = (
      await client.createRecord('company', { values: { name: 'Compose last-contact company' } })
    ).id;
    contactPerson = (
      await client.createRecord('person', {
        values: { name: 'Compose contact', company: contactCompany },
      })
    ).id;
    await client.logEvent({
      type: 'conversation',
      title: 'Older contact',
      occurredAt: '2026-01-01T12:00:00.000Z',
      channel: 'last-contact-compose',
      externalId: 'older',
      about: [contactCompany],
    });
    await client.logEvent({
      type: 'conversation',
      title: 'Latest contact',
      occurredAt: '2026-01-02T12:00:00.000Z',
      channel: 'last-contact-compose',
      externalId: 'latest',
      about: [contactPerson],
    });
  }
  const input = {
    registrationId: catalog[0].manifest.universalId,
    version: catalog[0].manifest.version,
    settings: withFiles ? { includeTranscript: true } : {},
  };
  const producerKey = randomBytes(32),
    producerSecret = `whsec_${producerKey.toString('base64')}`;
  if (withWebhook) {
    const staged = await client.stageExtensionSecret({
      registrationId: input.registrationId,
      version: input.version,
      name: 'fixtureKey',
      value: producerSecret,
    });
    input.secretRefs = { fixtureKey: staged.pendingSecretId };
  }
  const preview = await client.previewExtension(input);
  const installed = await client.installExtension(
    { ...input, planDigest: preview.planDigest },
    'compose-install',
  );
  assert.equal(installed.state, 'installing');
  let runs = [];
  for (let attempt = 0; attempt < 600; attempt++) {
    runs = (await client.extensionRuns(installed.id)).runs;
    if (runs.some((run) => run.status === 'failed'))
      throw new Error('isolated lifecycle fixture failed');
    if (runs.filter((run) => run.status === 'succeeded').length >= (withWebhook ? 1 : 2)) break;
    await delay(100);
  }
  assert(
    runs.filter((run) => run.status === 'succeeded').length >= (withWebhook ? 1 : 2),
    'the expected setup and child work must finish',
  );
  assert.equal((await client.extension(installed.id)).state, 'active');
  let callback;
  if (withWebhook) {
    // Operator-side metadata only: signing material remains unreadable to the admin API.
    const bindingId = (
      await compose(
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'retainer',
        '-d',
        'retainer',
        '-Atc',
        `select id from webhook_bindings where installation_id='${installed.id}' and state='active'`,
      )
    ).trim();
    assert.match(bindingId, /^[a-f0-9-]{36}$/);
    callback = `${origin}/extensions/hooks/installations/${bindingId}/notes`;
    const deliver = (signatureBody, body = signatureBody) => {
      const delivery = 'compose-delivery-1',
        stamp = String(Math.floor(Date.now() / 1000));
      return fetch(callback, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': delivery,
          'webhook-timestamp': stamp,
          'webhook-signature': `v1,${createHmac('sha256', producerKey).update(`${delivery}.${stamp}.${signatureBody}`).digest('base64')}`,
        },
        body,
      });
    };
    const body = '{ "externalId": "compose-note-1" }';
    assert.equal((await deliver(body, '{"externalId":"compose-note-1"}')).status, 401);
    const accepted = await Promise.all([deliver(body), deliver(body)]);
    assert.deepEqual(
      accepted.map((response) => response.status),
      [202, 202],
    );
    for (let attempt = 0; attempt < 600; attempt++) {
      runs = (await client.extensionRuns(installed.id)).runs;
      if (runs.some((run) => run.status === 'failed'))
        throw new Error(
          `isolated webhook import failed: ${runs
            .filter((run) => run.status === 'failed')
            .map((run) => `${run.functionId}:${run.code}`)
            .join(', ')}`,
        );
      if (runs.filter((run) => run.status === 'succeeded').length === 2) break;
      await delay(100);
    }
    assert.equal(runs.filter((run) => run.status === 'succeeded').length, 2);
    const notes = await client.queryEvents({ filter: { type: 'conversation' } });
    assert.equal(notes.records.length, 1);
    assert.equal(notes.records[0].event.title, 'Compose webhook note');
    assert.equal(notes.records[0].event.source.current, true);
    if (withFiles) {
      const files = Object.values(notes.records[0].fields)
        .flatMap((value) => (Array.isArray(value) ? value : []))
        .filter((value) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value));
      assert.equal(files.length, 1);
      const file = await client.file(files[0]),
        download = await client.downloadFile(files[0]);
      assert.equal(file.name, 'fixture-transcript.txt');
      const bytes = await fetch(download.url, { headers: download.headers });
      assert.equal(
        await bytes.text(),
        'A deterministic fixture transcript uploaded by an isolated source runner.',
      );
    }
    assert.deepEqual(notes.records[0].createdBy, { type: 'integration', id: installed.id });
    const receiptCount = (
      await compose(
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'retainer',
        '-d',
        'retainer',
        '-Atc',
        `select count(*) from webhook_receipts where binding_id='${bindingId}'`,
      )
    ).trim();
    assert.equal(receiptCount, '1');
    const changes = await client.changes();
    assert(
      changes.changes.some(
        (change) =>
          change.recordId === notes.records[0].id && change.originInstallationId === installed.id,
      ),
    );
    assert(!JSON.stringify(changes).includes('compose-note-1'));
    assert.equal((await client.extension(installed.id)).secrets.signing, true);
    assert(!JSON.stringify(await client.extensionRuns(installed.id)).includes(producerSecret));
    assert(!JSON.stringify(await client.extension(installed.id)).includes(producerSecret));
  } else if (withLastContact) {
    const expectDate = async (recordId, date) => {
      for (let attempt = 0; attempt < 600; attempt++) {
        if ((await client.record(recordId)).fields.lastContactAt === date) return;
        const inspected = await client.extensionRuns(installed.id);
        assert(!inspected.runs.some((run) => run.status === 'failed'), 'last-contact work failed');
        await delay(100);
      }
      assert.equal((await client.record(recordId)).fields.lastContactAt, date);
    };
    await expectDate(contactPerson, '2026-01-02T12:00:00.000Z');
    await expectDate(contactCompany, '2026-01-02T12:00:00.000Z');
    const latest = await client.logEvent({
      type: 'conversation',
      title: 'Post-install contact',
      occurredAt: '2026-01-03T12:00:00.000Z',
      channel: 'last-contact-compose',
      externalId: 'after-install',
      about: [contactPerson],
    });
    await expectDate(contactCompany, '2026-01-03T12:00:00.000Z');
    await client.removeAbout(latest.id, contactPerson);
    await expectDate(contactCompany, '2026-01-02T12:00:00.000Z');
    const changes = await client.changes();
    assert(
      changes.changes.some(
        (change) =>
          change.recordId === contactCompany && change.originInstallationId === installed.id,
      ),
    );
  } else {
    const records = await client.queryRecords('company', {
      filter: { name: 'Compose fixture company' },
    });
    assert.equal(records.records.length, 1);
  }
  await client.disableExtension(installed.id);
  assert.equal((await client.extension(installed.id)).state, 'disabled');
  if (withWebhook)
    assert.equal((await fetch(callback, { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await client.uninstallExtension(installed.id)).state, 'uninstalling');
  for (let attempt = 0; attempt < 300; attempt++) {
    if ((await client.extension(installed.id)).state === 'uninstalled') break;
    await delay(100);
  }
  assert.equal((await client.extension(installed.id)).state, 'uninstalled');
  console.log(
    JSON.stringify({
      status: 'passed',
      database: 'real-postgres',
      approval: true,
      activation: 'public-lifecycle-with-reviewed-fixture',
      execution: 'fresh-isolated-node24',
      crmWrite: true,
      redactedRunInspection: true,
      disable: true,
      uninstall: true,
      ...(withFiles ? { isolatedTranscriptUpload: true, privateByteProxy: true } : {}),
      ...(withLastContact
        ? {
            derivedLastContact: true,
            setupBackfill: true,
            durableChangeDispatch: true,
            oneHopRollup: true,
            decreaseOnUnlink: true,
          }
        : {}),
      ...(withWebhook
        ? {
            webhookRawSignature: true,
            tamperingRejected: true,
            durableDuplicateReceipt: true,
            isolatedSourceImport: true,
            generatedSigningSecret: true,
          }
        : {}),
    }),
  );
} finally {
  await compose('down', '--volumes', '--remove-orphans', '--timeout', '30').catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
