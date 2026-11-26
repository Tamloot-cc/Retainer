import type { JSONSchema7 } from 'json-schema';

/**
 * Retainer's own tools, in the order a session pins them (spec §8.1, §8.3):
 * `retainer.read`, then `retainer.write`. They match the MCP tools in name
 * and behaviour. `get_guide` is read-only and lets the agent follow the
 * guides the base prompt points to (§6.6).
 */
export const RETAINER_READ_TOOL_NAMES = [
  'describe_schema',
  'search',
  'query_records',
  'get_record',
  'get_context',
  'get_timeline',
  'get_event_content',
  'get_guide',
] as const;
export const RETAINER_WRITE_TOOL_NAMES = ['upsert_record', 'log_event', 'remember'] as const;
export const RETAINER_TOOL_NAMES: readonly string[] = [
  ...RETAINER_READ_TOOL_NAMES,
  ...RETAINER_WRITE_TOOL_NAMES,
];

/** Searches or fetches in one request: a constant, so the tool definitions never change (§10.1). */
export const WEB_MAX_USES = 10;

/**
 * One tool definition pinned on a session when it is created (§8.3). The
 * API builds the list; the runtime turns it into Mastra tools in order.
 */
export type PinnedTool =
  | { kind: 'retainer'; name: string; description: string; inputSchema: JSONSchema7 }
  | { kind: 'extension'; name: string; description: string; inputSchema: JSONSchema7 }
  | { kind: 'web_search'; name: 'web_search'; maxUses: number }
  | { kind: 'web_fetch'; name: 'web_fetch'; maxUses: number };

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Checks a pinned list from the API before it is turned into tools. */
export function parsePinnedTools(value: unknown): PinnedTool[] {
  if (!Array.isArray(value)) throw new Error('pinned tools must be a list');
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('pinned tool must be an object');
    const tool = raw as Record<string, unknown>;
    const name = tool.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) throw new Error('bad pinned tool name');
    if (seen.has(name)) throw new Error(`duplicate pinned tool ${name}`);
    seen.add(name);
    switch (tool.kind) {
      case 'retainer':
      case 'extension':
        if (typeof tool.description !== 'string')
          throw new Error(`tool ${name} needs a description`);
        if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
          throw new Error(`tool ${name} needs an input schema`);
        }
        return {
          kind: tool.kind,
          name,
          description: tool.description,
          inputSchema: tool.inputSchema as JSONSchema7,
        };
      case 'web_search':
      case 'web_fetch':
        if (name !== tool.kind) throw new Error(`${tool.kind} must be named ${tool.kind}`);
        return {
          kind: tool.kind,
          name: tool.kind,
          maxUses: typeof tool.maxUses === 'number' ? tool.maxUses : WEB_MAX_USES,
        } as PinnedTool;
      default:
        throw new Error(`unknown pinned tool kind for ${name}`);
    }
  });
}
