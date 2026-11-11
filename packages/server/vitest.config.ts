import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Local runs read DATABASE_URL from the repository's .env, like `pnpm dev`.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile) && !process.env.CI) process.loadEnvFile(envFile);

// Tests import the MIT packages from source so they never run against a
// stale build.
const alias = {
  '@retainer/runner/last-contact': fileURLToPath(
    new URL('../runner/src/last-contact.ts', import.meta.url),
  ),
  '@retainer/runner/granola-contract': fileURLToPath(
    new URL('../runner/src/granola-contract.ts', import.meta.url),
  ),
  '@retainer/runner/granola': fileURLToPath(new URL('../runner/src/granola.ts', import.meta.url)),
  '@retainer/extension': fileURLToPath(new URL('../extension/src/index.ts', import.meta.url)),
  '@retainer/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
  '@retainer/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['test/**/*.test.ts'],
          globalSetup: ['test/global-setup.ts'],
          env: { RETAINER_SUPPRESSION_KEY: 'test-suppression-key-0123456789abcdef' },
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
