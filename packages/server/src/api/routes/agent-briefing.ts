import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import type { AppEnv } from '../../http/response.js';
import { agentBriefing } from '../../mcp/briefing.js';
import type { InProcessMcpOptions } from '../../mcp/in-process.js';

/**
 * What Retainer tells every agent that connects (agent view spec §7), read
 * only. The MCP server is built with the same options as `/mcp`, so a tool the
 * deployment turns off is absent here exactly when it is absent for agents.
 */
export function agentBriefingRoutes(app: Hono<AppEnv>, sql: Sql, options: InProcessMcpOptions) {
  const briefing = agentBriefing(sql, options);
  app.get('/agent-briefing', requireScope('read'), async (c) =>
    c.json(await briefing(c.get('caller'))),
  );
}
