import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { RetainerToolHost, RetainerToolResult } from '../agent-sessions/tools.js';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { ExtensionCatalog } from '../extensions/catalog.js';
import type { FileStorage } from '../file-storage/contract.js';
import { log } from '../log.js';
import { createMcpServer } from './server.js';

/**
 * The workspace agent's Retainer tools are the MCP tools (agent spec §8.1):
 * same names, descriptions, input schemas, validation, services and error
 * bodies. The agent runtime reaches them through the API's tool endpoint,
 * which calls them here, in process, on an MCP server built for the agent's
 * caller, exactly as `/mcp` builds one for a connected agent.
 */
export function agentToolHost(
  sql: Sql,
  options: {
    extensionCatalog?: ExtensionCatalog | undefined;
    extensionActivation?: ReadonlySet<string> | undefined;
    fileStorage?: FileStorage | undefined;
    fileQuota?: number | undefined;
  } = {},
): RetainerToolHost {
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.caller as Caller | undefined;
      if (!caller) throw new Error('agent tool call without a caller');
      return createMcpServer(sql, caller, options.extensionCatalog, options);
    },
    { onerror: (error) => log.error(error) },
  );
  let id = 0;
  async function rpc(caller: Caller, method: string, params: Record<string, unknown>) {
    const authInfo: AuthInfo = {
      token: '',
      clientId: caller.actor.id,
      scopes: [...caller.scopes],
      extra: { caller },
    };
    const request = new Request('http://retainer.internal/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const response = await handler.fetch(request, { authInfo });
    const text = await response.text();
    const payload = response.headers.get('content-type')?.includes('text/event-stream')
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('')
      : text;
    const message = JSON.parse(payload) as {
      result?: Record<string, unknown>;
      error?: { message?: string };
    };
    if (!message.result) throw new Error(`MCP ${method} failed: ${message.error?.message ?? ''}`);
    return message.result;
  }

  return {
    async list(caller, names) {
      const result = await rpc(caller, 'tools/list', {});
      const tools = (result.tools ?? []) as {
        name: string;
        description?: string;
        inputSchema: Record<string, unknown>;
      }[];
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
