import { type Config, EXECUTOR_ROLE, loadConfig, ownerDatabaseUrl } from '../config.js';
import { createRuntimeSql, createSql } from '../db/client.js';
import { createFileStorage } from '../file-storage/configuration.js';
import { FileMaintenance } from '../worker/files.js';
import { withPassLock } from './deploy-lock.js';

/** Dedicated scheduled storage maintenance. Hosted IAM/scheduling live in retainer-cloud. */
export async function createFileMaintenanceHandler(config: Config) {
  const storage = await createFileStorage(config);
  if (!storage) throw new Error('file storage is not configured');
  const sql = createRuntimeSql(config, { max: 1 });
  const discovery = config.RETAINER_EXECUTOR_DATABASE_URL
    ? createSql(config.RETAINER_EXECUTOR_DATABASE_URL, { max: 1 })
    : createSql(ownerDatabaseUrl(config), { role: EXECUTOR_ROLE, max: 1 });
  const maintenance = new FileMaintenance(sql, discovery, storage);
  const deployLock = createRuntimeSql(config, { max: 1, keepConnections: true });
  return async () => {
    const result = await withPassLock(deployLock, () => maintenance.tick());
    if (result.failed) throw new Error('file storage erasure remains pending');
    return result;
  };
}
let cached: ReturnType<typeof createFileMaintenanceHandler> | undefined;
export async function handler(event: unknown) {
  if (
    !event ||
    typeof event !== 'object' ||
    (event as { task?: unknown }).task !== 'erase-file-storage'
  )
    throw new Error('invalid file maintenance event');
  cached ??= createFileMaintenanceHandler(loadConfig());
  return (await cached)();
}
