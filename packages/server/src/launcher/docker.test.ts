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
