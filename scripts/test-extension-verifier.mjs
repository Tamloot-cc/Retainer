#!/usr/bin/env node
// Disposable real-Docker proof of the verifier's separate no-network execution capability.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { DockerSandbox } from '../packages/server/dist/launcher/docker.js';
import { LauncherVerifier } from '../packages/server/dist/worker/verifier-driver.js';

const exec = promisify(execFile);
const docker = async (...args) =>
  (await exec('docker', args, { maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const metadata = JSON.parse(readFileSync('artifacts/extensions/verifier-fixture/metadata.json'));
const image = JSON.parse(
  await docker('image', 'inspect', 'retainer:extension-verifier-fixture'),
)[0];
assert.equal(image.Config.Labels['retainer.extension.release'], metadata.releaseDigest);
const prefix = `retainer-verifier-test-${randomUUID().slice(0, 8)}`;
const api = `${prefix}-api`,
  proxy = `${prefix}-proxy`;
const engine = await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
assert(engine.startsWith('unix://'));
const sandbox = new DockerSandbox({
  socketPath: engine.slice(7),
  networkPrefix: prefix,
  apiContainer: api,
  proxyContainer: proxy,
  apiOrigin: 'http://fixture-api:8787',
  proxyOrigin: 'http://fixture-proxy:3128',
  bundles: [
    {
      id: metadata.bundleId,
      image: image.Id,
      releaseDigest: metadata.releaseDigest,
      functionIds: [],
      verifierFunctionIds: metadata.verifierFunctionIds,
    },
  ],
});
const key = randomBytes(32),
  stamp = String(Math.floor(Date.now() / 1000));
const body = '{ "externalId": "local-proof" }',
  delivery = 'signed-delivery';
const invocation = () => ({
  protocolVersion: 1,
  kind: 'webhook',
  verificationId: randomUUID(),
  releaseDigest: metadata.releaseDigest,
  functionId: metadata.verifierFunctionIds[0],
  rawBody: Buffer.from(body).toString('base64'),
  headers: {
    'webhook-id': delivery,
    'webhook-timestamp': stamp,
    'webhook-signature': `v1,${createHmac('sha256', key).update(`${delivery}.${stamp}.${body}`).digest('base64')}`,
  },
  secret: `whsec_${key.toString('base64')}`,
  deadline: new Date(Date.now() + 5000).toISOString(),
});
let hanging, launcher;
try {
  for (const name of [api, proxy])
    await docker(
      'run',
      '-d',
      '--name',
      name,
      '--network',
      'none',
      '--entrypoint',
      'node',
      image.Id,
      '-e',
      'setInterval(()=>{},1000)',
    );
  assert.deepEqual(
    await sandbox.verify(metadata.bundleId, invocation(), new AbortController().signal),
    { status: 'verified', deliveryId: delivery, externalId: 'local-proof' },
  );
  assert.deepEqual(
    await sandbox.verify(
      metadata.bundleId,
      { ...invocation(), rawBody: Buffer.from('{"externalId":"local-proof"}').toString('base64') },
      new AbortController().signal,
    ),
    { status: 'rejected' },
  );
  await assert.rejects(
    () =>
      sandbox.run(
        metadata.bundleId,
        {
          protocolVersion: 1,
          runId: randomUUID(),
          attempt: 1,
          installationId: randomUUID(),
          releaseDigest: metadata.releaseDigest,
          functionId: metadata.verifierFunctionIds[0],
          input: {},
          apiOrigin: 'http://fixture-api:8787',
          runToken: 'fixture-only',
          deadline: new Date(Date.now() + 10000).toISOString(),
        },
        new AbortController().signal,
      ),
    /unknown execution bundle/,
  );
  hanging = sandbox.verify(
    metadata.bundleId,
    { ...invocation(), functionId: metadata.verifierFunctionIds[1] },
    new AbortController().signal,
  );
  void hanging.catch(() => {});
  let container;
  for (let n = 0; n < 40 && !container; n++) {
    const ids = (
      await docker('ps', '-q', '--filter', `label=retainer.extension.launcher=${prefix}`)
    )
      .split('\n')
      .filter(Boolean);
    if (ids[0]) container = JSON.parse(await docker('inspect', ids[0]))[0];
    if (!container) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert(container, 'timeout verifier did not become observable');
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.equal(container.Config.User, '65532:65532');
  assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
  assert(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(container.HostConfig.PidsLimit, 64);
  assert.equal(container.HostConfig.Memory, 268435456);
  assert.equal(container.HostConfig.LogConfig.Type, 'none');
  assert(
    !container.Config.Env.some((value) =>
      /TOKEN|SECRET|DATABASE|PROXY|AWS_ACCESS_KEY/.test(value.split('=')[0]),
    ),
  );
  assert(container.Mounts.every((mount) => mount.Type === 'tmpfs' && mount.Destination === '/tmp'));
  const network = await docker(
    'exec',
    container.Id,
    'node',
    '-e',
    'console.log(JSON.stringify(require("node:os").networkInterfaces()))',
  );
  assert.deepEqual(Object.keys(JSON.parse(network)), ['lo']);
  await assert.rejects(hanging);
  hanging = undefined;
  await assert.rejects(() => docker('inspect', container.Id));
  assert.equal(
    await docker('network', 'ls', '-q', '--filter', `label=retainer.extension.launcher=${prefix}`),
    '',
  );
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${address.port}`;
  const runToken = randomBytes(32).toString('hex'),
    verifyToken = randomBytes(32).toString('hex');
  launcher = spawn(process.execPath, ['packages/server/dist/extension-launcher.js'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(address.port),
      RETAINER_LAUNCHER_TOKEN: runToken,
      RETAINER_VERIFIER_TOKEN: verifyToken,
      RETAINER_DOCKER_SOCKET: engine.slice(7),
      RETAINER_EXECUTION_NETWORK_PREFIX: prefix,
      RETAINER_EXECUTION_API_CONTAINER: api,
      RETAINER_EXECUTION_PROXY_CONTAINER: proxy,
      RETAINER_EXECUTION_API_ORIGIN: 'http://fixture-api:8787',
      RETAINER_EXECUTION_PROXY: 'http://fixture-proxy:3128',
      RETAINER_EXTENSION_BUNDLES: JSON.stringify([
        {
          id: metadata.bundleId,
          image: image.Id,
          releaseDigest: metadata.releaseDigest,
          functionIds: [],
          verifierFunctionIds: metadata.verifierFunctionIds,
        },
      ]),
    },
  });
  for (let n = 0; n < 60; n++) {
    try {
      if ((await fetch(`${origin}/health`)).ok) break;
    } catch {}
    if (n === 59) throw new Error('launcher did not start');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const [path, token] of [
    ['/verify', runToken],
    ['/run', verifyToken],
    ['/verify', ''],
  ])
    assert.equal(
      (
        await fetch(`${origin}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
          body: '{}',
        })
      ).status,
      401,
    );
  const executable = JSON.parse(
    readFileSync('artifacts/extensions/verifier-fixture/executables.json'),
  )[0];
  assert.deepEqual(
    await new LauncherVerifier(origin, verifyToken).verify(
      executable,
      invocation(),
      new AbortController().signal,
    ),
    { status: 'verified', deliveryId: delivery, externalId: 'local-proof' },
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      rawByteSignature: true,
      tamperingRejected: true,
      noNetwork: true,
      noCrmCredential: true,
      separateFunctionCapability: true,
      separateBearerCapability: true,
      hardTimeout: true,
      ephemeralCleanup: true,
    }),
  );
} finally {
  if (launcher) {
    const child = launcher;
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const forced = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(forced);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
  await sandbox.stop();
  await hanging?.catch(() => {});
  await docker('rm', '-f', api, proxy).catch(() => {});
}
