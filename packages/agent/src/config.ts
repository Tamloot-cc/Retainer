/** The agent runtime's configuration, from its environment (contract, Environment). */
export type AgentRuntimeConfig = {
  mastraUrl: string;
  runtimeSecret: string;
  apiOrigin: string;
  allowedOrigins: string[];
  port: number;
};

const required = [
  'RETAINER_MASTRA_DATABASE_URL',
  'ANTHROPIC_API_KEY',
  'RETAINER_AGENT_RUNTIME_SECRET',
  'RETAINER_API_ORIGIN',
] as const;

/**
 * Reads and checks the runtime's environment. Error messages name the
 * variables, never their values: two of them are credentials.
 */
export function loadAgentRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): AgentRuntimeConfig {
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`the agent runtime needs ${missing.join(', ')}`);
  }
  const value = (name: (typeof required)[number]) => env[name]?.trim() ?? '';
  const problems: string[] = [];
  const apiOrigin = value('RETAINER_API_ORIGIN');
  try {
    const url = new URL(apiOrigin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') problems.push('RETAINER_API_ORIGIN');
  } catch {
    problems.push('RETAINER_API_ORIGIN');
  }
  if ((env.RETAINER_AGENT_RUNTIME_SECRET ?? '').length < 32) {
    problems.push('RETAINER_AGENT_RUNTIME_SECRET (at least 32 characters)');
  }
  const port = Number(env.PORT ?? 8788);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) problems.push('PORT');
  if (problems.length)
    throw new Error(`invalid agent runtime configuration: ${problems.join(', ')}`);
  return {
    mastraUrl: value('RETAINER_MASTRA_DATABASE_URL'),
    runtimeSecret: value('RETAINER_AGENT_RUNTIME_SECRET'),
    apiOrigin,
    allowedOrigins: (env.RETAINER_AGENT_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    port,
  };
}

/**
 * The runtime reaches only Postgres, Retainer's API and Anthropic (spec
 * §4.2): Mastra's provider registry refresh and its telemetry stay off.
 */
export function quietMastra(env: Record<string, string | undefined> = process.env): void {
  env.MASTRA_OFFLINE ??= 'true';
  env.MASTRA_TELEMETRY_DISABLED ??= '1';
}
