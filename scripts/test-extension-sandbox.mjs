#!/usr/bin/env node
// Explicit Docker integration test. Every created resource belongs to this invocation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { DockerSandbox } from '../packages/server/dist/launcher/docker.js';

const exec = promisify(execFile);
const docker = async (...args) =>
  (await exec('docker', args, { maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const nonce = randomUUID().slice(0, 8),
  prefix = `retainer-sandbox-test-${nonce}`;
const api = `${prefix}-api`,
  proxy = `${prefix}-proxy`,
  network = `${prefix}-control`;
const runnerImage = process.env.RETAINER_TEST_RUNNER_IMAGE ?? 'retainer:extension-runner-fixture';
const serverImage = process.env.RETAINER_TEST_SERVER_IMAGE ?? 'retainer:extensions-review';
const image = JSON.parse(await docker('image', 'inspect', runnerImage))[0];
const releaseDigest = image.Config.Labels['retainer.extension.release'],
  bundleId = image.Config.Labels['retainer.extension.bundle'];
const functionId = '07c46550-e0f9-4f2e-b469-4a90931f1970';
const engineHost = await docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}');
assert(engineHost.startsWith('unix://'), 'this test needs a local Unix Docker socket');
const sandbox = new DockerSandbox({
  socketPath: engineHost.slice('unix://'.length),
  networkPrefix: prefix,
  apiContainer: api,
  proxyContainer: proxy,
  apiOrigin: 'http://fixture-api:8787',
  proxyOrigin: 'http://extension-egress:3128',
  bundles: [{ id: bundleId, image: image.Id, releaseDigest, functionIds: [functionId] }],
});
const invocation = () => ({
  protocolVersion: 1,
  runId: randomUUID(),
  attempt: 1,
  installationId: randomUUID(),
  releaseDigest,
  functionId,
  input: { sourceId: randomUUID(), name: 'Sandbox fixture' },
  apiOrigin: 'http://fixture-api:8787',
  runToken: 'rt_run_fixture_only',
  deadline: new Date(Date.now() + 30000).toISOString(),
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeRun;
try {
  await docker('network', 'create', network);
  // This is a test HTTP fixture, not CRM authorization evidence (covered by real-Postgres run tests).
  const fixture = `require('node:http').createServer((req,res)=>{req.resume();const send=()=>{res.setHeader('content-type','application/json');res.statusCode=req.url==='/health'?200:201;res.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000001',created:true,fields:{},record:{}}));};if(req.method==='POST')setTimeout(send,8000);else send();}).listen(8787,'0.0.0.0')`;
  await docker(
    'run',
    '-d',
    '--name',
    api,
    '--network',
    network,
    '--entrypoint',
    'node',
    image.Id,
    '-e',
    fixture,
  );
  await docker(
    'run',
    '-d',
    '--name',
    proxy,
    '--network',
    network,
    '-e',
    'RETAINER_EXECUTION_API_ORIGINS=http://fixture-api:8787',
    serverImage,
    'node',
    'dist/egress-proxy.js',
  );
  await sandbox.health();
  await assert.rejects(
    () => sandbox.run('unknown', invocation(), new AbortController().signal),
    /unknown execution bundle/,
  );
  await assert.rejects(
    () =>
      sandbox.run(
        bundleId,
        { ...invocation(), apiOrigin: 'http://169.254.169.254' },
        new AbortController().signal,
      ),
    /differs/,
  );
  activeRun = sandbox.run(bundleId, invocation(), new AbortController().signal);
  void activeRun.catch(() => {});
  let executionNetwork;
  for (let attempt = 0; attempt < 100; attempt++) {
    const names = (await docker('network', 'ls', '--format', '{{.Name}}'))
      .split('\n')
      .filter((name) => name.startsWith(`${prefix}-`) && name !== network);
    for (const name of names) {
      const inspected = JSON.parse(await docker('network', 'inspect', name))[0];
      const runner = Object.entries(inspected.Containers ?? {}).find(([, container]) =>
        container.Name.startsWith('retainer-run-'),
      );
      if (runner) {
        executionNetwork = inspected;
        break;
      }
    }
    if (executionNetwork) break;
    await delay(20);
  }
  assert(executionNetwork, 'execution container did not become observable');
  assert.equal(executionNetwork.Internal, true);
  assert.equal(executionNetwork.EnableIPv6, false);
  assert.equal(executionNetwork.Options['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated');
  assert.equal(
    Object.keys(executionNetwork.Containers).length,
    3,
    'only API, proxy and this run may share the execution network',
  );
  const runner = Object.entries(executionNetwork.Containers).find(([, container]) =>
    container.Name.startsWith('retainer-run-'),
  );
  assert(runner);
  const container = JSON.parse(await docker('container', 'inspect', runner[0]))[0];
  assert.equal(container.Config.User, '65532:65532');
  assert.equal(container.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(container.HostConfig.CapDrop, ['ALL']);
  assert(container.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal(container.HostConfig.Memory, 268435456);
  assert.equal(container.HostConfig.NanoCpus, 1000000000);
  assert.equal(container.HostConfig.PidsLimit, 64);
  assert.equal(container.HostConfig.Privileged, false);
  assert.equal(Object.keys(container.NetworkSettings.Networks).length, 1);
  assert(container.Mounts.every((mount) => mount.Type === 'tmpfs' && mount.Destination === '/tmp'));
  assert(
    !container.Config.Env.some((entry) =>
      /(TOKEN|SECRET|PASSWORD|DATABASE|AWS_ACCESS_KEY)/i.test(entry.split('=')[0]),
    ),
  );
  const probe = `(async()=>{const fs=require('node:fs'),net=require('node:net');const urls=['http://169.254.169.254/latest/meta-data/','http://127.0.0.1:8787/','http://10.0.0.1/','http://retainer-extensions-test:5432/'];const denied=await Promise.all(urls.map(async url=>{try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});return r.status===403;}catch{return true;}}));let readonly=false;try{fs.writeFileSync('/sandbox-write-probe','no');}catch(e){readonly=e.code==='EROFS'||e.code==='EACCES';}const rawBlocked=await new Promise(resolve=>{const s=net.connect({host:'1.1.1.1',port:443});s.setTimeout(1500,()=>{s.destroy();resolve(true);});s.on('connect',()=>{s.destroy();resolve(false);});s.on('error',()=>resolve(true));});const api=await fetch('http://fixture-api:8787/health',{signal:AbortSignal.timeout(1500)});console.log(JSON.stringify({denied,readonly,rawBlocked,api:api.status,noDockerSocket:!fs.existsSync('/var/run/docker.sock')}));})().catch(()=>process.exit(1));`;
  const result = JSON.parse(
    await docker('exec', runner[0], 'node', '--use-env-proxy', '-e', probe),
  );
  assert(result.denied.every(Boolean));
  assert(result.readonly);
  assert(result.rawBlocked);
  assert(result.noDockerSocket);
  assert.equal(result.api, 200);
  assert.deepEqual(await activeRun, { status: 'succeeded' });
  activeRun = undefined;
  await assert.rejects(() => docker('container', 'inspect', runner[0]));
  await assert.rejects(() => docker('network', 'inspect', executionNetwork.Id));
  assert.deepEqual(await sandbox.run(bundleId, invocation(), new AbortController().signal), {
    status: 'succeeded',
  });
  const leftover = (await docker('network', 'ls', '--format', '{{.Name}}'))
    .split('\n')
    .filter((name) => name.startsWith(`${prefix}-`) && name !== network);
  assert.deepEqual(leftover, []);
  console.log(
    JSON.stringify({
      status: 'passed',
      freshExecutions: 2,
      resourceLimits: true,
      privateAndMetadataBlocked: true,
      rawEgressBlocked: true,
      hostMountsAbsent: true,
      ephemeralNetworksRemoved: true,
    }),
  );
} finally {
  await sandbox.stop();
  await activeRun?.catch(() => {});
  await docker('rm', '-f', api, proxy).catch(() => {});
  await docker('network', 'rm', network).catch(() => {});
}
