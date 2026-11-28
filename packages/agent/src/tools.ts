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
  'aggregate_records',
  'check_dashboard',
  'list_views',
  'check_view',
  'get_record',
  'get_context',
  'get_timeline',
  'get_event_content',
  'get_guide',
] as const;
export const RETAINER_WRITE_TOOL_NAMES = [
  'upsert_record',
  'upsert_records',
  'log_event',
  'remember',
] as const;
export const RETAINER_TOOL_NAMES: readonly string[] = [
  ...RETAINER_READ_TOOL_NAMES,
  ...RETAINER_WRITE_TOOL_NAMES,
];
/**
 * `retainer.routines`, for chats only, on servers where routines are
 * enabled (routines-in-chat spec §3.1): what a chat needs to draft, check
 * and dry-run a routine. `propose_routine` is not one: in a chat the person
 * proposes with the card's button. Tasks never pin these.
 */
export const RETAINER_ROUTINE_TOOL_NAMES = [
  'get_routine_capabilities',
  'validate_routine',
  'get_routine_job',
  'preview_routine',
  'get_routine_preview',
  'list_routines',
  'get_routine',
] as const;

/** Searches in one request: a constant, so the tool definitions never change (§10.1). */
export const WEB_MAX_USES = 10;

/**
 * One tool definition pinned on a session when it is created (§8.3). The
 * API builds the list; the runtime turns it into Mastra tools in order.
 */
export type PinnedTool =
  | { kind: 'retainer'; name: string; description: string; inputSchema: JSONSchema7 }
  | { kind: 'extension'; name: string; description: string; inputSchema: JSONSchema7 }
  | { kind: 'web_search'; name: 'web_search'; maxUses: number };

/** Anthropic's tool names. */
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

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
        if (name !== 'web_search') throw new Error('web_search must be named web_search');
        return {
          kind: 'web_search',
          name: 'web_search',
          maxUses: typeof tool.maxUses === 'number' ? tool.maxUses : WEB_MAX_USES,
        };
      default:
        throw new Error(`unknown pinned tool kind for ${name}`);
    }
  });
}
