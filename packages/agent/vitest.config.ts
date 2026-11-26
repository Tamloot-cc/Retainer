import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Local runs read DATABASE_URL from the repository's .env, like the server's tests.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile) && !process.env.CI) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      // The runtime never reaches models.dev or Mastra's telemetry (spec §4.2).
      MASTRA_OFFLINE: 'true',
      MASTRA_TELEMETRY_DISABLED: '1',
    },
  },
});
