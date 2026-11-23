import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
let config: string;
beforeAll(async () => {
  config = await mkdtemp(join(tmpdir(), 'retainer-cli-test-'));
});
afterAll(async () => {
  if (config) await rm(config, { recursive: true, force: true });
});

async function command(...args: string[]) {
  const { stdout, stderr, code } = await run(process.execPath, [bin, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: config },
    timeout: 3000,
  }).then(
    (result) => ({ ...result, code: 0 }),
    (error: { code: number; stderr: string; stdout: string }) => error,
  );
  expect(stderr).toBe('');
  expect(stdout.trim().split('\n')).toHaveLength(1);
  return { code, data: JSON.parse(stdout) };
}

it('produces one complete machine-readable help document in a buffered shell', async () => {
  const result = await command('--help');
  expect(result).toMatchObject({
    code: 0,
    data: {
      commands: expect.arrayContaining([
        expect.objectContaining({ command: 'invite', example: expect.stringContaining('--org') }),
        expect.objectContaining({
          command: 'workspace delete',
          target: expect.stringContaining('click'),
        }),
      ]),
    },
  });
});

it('reports wrong usage and a missing login without a prompt', async () => {
  await expect(command('nonsense')).resolves.toMatchObject({
    code: 2,
    data: {
      error: 'invalid_usage',
      next: 'retainer --help',
    },
  });
  await expect(command('whoami', '--server', 'http://127.0.0.1:9')).resolves.toMatchObject({
    code: 3,
    data: {
      error: 'not_logged_in',
      next: expect.stringContaining('retainer login'),
    },
  });
});

it('explains key mode and returns a nonzero exit code', async () => {
  const server = createServer((_request, response) => response.writeHead(404).end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test address');
    await expect(
      command('login', '--server', `http://127.0.0.1:${address.port}`),
    ).resolves.toMatchObject({
      code: 1,
      data: { error: 'key_mode', next: 'retainer-ops --help' },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
