import { type Config, loadConfig } from '../config.js';
import { createRuntimeSql } from '../db/client.js';
import { extensionServices } from '../extension-control/configuration.js';
import { withPassLock } from './deploy-lock.js';

/** Trusted queue coordinator. Provider functions run in the configured isolated launcher. */
export async function createExecutorHandler(config: Config) {
  const sql = createRuntimeSql(config, { max: 4 });
  const services = await extensionServices(config, { workerSql: sql });
  if (!services.executor) {
    await services.close();
    await sql.end({ timeout: 5 });
    throw new Error('extension executor is not configured');
  }
  const executor = services.executor;
  const lock = createRuntimeSql(config, { max: 1, keepConnections: true });
  return Object.assign(() => withPassLock(lock, () => executor.tick(4)), {
    close: async () => {
      executor.stop();
      await services.close();
      await Promise.all([sql.end({ timeout: 5 }), lock.end({ timeout: 5 })]);
    },
  });
}

let cached: ReturnType<typeof createExecutorHandler> | undefined;
export async function handler(event: unknown) {
  if (
    !event ||
    typeof event !== 'object' ||
    (event as { task?: unknown }).task !== 'execute-extension-jobs'
  )
    throw new Error('invalid extension executor event');
  cached ??= createExecutorHandler(loadConfig());
  return (await cached)();
}
