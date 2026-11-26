import { serve } from '@hono/node-server';
import { createAgentApp } from './app.js';
import { loadAgentRuntimeConfig, quietMastra } from './config.js';
import { logEvent } from './logger.js';

/**
 * Runs the agent runtime as a Node server: the self-hosted `agent`
 * container (`RETAINER_ROLE=agent`, spec §13). It opens no pool but the
 * `mastra` role's, runs no migrations, and serves until the process stops.
 */
export async function serveAgentRuntime(
  env: Record<string, string | undefined> = process.env,
): Promise<never> {
  quietMastra(env);
  const config = loadAgentRuntimeConfig(env);
  const app = createAgentApp({
    apiOrigin: config.apiOrigin,
    runtimeSecret: config.runtimeSecret,
    mastraUrl: config.mastraUrl,
    allowedOrigins: config.allowedOrigins,
  });
  const server = serve({ fetch: app.fetch, port: config.port });
  logEvent('info', 'agent_runtime_listening', { port: config.port });
  return new Promise<never>((_, reject) => {
    server.on('error', reject);
  });
}
