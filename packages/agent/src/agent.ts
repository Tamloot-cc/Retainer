import { createAnthropic } from '@ai-sdk/anthropic';
import { Agent } from '@mastra/core/agent';
import type { IMastraLogger } from '@mastra/core/logger';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { type RuntimeApi, TurnFencedError } from './api-client.js';
import { TURN_CREDENTIAL_KEY, TurnCredential } from './credential.js';
import type { PinnedTool } from './tools.js';

/** Every session runs on Claude Sonnet 5.5, by Mastra's model string (spec §3.4, D6). */
export const AGENT_MODEL = 'anthropic/claude-sonnet-5-5';

/** A request that got no response (429, 5xx, a connection error) is sent again, up to twice (D9). */
export const MODEL_MAX_RETRIES = 2;

/**
 * The provider options every request carries (spec §3.4, §3.5): adaptive
 * thinking shown as summaries, the history check's drop setting, effort
 * `medium`, and Anthropic's automatic caching for the conversation (5
 * minutes). No fallbacks (D1) and no context management (§3.5).
 */
export const ANTHROPIC_PROVIDER_OPTIONS = {
  thinking: {
    type: 'adaptive',
    display: 'summarized',
    blockBinding: { prefixMismatchBehavior: 'drop_block' },
  },
  effort: 'medium',
  cacheControl: { type: 'ephemeral' },
} as const;

/**
 * The system blocks pinned on the session, as Mastra instructions. The last
 * one carries the 1-hour breakpoint, so the tools and the system prompt stay
 * cached between a person's replies (§3.5).
 */
export function systemMessages(blocks: string[]) {
  return blocks.map((content, index) => ({
    role: 'system' as const,
    content,
    ...(index === blocks.length - 1
      ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } } }
      : {}),
  }));
}

/** Anthropic's server-side web search, used only for its definition (spec §8.1). */
const anthropicTools = createAnthropic({ apiKey: 'definitions-only' }).tools;

/** Reads the turn token from a tool call's request context. */
function turnToken(context: unknown): string {
  const requestContext = (context as { requestContext?: { get(key: string): unknown } })
    ?.requestContext;
  const credential = requestContext?.get(TURN_CREDENTIAL_KEY);
  if (!(credential instanceof TurnCredential)) throw new Error('no turn credential');
  return credential.reveal();
}

export type ToolDispatch = {
  api: RuntimeApi;
  sessionId: string;
  /** Called when the API fences the turn: the runtime aborts. */
  onFenced: (code: string) => void;
  /** No tool call runs past this (epoch ms). */
  deadline: number;
};

/**
 * Turns the session's pinned list into Mastra tools, in its order (§8.3).
 * Retainer and extension tools call the runtime's tool endpoint with the
 * turn token; web search is Anthropic's, with a constant `max_uses`.
 */
export function buildTools(pinned: PinnedTool[], dispatch: ToolDispatch) {
  const tools: Record<string, unknown> = {};
  for (const tool of pinned) {
    switch (tool.kind) {
      case 'web_search':
        // `20250305`: the `20260209` version needs code execution, which a
        // HIPAA-configured Anthropic organization refuses (spec §2, §3.4).
        tools.web_search = anthropicTools.webSearch_20250305({ maxUses: tool.maxUses });
        break;
      default:
        tools[tool.name] = createTool({
          id: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          execute: async (input, context) => {
            const toolCallId =
              (context as { agent?: { toolCallId?: string } })?.agent?.toolCallId ??
              crypto.randomUUID();
            const signal = (context as { abortSignal?: AbortSignal })?.abortSignal;
            try {
              // An extension tool answers `pending` while its job runs; the
              // same toolCallId finds the same job (contract, Changes).
              for (;;) {
                const left = dispatch.deadline - Date.now();
                if (left <= 0 || signal?.aborted) {
                  return {
                    error: { code: 'tool_unavailable', message: 'The turn ran out of time.' },
                  };
                }
                const answer = await dispatch.api.tool(
                  dispatch.sessionId,
                  turnToken(context),
                  tool.name,
                  { toolCallId, input },
                  { timeoutMs: Math.max(1_000, left), signal },
                );
                if ('pending' in answer) continue;
                if (answer.ok) return answer.output;
                return { error: answer.error };
              }
            } catch (error) {
              if (error instanceof TurnFencedError) {
                dispatch.onFenced(error.code);
                return { error: { code: error.code, message: 'This turn was stopped.' } };
              }
              return {
                error: { code: 'tool_unavailable', message: 'The tool could not be reached.' },
              };
            }
          },
        });
    }
  }
  return tools;
}

export type AgentOptions = {
  store: MastraCompositeStore;
  systemBlocks: string[];
  tools: Record<string, unknown>;
  logger: IMastraLogger;
};

/**
 * The agent for one turn. Built per turn: a session's instructions and
 * tools are its own, pinned when it was created.
 */
export function createRetainerAgent(options: AgentOptions): Agent {
  const memory = new Memory({
    storage: options.store,
    options: {
      // The whole thread, every turn: no trimming, so thinking blocks stay
      // valid and the cache warm (spec §3.4, §5.5).
      lastMessages: Number.MAX_SAFE_INTEGER,
      semanticRecall: false,
      workingMemory: { enabled: false },
      generateTitle: false,
    },
  });
  const agent = new Agent({
    id: 'retainer-agent',
    name: 'Retainer agent',
    instructions: systemMessages(options.systemBlocks),
    model: AGENT_MODEL,
    // Mastra's own attempt loop resends a whole step, even one whose
    // response had started to stream; it is off. The provider call's retries
    // (MODEL_MAX_RETRIES) are set per step in the turn's prepareStep.
    maxRetries: 0,
    memory,
    // biome-ignore lint/suspicious/noExplicitAny: Mastra's ToolsInput accepts provider tools too.
    tools: options.tools as any,
    durable: false,
    // Mastra's default error processors retry a step whose stream already
    // started and rewrite history on some errors; neither fits (spec §3.4,
    // §10.2). Retries are the provider call's alone.
    errorProcessorDefaults: false,
  });
  agent.__setLogger(options.logger);
  memory.__setLogger?.(options.logger);
  options.store.__setLogger(options.logger);
  return agent;
}
