import { type AuthInfo, createMcpHandler } from '@modelcontextprotocol/server';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { ExtensionCatalog } from '../extensions/catalog.js';
import type { FileStorage } from '../file-storage/contract.js';
import { log } from '../log.js';
import type { RoutineConfig } from '../routines/capabilities.js';
import { createMcpServer } from './server.js';

export type InProcessMcpOptions = {
  extensionCatalog?: ExtensionCatalog | undefined;
  extensionActivation?: ReadonlySet<string> | undefined;
  fileStorage?: FileStorage | undefined;
  fileQuota?: number | undefined;
  routines?: RoutineConfig | undefined;
  publicOrigin?: string | undefined;
};

/**
 * The MCP handler `/mcp` serves and in-process calls use: each request gets a
 * server built for the caller in its auth info, never one from the body.
 */
export function mcpHandler(sql: Sql, options: InProcessMcpOptions) {
  return createMcpHandler(
    ({ authInfo }) => {
      const caller = authInfo?.extra?.caller as Caller | undefined;
      // Unreachable behind authenticate(); fail closed if that ever changes.
      if (!caller) throw new Error('MCP request reached the server without a caller');
      return createMcpServer(sql, caller, options.extensionCatalog, options);
    },
    { onerror: (error) => log.error(error) },
  );
}

/** One JSON-RPC call to an MCP server built for `caller`, answered in process. */
export type McpRpc = (
  caller: Caller,
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/**
 * Calls an MCP server built for a caller, in process, exactly as `/mcp`
 * builds one for a connected agent: same tools, descriptions, validation and
 * error bodies. The workspace agent's tool host and the agent briefing use it.
 */
export function inProcessMcp(sql: Sql, options: InProcessMcpOptions = {}): McpRpc {
  const handler = mcpHandler(sql, options);
  let id = 0;
  return async (caller, method, params) => {
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
  };
}

/** A tool as `tools/list` describes it. */
export type ListedTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

/** Every tool the server built for `caller` offers, as `tools/list` returns them. */
export async function listTools(rpc: McpRpc, caller: Caller): Promise<ListedTool[]> {
  const result = await rpc(caller, 'tools/list', {});
  return (result.tools ?? []) as ListedTool[];
}
