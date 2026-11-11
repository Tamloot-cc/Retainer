import { exportJWK, generateKeyPair } from 'jose';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createExecutorHandler, handler } from '../../src/lambda/executor.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
it('runs a configured bounded coordinator pass against real Postgres and refuses incomplete setup or a wrong event', async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const config = loadConfig({
    DATABASE_URL: db.url,
    RETAINER_EXTENSION_EXECUTABLES: '[]',
    RETAINER_EXTENSION_CATALOG: '[]',
    RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(await exportJWK(pair.publicKey)),
    RETAINER_EXTENSION_RUN_PRIVATE_KEY: JSON.stringify(await exportJWK(pair.privateKey)),
    RETAINER_EXTENSION_ISSUER: 'https://retainer.example',
    RETAINER_EXTENSION_API_ORIGIN: 'https://retainer.example',
    RETAINER_EXTENSION_LAUNCHER_ORIGIN: 'http://127.0.0.1:9000',
    RETAINER_LAUNCHER_TOKEN: 'x'.repeat(32),
  });
  const run = await createExecutorHandler(config);
  try {
    await expect(run()).resolves.toEqual({ executed: 0, fenced: 0 });
  } finally {
    await run.close();
  }
  await expect(createExecutorHandler(loadConfig({ DATABASE_URL: db.url }))).rejects.toThrow(
    'executor is not configured',
  );
  await expect(handler({ task: 'not-a-schedule' })).rejects.toThrow(
    'invalid extension executor event',
  );
});
