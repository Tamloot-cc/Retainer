import {
  type PinnedTool,
  RETAINER_ROUTINE_TOOL_NAMES,
  RETAINER_TOOL_NAMES,
  TOOL_NAME,
  type ToolAnswer,
  WEB_MAX_USES,
} from '@retainer/agent';
import type { Caller } from '../caller.js';
import type { Tx } from '../db/tx.js';
import type { RuntimeCatalog } from '../extension-runtime/availability.js';
import { installedTools } from '../extensions/tools.js';

/** A Retainer tool's result for the model: its output, or an error result that says why. */
export type RetainerToolResult = ToolAnswer;

/**
 * Retainer's own tools, as the MCP server defines and runs them (agent spec
 * §8.1). The API's interface layer provides it (`mcp/agent-tools.ts`), so
 * the session code never depends on MCP.
 */
export interface RetainerToolHost {
  /** The named tools, in order. */
  list(
    caller: Caller,
    names: readonly string[],
  ): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]>;
  call(caller: Caller, name: string, input: unknown): Promise<RetainerToolResult>;
}

/** A pinned extension tool's name for the model, and what it calls. */
export type ExtensionToolRef = { registrationId: string; tool: string };

/** Extension tools get a prefix so they never collide with Retainer's. */
const EXTENSION_PREFIX = 'ext_';
export const extensionToolName = (tool: string) => `${EXTENSION_PREFIX}${tool}`;

/**
 * The tools a new session pins, in order (agent spec §8.3): Retainer's
 * read and write tools as MCP defines them, its routine tools where the
 * server has routines (routines-in-chat spec §3.1), web search with its
 * constant `max_uses`, then the workspace's extension tools declared `read`,
 * sorted by name. Every tool the caller could use is pinned, write tools
 * included even for a chat that starts read-only: access is checked when a
 * tool is called, never by removing it, so the tools block never changes.
 * Extension `write` and `send` tools aren't offered in v1 (D9).
 */
export async function pinnedTools(
  tx: Tx,
  caller: Caller,
  host: RetainerToolHost,
  catalog: RuntimeCatalog | undefined,
  routines = false,
): Promise<{ tools: PinnedTool[]; extensionTools: Record<string, ExtensionToolRef> }> {
  const retainer = await host.list(
    caller,
    routines ? [...RETAINER_TOOL_NAMES, ...RETAINER_ROUTINE_TOOL_NAMES] : RETAINER_TOOL_NAMES,
  );
  const tools: PinnedTool[] = retainer.map((tool) => ({
    kind: 'retainer',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Extract<PinnedTool, { kind: 'retainer' }>['inputSchema'],
  }));
  tools.push({ kind: 'web_search', name: 'web_search', maxUses: WEB_MAX_USES });
  const extensionTools: Record<string, ExtensionToolRef> = {};
  if (catalog) {
    const installed = (await installedTools(tx, catalog))
      .filter((tool) => tool.effect === 'read' && tool.status !== 'conflict')
      .map((tool) => ({ tool, name: extensionToolName(tool.name) }))
      .filter(({ name }) => TOOL_NAME.test(name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const { tool, name } of installed) {
      tools.push({
        kind: 'extension',
        name,
        description:
          `${tool.title ? `${tool.title}. ` : ''}${tool.description ?? ''} (from the ${tool.extension} extension)`.trim(),
        inputSchema: tool.inputSchema as Extract<PinnedTool, { kind: 'extension' }>['inputSchema'],
      });
      extensionTools[name] = { registrationId: tool.registrationId, tool: tool.name };
    }
  }
  return { tools, extensionTools };
}

/** Whether a session's pinned tools include the routine group (routines-in-chat spec §3.2). */
export const pinsRoutines = (tools: readonly { name: string }[]) =>
  tools.some((tool) => (RETAINER_ROUTINE_TOOL_NAMES as readonly string[]).includes(tool.name));

/** Steps, tokens and calls a chat turn may use (agent spec §10.1). */
export const CHAT_LIMITS = {
  maxSteps: 50,
  maxOutputTokens: 32_000,
  maxToolCalls: 200,
  webMaxUses: WEB_MAX_USES,
  webSearches: 30,
} as const;
