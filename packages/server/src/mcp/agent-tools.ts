import type { RetainerToolHost, RetainerToolResult } from '../agent-sessions/tools.js';
import type { Sql } from '../db/client.js';
import { type InProcessMcpOptions, inProcessMcp, listTools } from './in-process.js';

/**
 * The workspace agent's Retainer tools are the MCP tools (agent spec §8.1):
 * same names, descriptions, input schemas, validation, services and error
 * bodies. The agent runtime reaches them through the API's tool endpoint,
 * which calls them here, in process, on an MCP server built for the agent's
 * caller, exactly as `/mcp` builds one for a connected agent.
 */
export function agentToolHost(sql: Sql, options: InProcessMcpOptions = {}): RetainerToolHost {
  const rpc = inProcessMcp(sql, options);

  return {
    async list(caller, names) {
      const tools = await listTools(rpc, caller);
      return names.map((name) => {
        const tool = tools.find((entry) => entry.name === name);
        if (!tool) throw new Error(`MCP tool ${name} is missing`);
        return { name, description: tool.description ?? '', inputSchema: tool.inputSchema };
      });
    },
    async call(caller, name, input): Promise<RetainerToolResult> {
      const result = await rpc(caller, 'tools/call', { name, arguments: input ?? {} });
      const content = (result.content ?? []) as { type: string; text?: string }[];
      const text = content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');
      const structured = result.structuredContent as Record<string, unknown> | undefined;
      if (result.isError) {
        const body = (structured ?? safeJson(text)) as
          | { error?: { code?: unknown; message?: unknown } }
          | undefined;
        const code = typeof body?.error?.code === 'string' ? body.error.code : 'invalid_input';
        const message = typeof body?.error?.message === 'string' ? body.error.message : text;
        return { ok: false, error: { code, message } };
      }
      return { ok: true, output: structured ?? safeJson(text) ?? text };
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
