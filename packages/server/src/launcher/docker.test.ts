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
