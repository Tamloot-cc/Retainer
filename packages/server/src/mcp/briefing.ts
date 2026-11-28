import type { AgentBriefing } from '@retainer/shared';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { GUIDE_NAMES, GUIDES } from './guides.js';
import { type InProcessMcpOptions, inProcessMcp, listTools } from './in-process.js';
import { INSTRUCTIONS } from './instructions.js';

/**
 * What Retainer tells every agent that connects (agent view spec §7): the
 * connection instructions, the tools as `tools/list` returns them on a server
 * built for this caller, and the guides `get_guide` serves. Each comes from
 * the same source the agent gets it from, so the briefing cannot drift.
 */
export function agentBriefing(sql: Sql, options: InProcessMcpOptions = {}) {
  const rpc = inProcessMcp(sql, options);
  const guides = GUIDE_NAMES.map((name) => ({
    name,
    description: GUIDES[name].description,
    markdown: GUIDES[name].text,
  }));
  return async (caller: Caller): Promise<AgentBriefing> => {
    const tools = await listTools(rpc, caller);
    return {
      instructions: INSTRUCTIONS,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      })),
      guides,
    };
  };
}
