#!/usr/bin/env node
// A routine through real Compose/API/Postgres/worker/launcher/runner (routines
// spec §3.3): the type-check and the run each launch a fresh runner container
// on a network that reaches the API and nothing else, with no egress proxy.
// Only this project's resources are removed.
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
  project = `retainer-routine-compose-${randomUUID().slice(0, 8)}`;
const temp = mkdtempSync(resolve(tmpdir(), 'retainer-routine-compose-'));
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve) => server.close(resolve));
  return address.port;
};
const docker = async (...args) =>
  (await exec('docker', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })).stdout;
const port = await freePort(),
  pgPort = await freePort(),
  origin = `http://127.0.0.1:${port}`;
const executables = JSON.parse(
  readFileSync('artifacts/extensions/routine-runner/executables.json'),
);
const metadata = JSON.parse(readFileSync('artifacts/extensions/routine-runner/metadata.json'));
const runner = JSON.parse(await docker('image', 'inspect', 'retainer:routine-runner'))[0];
assert.equal(
  runner.Config.Labels['retainer.extension.release'],
  metadata.releaseDigest,
  'build the routine runner image using the generated release digest first',
);
const keypair = generateKeyPairSync('ed25519');
const dockerHost = (
  await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
).trim();
assert(dockerHost.startsWith('unix://'));
const environment = {
  ...process.env,
  RETAINER_PUBLIC_ORIGIN: origin,
  RETAINER_EXTENSION_ISSUER: origin,
  RETAINER_SUPPRESSION_KEY: randomBytes(32).toString('hex'),
  RETAINER_SUPPRESSION_PREVIOUS_KEYS: '',
  RETAINER_LAUNCHER_TOKEN: randomBytes(32).toString('hex'),
  RETAINER_EXTENSION_CATALOG: '[]',
  RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(executables),
  RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(keypair.publicKey.export({ format: 'jwk' })),
  RETAINER_EXTENSION_RUN_PRIVATE_KEY: JSON.stringify(keypair.privateKey.export({ format: 'jwk' })),
  RETAINER_EXTENSION_BUNDLES: JSON.stringify([
    {
      id: metadata.bundleId,
      image: runner.Id,
      releaseDigest: metadata.releaseDigest,
      functionIds: metadata.functionIds,
      verifierFunctionIds: [],
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
const key = async (name, actor, scopes) =>
  JSON.parse(
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
      name,
      '--actor',
      actor,
      '--scopes',
      scopes,
      '--json',
    ),
  ).key;
const since = new Date().toISOString();
try {
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120');
  const admin = new RetainerClient({
    baseUrl: origin,
    apiKey: await key('Admin', 'user:compose-admin', 'admin'),
  });
  const agent = new RetainerClient({
    baseUrl: origin,
    apiKey: await key('Builder', 'agent:compose-builder', 'read,write'),
  });
  const starter = await admin.applyTemplate('starter');
  const applied =
    starter.status === 'proposed'
      ? await admin.decideSchemaChange(starter.change.id, 'approve')
      : starter;
  assert.equal(applied.status, 'applied');
  await admin.proposeSchemaChange(
    [
      {
        op: 'create_field',
        object: 'company',
        field: { name: 'tier', label: 'Tier', type: 'text' },
      },
    ],
    'Routine Compose test',
  );
  const company = (await agent.routineCapabilities()).objects.find((o) => o.name === 'company');
  const tier = company.fields.find((f) => f.name === 'tier').key;
  const source = {
    manifest: {
      when: { kind: 'manual', object: 'company', label: 'Make gold' },
      uses: { tools: [], model: false },
    },
    code: `export async function main({ retainer, record }: RoutineContext<'company'>) {
  await retainer.company.update(record.id, { ${JSON.stringify(tier)}: 'gold' });
  return { tiered: record.id };
}
`,
  };
  // The type-check runs in the sandbox: one launch on a closed network.
  let check = await agent.validateRoutine(source, 60);
  for (let attempt = 0; check.valid === null && attempt < 600; attempt++) {
    await delay(100);
    check = await agent.routineJob(check.jobId);
  }
  assert.deepEqual({ valid: check.valid, problems: check.problems }, { valid: true, problems: [] });
  const proposed = await agent.proposeRoutine({
    ...source,
    name: 'Make gold',
    description: 'Mark the company gold.',
    summary: 'Sets the tier to gold.',
    report: { verdict: 'full', gaps: [] },
  });
  await admin.decideRoutineVersion(proposed.routineId, proposed.versionId, 'approve');
  const acme = (await admin.createRecord('company', { values: { name: 'Acme' } })).id;
  const { runs } = await admin.runRoutine(proposed.routineId, [acme]);
  let run;
  for (let attempt = 0; attempt < 600; attempt++) {
    run = await admin.routineRun(proposed.routineId, runs[0]);
    if (!['queued', 'running'].includes(run.status)) break;
    await delay(100);
  }
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  const record = await admin.record(acme);
  assert.equal(record.fields.tier, 'gold');
  // Every run network held the API and the runner, never the egress proxy.
  const api = (await docker('inspect', '-f', '{{.Id}}', `${project}-api`)).trim(),
    egress = (await docker('inspect', '-f', '{{.Id}}', `${project}-egress`)).trim();
  const events = (
    await docker(
      'events',
      '--since',
      since,
      '--until',
      new Date().toISOString(),
      '--filter',
      'type=network',
      '--filter',
      'event=connect',
      '--format',
      '{{json .}}',
    )
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).Actor.Attributes)
    .filter((a) => a.name?.startsWith(`${project}-run-`));
  const networks = new Map();
  for (const a of events) networks.set(a.name, [...(networks.get(a.name) ?? []), a.container]);
  assert(networks.size >= 2, `expected the check and the run, saw ${networks.size} networks`);
  for (const [name, containers] of networks) {
    assert(containers.includes(api), `${name} lacks the API`);
    assert(!containers.includes(egress), `${name} reached the egress proxy`);
    assert.equal(containers.length, 2, `${name} had ${containers.length} containers`);
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      database: 'real-postgres',
      sandboxTypeCheck: true,
      approval: true,
      routineWrite: true,
      closedNetworks: networks.size,
      egressProxyAttached: false,
    }),
  );
} finally {
  await compose('down', '--volumes', '--remove-orphans', '--timeout', '30').catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
