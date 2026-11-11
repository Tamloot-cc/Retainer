import { type Config, EXECUTOR_ROLE, loadConfig, ownerDatabaseUrl } from '../config.js';
import { createRuntimeSql, createSql } from '../db/client.js';
import { extensionServices } from '../extension-control/configuration.js';
import { ExtensionQueue } from '../extension-runtime/queue.js';
import { ChangeMaintenance } from '../worker/changes.js';
import { withPassLock } from './deploy-lock.js';

/** Hosted IAM/scheduling live in retainer-cloud; no provider code runs in this task. */
export async function createChangeMaintenanceHandler(config: Config) {
  const services = await extensionServices(config),
    sql = createRuntimeSql(config, { max: 2 });
  const discovery = config.RETAINER_EXECUTOR_DATABASE_URL
    ? createSql(config.RETAINER_EXECUTOR_DATABASE_URL, { max: 1 })
    : createSql(ownerDatabaseUrl(config), { role: EXECUTOR_ROLE, max: 1 });
  const queue = new ExtensionQueue(sql, services.catalog.runtime);
  const worker = new ChangeMaintenance(sql, discovery, queue),
    deployLock = createRuntimeSql(config, { max: 1, keepConnections: true });
  return async () => {
    const result = await withPassLock(deployLock, () => worker.tick());
    if (result.failed) throw new Error('change dispatch or retention remains pending');
    return result;
  };
}
let cached: ReturnType<typeof createChangeMaintenanceHandler> | undefined;
export async function handler(event: unknown) {
  if (
    !event ||
    typeof event !== 'object' ||
    (event as { task?: unknown }).task !== 'dispatch-record-changes'
  )
    throw new Error('invalid change maintenance event');
  cached ??= createChangeMaintenanceHandler(loadConfig());
  return (await cached)();
}
