import {
  BASE_SYSTEM_PROMPT,
  type PinnedTool,
  RETAINER_READ_TOOL_NAMES,
  RETAINER_WRITE_TOOL_NAMES,
  WEB_MAX_USES,
} from '@retainer/agent';
import type { Caller } from '../caller.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import type { RuntimeCatalog } from '../extension-runtime/availability.js';
import { installedTools } from '../extensions/tools.js';
import { type ExtensionToolRef, extensionToolName, type RetainerToolHost } from './tools.js';

/**
 * The tools a task pins (§8.1, §8.3, §9.4): Retainer's reads and writes as
 * granted, web search, and the extension `read` tools it names, in the
 * order a chat pins them. An extension tool that isn't installed, or isn't
 * a `read` tool, is refused when the task is created.
 */
export async function taskTools(
  tx: Tx,
  caller: Caller,
  host: RetainerToolHost,
  catalog: RuntimeCatalog | undefined,
  groups: readonly string[],
): Promise<{
  tools: PinnedTool[];
  extensionTools: Record<string, ExtensionToolRef>;
  baseSystemPrompt: string;
}> {
  const names = [
    ...(groups.includes('retainer.read') ? RETAINER_READ_TOOL_NAMES : []),
    ...(groups.includes('retainer.write') ? RETAINER_WRITE_TOOL_NAMES : []),
  ];
  const retainer = names.length ? await host.list(caller, names) : [];
  const tools: PinnedTool[] = retainer.map((tool) => ({
    kind: 'retainer',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Extract<PinnedTool, { kind: 'retainer' }>['inputSchema'],
  }));
  if (groups.includes('web.search'))
    tools.push({ kind: 'web_search', name: 'web_search', maxUses: WEB_MAX_USES });
  const extensionTools: Record<string, ExtensionToolRef> = {};
  const wanted = groups.filter((group) => group.startsWith('tools.')).map((g) => g.slice(6));
  if (wanted.length) {
    const installed = catalog ? await installedTools(tx, catalog) : [];
    const pinned = [];
    for (const name of new Set(wanted)) {
      const tool = installed.find((entry) => entry.name === name && entry.status !== 'conflict');
      if (!tool) throw new AppError(409, 'tool_unavailable', `the tool "${name}" is not installed`);
      if (tool.effect !== 'read')
        throw new AppError(
          403,
          'tool_not_allowed',
          `the agent may only use tools that read; "${name}" doesn't`,
        );
      pinned.push({ tool, name: extensionToolName(tool.name) });
    }
    pinned.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const { tool, name } of pinned) {
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
  return { tools, extensionTools, baseSystemPrompt: BASE_SYSTEM_PROMPT };
}
