import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DockerSandbox } from './docker.js';

it('permits a remote HTTPS API through the trusted proxy without attaching a local API container', () => {
  const options = {
    socketPath: '/unused',
    networkPrefix: 'reviewed-execution',
    apiContainer: '',
    apiOrigin: 'https://api.example',
    proxyContainer: 'trusted-proxy',
    proxyOrigin: 'http://proxy:3128',
    bundles: [],
  };
  expect(() => new DockerSandbox(options)).not.toThrow();
  expect(() => new DockerSandbox({ ...options, apiOrigin: 'http://api.example' })).toThrow(
    'requires HTTPS',
  );
  expect(() => new DockerSandbox({ ...options, proxyContainer: '' })).toThrow(
    'fixed API and proxy',
  );
  expect(
    () =>
      new DockerSandbox({ ...options, apiContainer: 'trusted-api', apiOrigin: 'http://api:8787' }),
  ).not.toThrow();
});

it('refuses old Docker engines before declaring isolated execution healthy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'retainer-engine-'));
  const socketPath = join(directory, 'docker.sock');
  let version = '27.5.1';
  const engine = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1.47/version') res.end(JSON.stringify({ Version: version }));
    else if (req.url === '/v1.47/containers/trusted-proxy/json')
      res.end(JSON.stringify({ State: { Running: true } }));
    else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => engine.listen(socketPath, resolve));
  try {
    const sandbox = new DockerSandbox({
      socketPath,
      networkPrefix: 'engine-proof',
      apiContainer: '',
      apiOrigin: 'https://api.example',
      proxyContainer: 'trusted-proxy',
      proxyOrigin: 'http://proxy:3128',
      bundles: [],
    });
    await expect(sandbox.health()).rejects.toThrow('Docker 28 or later');
    version = '28.0.4';
    expect(await sandbox.health()).toEqual({
      status: 'ok',
      protocolVersion: 1,
      runtimeVersion: 'node24',
      bundles: 0,
    });
    version = 'invalid';
    await expect(sandbox.health()).rejects.toThrow('Docker 28 or later');
  } finally {
    engine.closeAllConnections();
    await new Promise<void>((resolve) => engine.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

it('gives verifiers their own slots and reuses a passing health check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'retainer-engine-'));
  const socketPath = join(directory, 'docker.sock');
  let version = '27.5.1',
    versionChecks = 0;
  const held: (() => void)[] = [];
  const engine = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1.47/version') {
      versionChecks++;
      res.end(JSON.stringify({ Version: version }));
    } else if (req.url === '/v1.47/containers/trusted-proxy/json')
      res.end(JSON.stringify({ State: { Running: true } }));
    else if (req.url?.startsWith('/v1.47/images/'))
      res.end(
        JSON.stringify({
          Config: {
            Labels: {
              'retainer.extension.protocol': '1',
              'retainer.extension.runtime': 'node24',
              'retainer.extension.release': 'a'.repeat(64),
              'retainer.extension.bundle': 'proof',
            },
          },
        }),
      );
    else if (req.url === '/v1.47/networks/create')
      // Runs stall here, holding their slots, until the test releases them.
      held.push(() => {
        res.writeHead(500);
        res.end('{}');
      });
    else {
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => engine.listen(socketPath, resolve));
  const runId = '0d6c3c43-4a3f-4f0c-8f0b-3c1b6f9f4a11',
    verifierId = '6b0f1d9e-2a57-4c6f-9f60-0f6f3f8f9a22';
  const sandbox = new DockerSandbox({
    socketPath,
    networkPrefix: 'capacity-proof',
    apiContainer: '',
    apiOrigin: 'https://api.example',
    proxyContainer: 'trusted-proxy',
    proxyOrigin: 'http://proxy:3128',
    bundles: [
      {
        id: 'proof',
        image: `sha256:${'c'.repeat(64)}`,
        releaseDigest: 'a'.repeat(64),
        functionIds: [runId],
        verifierFunctionIds: [verifierId],
      },
    ],
    capacity: { run: 2, verify: 1 },
  });
  const run = () =>
    sandbox.run(
      'proof',
      {
        protocolVersion: 1,
        runId: '7e4b0c55-8a2d-4c1e-9b3f-6d5e4c3b2a10',
        attempt: 1,
        installationId: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
        releaseDigest: 'a'.repeat(64),
        functionId: runId,
        input: {},
        apiOrigin: 'https://api.example',
        runToken: 'rt_run_proof',
        deadline: new Date(Date.now() + 60000).toISOString(),
      },
      new AbortController().signal,
    );
  const verify = () =>
    sandbox.verify(
      'proof',
      {
        protocolVersion: 1,
        kind: 'webhook',
        verificationId: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d',
        releaseDigest: 'a'.repeat(64),
        functionId: verifierId,
        rawBody: '',
        headers: {},
        secret: 'proof',
        deadline: new Date(Date.now() + 4000).toISOString(),
      },
      new AbortController().signal,
    );
  try {
    // A failed check is never reused: the next launch checks again.
    await expect(verify()).rejects.toThrow('Docker 28 or later');
    version = '28.0.4';
    await expect(verify()).rejects.toThrow('Docker operation failed');
    expect(versionChecks).toBe(2);
    const runs = [run(), run()];
    for (let i = 0; i < 100 && held.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(held).toHaveLength(2);
    // Runs are at capacity, yet a verifier still launches, reusing the passing check.
    await expect(run()).rejects.toThrow('launcher capacity unavailable');
    await expect(verify()).rejects.toThrow('Docker operation failed');
    expect(versionChecks).toBe(2);
    for (const release of held) release();
    await Promise.allSettled(runs);
  } finally {
    engine.closeAllConnections();
    await new Promise<void>((resolve) => engine.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
