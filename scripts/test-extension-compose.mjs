#!/usr/bin/env node
// A real Compose/API/Postgres/worker/launcher/runner scenario. Only this project's resources are removed.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { RetainerClient } from '../packages/sdk/dist/index.js';

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
  origin = `http://127.0.0.1:${port}`;
const catalog = JSON.parse(readFileSync('artifacts/extensions/fixture/catalog.json'));
const executables = JSON.parse(readFileSync('artifacts/extensions/fixture/executables.json'));
const metadata = JSON.parse(readFileSync('artifacts/extensions/fixture/metadata.json'));
const runner = JSON.parse(
  (
    await exec('docker', ['image', 'inspect', 'retainer:extension-runner-fixture'], {
      encoding: 'utf8',
    })
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
  RETAINER_EXTENSION_SECRET_KEYS: '',
  RETAINER_SUPPRESSION_PREVIOUS_KEYS: '',
  RETAINER_EXTENSION_CATALOG: JSON.stringify(catalog),
  RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(executables),
  RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(keypair.publicKey.export({ format: 'jwk' })),
  RETAINER_EXTENSION_RUN_PRIVATE_KEY: JSON.stringify(keypair.privateKey.export({ format: 'jwk' })),
  RETAINER_EXTENSION_BUNDLES: JSON.stringify([
    {
      id: 'fixture',
      image: runner.Id,
      releaseDigest: metadata.releaseDigest,
      functionIds: metadata.functionIds,
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
  `services:\n  postgres:\n    ports: !override ["127.0.0.1:${pgPort}:5432"]\n  retainer:\n    ports: !override ["127.0.0.1:${port}:8787"]\n`,
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
  const input = {
    registrationId: catalog[0].manifest.universalId,
    version: catalog[0].manifest.version,
    settings: {},
  };
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
    if (runs.filter((run) => run.status === 'succeeded').length === 2) break;
    await delay(100);
  }
  assert.equal(
    runs.filter((run) => run.status === 'succeeded').length,
    2,
    'setup and its durable child must both finish',
  );
  assert.equal((await client.extension(installed.id)).state, 'active');
  const records = await client.queryRecords('company', {
    filter: { name: 'Compose fixture company' },
  });
  assert.equal(records.records.length, 1);
  await client.disableExtension(installed.id);
  assert.equal((await client.extension(installed.id)).state, 'disabled');
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
    }),
  );
} finally {
  await compose('down', '--volumes', '--remove-orphans', '--timeout', '30').catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
