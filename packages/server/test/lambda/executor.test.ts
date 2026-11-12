import { exportJWK, generateKeyPair } from 'jose';
import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { DEPLOY_LOCK } from '../../src/lambda/deploy-lock.js';
import { createExecutorHandler, EXECUTOR_LEADER, handler } from '../../src/lambda/executor.js';
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
    await expect(run({ getRemainingTimeInMillis: () => 900000 })).resolves.toEqual({
      executed: 0,
      fenced: 0,
    });
  } finally {
    await run.close();
  }
  await expect(createExecutorHandler(loadConfig({ DATABASE_URL: db.url }))).rejects.toThrow(
    'executor is not configured',
  );
  await expect(
    handler({ task: 'not-a-schedule' }, { getRemainingTimeInMillis: () => 900000 }),
  ).rejects.toThrow('invalid extension executor event');
});

it('bounds the Lambda claim window, releases leadership when a migration blocks it, and can run again warm', async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const run = await createExecutorHandler(
    loadConfig({
      DATABASE_URL: db.url,
      RETAINER_EXTENSION_DRIVER: 'lambda',
      RETAINER_EXTENSION_LAMBDA_PREFIX:
        'arn:aws:lambda:eu-central-1:123456789012:function:retainer-ext-',
      RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX:
        'arn:aws:lambda:eu-central-1:123456789012:function:retainer-extv-',
      RETAINER_EXTENSION_EXECUTABLES: '[]',
      RETAINER_EXTENSION_CATALOG: '[]',
      RETAINER_EXTENSION_RUN_PUBLIC_KEY: JSON.stringify(await exportJWK(pair.publicKey)),
      RETAINER_EXTENSION_RUN_PRIVATE_KEY: JSON.stringify(await exportJWK(pair.privateKey)),
      RETAINER_EXTENSION_ISSUER: 'https://retainer.example',
      RETAINER_EXTENSION_API_ORIGIN: 'https://retainer.example',
    }),
  );
  const migration = db.connect({ max: 1, keepConnections: true });
  await migration`select pg_advisory_lock(${DEPLOY_LOCK})`;
  try {
    await expect(run({ getRemainingTimeInMillis: () => 345020 })).rejects.toMatchObject({
      code: '55P03',
    });
    const [leader] =
      await db.owner`select count(*)::int as count from pg_locks where locktype='advisory' and objid=${EXECUTOR_LEADER}
          and database=(select oid from pg_database where datname=current_database())`;
    expect(leader?.count).toBe(0);
    // No claim budget: returns immediately even though the migration is still active.
    for (let i = 0; i < 2; i++)
      expect(await run({ getRemainingTimeInMillis: () => 345000 })).toEqual({ skipped: false });
  } finally {
    await migration`select pg_advisory_unlock(${DEPLOY_LOCK})`;
    await run.close();
  }
});
