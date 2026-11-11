#!/usr/bin/env node
// Release-owned first-party fixture metadata. Never consumes workspace input.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineExtension } from '../packages/extension/dist/index.js';
import { stableJson } from '../packages/server/dist/stable-json.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const development = process.argv.includes('--development');
const commit = git('rev-parse', 'HEAD'),
  branch = git('branch', '--show-current');
if (!development && (branch !== 'main' || git('status', '--porcelain')))
  throw new Error(
    'production extension artifacts require a clean main checkout; use --development only for local fixtures',
  );
const hash = (value) => createHash('sha256').update(value).digest('hex');
const files = [];
const walk = (path) => {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = resolve(path, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push([relative(root, full), hash(readFileSync(full))]);
  }
};
for (const pkg of ['shared', 'extension', 'sdk', 'runner']) {
  walk(resolve(root, 'packages', pkg, 'dist'));
  const path = `packages/${pkg}/package.json`;
  files.push([path, hash(readFileSync(resolve(root, path)))]);
}
files.push(['pnpm-lock.yaml', hash(readFileSync(resolve(root, 'pnpm-lock.yaml')))]);
const packageDigest = hash(stableJson(files.sort(([a], [b]) => a.localeCompare(b))));
const handlerDigest = hash(readFileSync(resolve(root, 'packages/runner/dist/registry.js')));
const functionId = '07c46550-e0f9-4f2e-b469-4a90931f1970';
const installId = 'c6b8b3eb-f68b-48af-b96f-a71352c2b2e6';
const manifest = defineExtension({
  manifestVersion: 1,
  universalId: 'e0548bb1-47fd-4de8-8edc-759e26a61e36',
  name: 'fixture',
  version: '1.0.0',
  description: 'Deterministic first-party adapter for execution verification.',
  packageDigest,
  serverVersions: [JSON.parse(readFileSync(resolve(root, 'packages/server/package.json'))).version],
  runtimeVersion: 'node24',
  execution: 'hosted',
  protocolVersion: 1,
  requestedActor: 'integration',
  scopes: ['read', 'write'],
  connection: 'workspace',
  createPeople: 'never',
  onSourceDelete: 'keep',
  settings: {},
  schema: [],
  views: [],
  functions: [
    {
      universalId: installId,
      name: 'setup',
      description: 'Queue the deterministic fixture job.',
      handlerDigest,
      timeoutSeconds: 120,
      trigger: { kind: 'install' },
      inputSchema: { type: 'object', additionalProperties: false },
    },
    {
      universalId: functionId,
      name: 'create-company',
      description: 'Create one fixture company through the scoped public API.',
      handlerDigest,
      timeoutSeconds: 120,
      trigger: { kind: 'job' },
      inputSchema: {
        type: 'object',
        properties: {
          sourceId: { type: 'string', maxLength: 100 },
          name: { type: 'string', maxLength: 200 },
        },
        required: ['sourceId', 'name'],
        additionalProperties: false,
      },
    },
  ],
});
const releaseDigest = hash(stableJson(manifest)),
  out = resolve(root, 'artifacts/extensions/fixture');
mkdirSync(out, { recursive: true });
const write = (name, value) =>
  writeFileSync(resolve(out, name), `${JSON.stringify(value, null, 2)}\n`);
write('manifest.json', manifest);
write('catalog.json', [{ manifest, actorCeiling: 'integration', runtimeEnabled: true }]);
write(
  'executables.json',
  [functionId, installId].map((id) => ({
    registrationId: manifest.universalId,
    releaseDigest,
    functionId: id,
    handlerDigest,
    packageDigest,
    runtimeVersion: 'node24',
    driverTarget: 'fixture',
  })),
);
write('metadata.json', {
  commit,
  development,
  releaseDigest,
  handlerDigest,
  packageDigest,
  bundleId: 'fixture',
  functionIds: [functionId, installId],
});
console.log(
  JSON.stringify({ artifactDirectory: relative(root, out), commit, development, releaseDigest }),
);

if (development) {
  // An inert catalog entry for testing the separate no-network verifier capability.
  const verifierIds = [
    'fb7bdabc-490a-412b-8687-72f2f6f30ba9',
    '33bb3e43-557d-45ed-8f81-5baf6ee0f66d',
  ];
  const verifierHandlerDigest = hash(
    readFileSync(resolve(root, 'packages/runner/dist/webhooks.js')),
  );
  const verifierManifest = defineExtension({
    ...manifest,
    universalId: '90ce88f0-cb67-48c7-9dc3-97775cfae1f1',
    name: 'verifier-fixture',
    description: 'Inert raw-byte signature and hard-timeout verification fixture.',
    functions: verifierIds.map((id, i) => ({
      universalId: id,
      name: i ? 'timeout' : 'verify',
      description: i ? 'Prove host-enforced timeout.' : 'Verify a signed source ID only.',
      handlerDigest: verifierHandlerDigest,
      timeoutSeconds: 5,
      trigger: { kind: 'route', route: i ? 'timeout' : 'verify' },
      inputSchema: { type: 'object', additionalProperties: false },
    })),
  });
  const verifierDigest = hash(stableJson(verifierManifest));
  const verifierOut = resolve(root, 'artifacts/extensions/verifier-fixture');
  mkdirSync(verifierOut, { recursive: true });
  const writeVerifier = (name, value) =>
    writeFileSync(resolve(verifierOut, name), `${JSON.stringify(value, null, 2)}\n`);
  writeVerifier('manifest.json', verifierManifest);
  writeVerifier('catalog.json', [
    { manifest: verifierManifest, actorCeiling: 'integration', runtimeEnabled: false },
  ]);
  writeVerifier('metadata.json', {
    commit,
    development,
    releaseDigest: verifierDigest,
    packageDigest,
    handlerDigest: verifierHandlerDigest,
    bundleId: 'verifier-fixture',
    functionIds: [],
    verifierFunctionIds: verifierIds,
  });
  writeVerifier(
    'executables.json',
    verifierIds.map((functionId) => ({
      registrationId: verifierManifest.universalId,
      releaseDigest: verifierDigest,
      functionId,
      handlerDigest: verifierHandlerDigest,
      packageDigest,
      runtimeVersion: 'node24',
      driverTarget: 'verifier-fixture',
    })),
  );
}
