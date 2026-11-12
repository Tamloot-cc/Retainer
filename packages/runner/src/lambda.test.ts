import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { handle } from './handle.js';
import { handler } from './lambda.js';
import { FIXTURE_INSTALL_ID } from './registry.js';
import { FIXTURE_WEBHOOK_ID } from './webhooks.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));
const nodeVersion = process.versions.node;
beforeAll(() =>
  Object.defineProperty(process.versions, 'node', { value: '24.0.0', configurable: true }),
);
afterAll(() =>
  Object.defineProperty(process.versions, 'node', { value: nodeVersion, configurable: true }),
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const digest = 'a'.repeat(64);
const job = () => ({
  protocolVersion: 1,
  runId: randomUUID(),
  attempt: 1,
  installationId: randomUUID(),
  releaseDigest: digest,
  functionId: FIXTURE_INSTALL_ID,
  input: {},
  apiOrigin: 'https://retainer.test',
  runToken: 'rt_run_test',
  deadline: new Date(Date.now() + 30000).toISOString(),
});
const webhook = () => ({
  protocolVersion: 1,
  kind: 'webhook',
  verificationId: randomUUID(),
  releaseDigest: digest,
  functionId: FIXTURE_WEBHOOK_ID,
  rawBody: '',
  headers: {},
  secret: 'secret',
  deadline: new Date(Date.now() + 4000).toISOString(),
});

test('health uses release.json beside dist, with the Compose environment taking precedence', async () => {
  vi.stubEnv('RETAINER_BUNDLED_RELEASE_DIGEST', '');
  vi.stubEnv('RETAINER_RUNNER_MODE', 'job');
  vi.mocked(readFile).mockResolvedValue(
    JSON.stringify({
      releaseDigest: digest,
      bundleId: 'fixture',
      protocolVersion: 1,
      runtimeVersion: 'node24',
    }),
  );
  expect(await handler({ kind: 'health' })).toEqual({
    protocolVersion: 1,
    runtimeVersion: 'node24',
    releaseDigest: digest,
    mode: 'job',
  });
  expect(String(vi.mocked(readFile).mock.calls.at(-1)?.[0])).toMatch(/runner\/release.json$/);
  vi.stubEnv('RETAINER_BUNDLED_RELEASE_DIGEST', 'b'.repeat(64));
  vi.stubEnv('RETAINER_RUNNER_MODE', 'verify');
  expect(await handler({ kind: 'health' })).toMatchObject({
    releaseDigest: 'b'.repeat(64),
    mode: 'verify',
  });
  expect(await handler(job())).toEqual({ status: 'failed', code: 'invalid_invocation' });
  vi.stubEnv('RETAINER_RUNNER_MODE', 'job');
  expect(await handler(job())).toEqual({ status: 'failed', code: 'incompatible_runtime' });
  vi.stubEnv('RETAINER_BUNDLED_RELEASE_DIGEST', '');
  vi.mocked(readFile).mockRejectedValue(new Error('missing'));
  expect(await handler({ kind: 'health' })).toEqual({
    status: 'failed',
    code: 'incompatible_runtime',
  });
});

test('fixes each Lambda role, rejects invalid mode, runtime, deadlines and malformed inputs', async () => {
  vi.stubEnv('RETAINER_BUNDLED_RELEASE_DIGEST', digest);
  vi.stubEnv('RETAINER_RUNNER_MODE', 'job');
  expect(await handler(webhook())).toEqual({ status: 'failed', code: 'invalid_invocation' });
  vi.stubEnv('RETAINER_RUNNER_MODE', 'verify');
  expect(await handler(job())).toEqual({ status: 'failed', code: 'invalid_invocation' });
  expect(await handler(webhook())).toEqual({ status: 'rejected' });
  expect(await handle(JSON.stringify(webhook()), 'both')).toEqual({ status: 'rejected' });
  expect(await handle('{', 'both')).toEqual({ status: 'failed', code: 'invalid_invocation' });
  expect(await handle(' '.repeat(524289), 'both')).toEqual({
    status: 'failed',
    code: 'invalid_invocation',
  });
  for (const offset of [-1, 6000])
    expect(
      await handler({ ...webhook(), deadline: new Date(Date.now() + offset).toISOString() }),
    ).toEqual({ status: 'failed', code: 'invalid_deadline' });
  vi.stubEnv('RETAINER_RUNNER_MODE', 'both');
  expect(await handler({ kind: 'health' })).toEqual({
    status: 'failed',
    code: 'invalid_invocation',
  });
  Object.defineProperty(process.versions, 'node', { value: '26.0.0', configurable: true });
  expect(await handle('{}', 'job')).toEqual({ status: 'failed', code: 'incompatible_runtime' });
  Object.defineProperty(process.versions, 'node', { value: '24.0.0', configurable: true });
});

test('reuses one warm environment without carrying installation, credentials, KV or files to the next invocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'retainer-warm-'));
  vi.stubEnv('TMPDIR', directory);
  vi.stubEnv('RETAINER_RUNNER_MODE', 'job');
  vi.stubEnv('RETAINER_BUNDLED_RELEASE_DIGEST', digest);
  const requests: { path: string; authorization: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url ?? '',
      authorization: req.headers.authorization ?? '',
      body: Buffer.concat(chunks).toString(),
    });
    res.setHeader('content-type', 'application/json');
    // Empty installation KV: each run must create its own setup checkpoint.
    res.end(JSON.stringify(req.method === 'GET' ? null : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const log = vi.spyOn(console, 'log'),
    error = vi.spyOn(console, 'error');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const first = { ...job(), apiOrigin: base, runToken: 'rt_run_first' };
    const second = { ...job(), apiOrigin: base, runToken: 'rt_run_second' };
    const env = { ...process.env };
    expect(await handler(first)).toEqual({ status: 'succeeded' });
    const boundary = requests.length;
    expect(await handler(second)).toEqual({ status: 'succeeded' });
    expect(boundary).toBe(2);
    expect(requests.slice(boundary)).toHaveLength(2);
    for (const request of requests.slice(boundary)) {
      expect(request.path).toContain(second.installationId);
      expect(request.authorization).toBe('Bearer rt_run_second');
      expect(JSON.stringify(request)).not.toContain(first.installationId);
      expect(JSON.stringify(request)).not.toContain(first.runToken);
    }
    expect(process.env).toEqual(env);
    expect(await readdir(directory)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
