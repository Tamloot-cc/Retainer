import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

it('uses the immutable AWS package stamp and ignores it in a local process', async () => {
  const productCommit = 'a'.repeat(40);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ productCommit }));
  vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'retainer-api');
  const hosted = await import('./writer-build.js');
  expect(hosted.HOSTED_WRITER_BUILD).toBe(productCommit);
  expect(readFileSync).toHaveBeenCalledWith(
    new URL('../../retainer-build.json', import.meta.url),
    'utf8',
  );

  vi.resetModules();
  vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', undefined);
  expect((await import('./writer-build.js')).HOSTED_WRITER_BUILD).toBeUndefined();
});

it('rejects an invalid stamp rather than treating it as an older package', async () => {
  vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'retainer-api');
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ productCommit: 'current' }));
  await expect(import('./writer-build.js')).rejects.toThrow('invalid hosted writer build stamp');
});
