import { createInterface } from 'node:readline/promises';
import type { RetainerClient } from '@retainer/sdk';

/**
 * `retainer agent chat` (docs/specs/agent.md §6.7): a chat with the workspace
 * agent in the terminal. Reasoning is dimmed, tool calls and results are
 * short lines. A CLI chat reads by default; the agent writes only while this
 * login is elevated in the workspace.
 */

const dim = (text: string, color: boolean) => (color ? `\x1b[2m${text}\x1b[22m` : text);
const short = (value: unknown, max = 80) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export type RenderState = {
  color: boolean;
  /** What the last write ended with, so blocks start on their own line. */
  at: 'start' | 'text' | 'reasoning' | 'line';
  toolNames: Map<string, string>;
  /** How the turn ended, from the stream. */
  ended?: { status: string; code: string | null };
  text: string;
};

export function renderState(color: boolean): RenderState {
  return { color, at: 'start', toolNames: new Map(), text: '' };
}

/** Turn-end statuses, in plain words (spec §3.4, §5.5, §10). */
const ENDINGS: Record<string, string> = {
  refused: 'The agent declined to answer this.',
  incomplete: 'The answer was cut short.',
  context_limit_reached: 'This chat is too long to continue. Start a new chat.',
  history_rejected: 'This chat can no longer continue. Start a new chat.',
  model_unavailable: 'The model is unavailable right now. Send your message again shortly.',
  limit_reached: 'The agent reached its limit for this turn or today.',
  cancelled: 'Stopped.',
  timed_out: 'The turn ran out of time.',
  failed: 'Something went wrong in this turn.',
};

/** How a `data-turn-end` chunk says the turn ended. */
function turnEnd(chunk: Record<string, unknown>): { status: string; code: string | null } {
  const data = chunk.data as { status?: string; code?: string | null } | undefined;
  return { status: data?.status ?? 'failed', code: data?.code ?? null };
}

/** What one UI message stream chunk prints, given what came before. */
export function renderChunk(state: RenderState, chunk: Record<string, unknown>): string {
  const line = (text: string) => {
    const prefix = state.at === 'start' || state.at === 'line' ? '' : '\n';
    state.at = 'line';
    return `${prefix}${text}\n`;
  };
  switch (chunk.type) {
    case 'reasoning-delta': {
      const delta = String(chunk.delta ?? '');
      if (!delta) return '';
      const prefix =
        state.at === 'reasoning' || state.at === 'start' || state.at === 'line' ? '' : '\n';
      state.at = 'reasoning';
      return prefix + dim(delta, state.color);
    }
    case 'text-delta': {
      const delta = String(chunk.delta ?? '');
      if (!delta) return '';
      const prefix =
        state.at === 'text' || state.at === 'start' || state.at === 'line' ? '' : '\n\n';
      state.at = 'text';
      state.text += delta;
      return prefix + delta;
    }
    case 'tool-input-start':
      state.toolNames.set(String(chunk.toolCallId), String(chunk.toolName));
      return '';
    case 'tool-input-available':
      state.toolNames.set(String(chunk.toolCallId), String(chunk.toolName));
      return line(dim(`→ ${chunk.toolName} ${short(chunk.input)}`, state.color));
    case 'tool-output-available': {
      const name = state.toolNames.get(String(chunk.toolCallId)) ?? 'tool';
      const output = chunk.output as { error?: { code?: string } } | undefined;
      const error = output && typeof output === 'object' ? output.error : undefined;
      return line(
        dim(
          error?.code ? `← ${name} error: ${error.code}` : `← ${name} ${short(chunk.output, 60)}`,
          state.color,
        ),
      );
    }
    case 'tool-output-error': {
      const name = state.toolNames.get(String(chunk.toolCallId)) ?? 'tool';
      return line(dim(`← ${name} failed: ${short(chunk.errorText, 60)}`, state.color));
    }
    case 'error':
      return line(`Error: ${short(chunk.errorText, 200)}`);
    case 'data-turn-end': {
      state.ended = turnEnd(chunk);
      const { status } = state.ended;
      return line(ENDINGS[status] ?? `The turn ended: ${status}.`);
    }
    default:
      return '';
  }
}

/** Reads an SSE response into UI message stream chunks. */
export async function* sseChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const bytes of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(bytes, { stream: true });
    for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        // A malformed event is skipped; the stream goes on.
      }
    }
  }
}

export type ChatIo = {
  write: (text: string) => void;
  color: boolean;
  /** Called with each chunk as JSON instead of rendering it (--json). */
  json?: (chunk: Record<string, unknown>) => void;
};

/** Sends one message and renders the turn. Returns how it ended. */
export async function sendMessage(
  api: RetainerClient,
  chatId: string,
  text: string,
  io: ChatIo,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<{ status: string; code: string | null; text: string }> {
  const { token, streamUrl } = await api.agentChatToken(chatId, options.signal);
  const response = await (options.fetch ?? fetch)(streamUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { parts: [{ type: 'text', text }] } }),
    signal: options.signal,
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    let code = 'request_failed';
    try {
      const body = (await response.json()) as { code?: string; error?: { code?: string } };
      code = body.code ?? body.error?.code ?? code;
    } catch {}
    return { status: 'refused_to_start', code, text: '' };
  }
  const state = renderState(io.color);
  let finished = false;
  // How the turn ended is recorded whatever the output (--json included).
  const emit = (chunk: Record<string, unknown>) => {
    if (chunk.type === 'finish') finished = true;
    if (chunk.type === 'data-turn-end') state.ended = turnEnd(chunk);
    if (io.json) io.json(chunk);
    else io.write(renderChunk(state, chunk));
  };
  for await (const chunk of sseChunks(response.body)) emit(chunk);
  // A stream that ends without its `finish` was cut on the way (a proxy, a
  // dropped connection): what arrived is never reported as a finished answer.
  if (!finished && !state.ended)
    emit({ type: 'data-turn-end', data: { status: 'incomplete', code: 'stream_cut' } });
  if (!io.json && state.at !== 'start' && state.at !== 'line') io.write('\n');
  return { ...(state.ended ?? { status: 'completed', code: null }), text: state.text };
}

/** Why a turn didn't start, in plain words. */
export function startFailure(code: string): string {
  switch (code) {
    case 'turn_running':
      return 'The agent is still answering your last message.';
    case 'turn_stopping':
      return 'The last turn is still stopping. Try again in a few seconds.';
    case 'limit_reached':
      return "You've reached today's agent limit.";
    case 'agent_unavailable':
      return 'The agent is not available on this server.';
    default:
      return `The message could not be sent (${code}).`;
  }
}

/**
 * The interactive loop: one line per message. Ctrl-C during a turn stops the
 * turn (the chat stays); Ctrl-C or Ctrl-D at the prompt leaves.
 */
export async function interactiveChat(
  api: RetainerClient,
  chatId: string,
  io: ChatIo,
): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let turn: AbortController | undefined;
  const onSigint = () => {
    if (turn) {
      turn.abort();
      void api.cancelAgentChat(chatId).catch(() => {});
    } else rl.close();
  };
  rl.on('SIGINT', onSigint);
  io.write(dim('Chat with the Retainer agent. Ctrl-C stops a turn; Ctrl-D leaves.\n', io.color));
  try {
    for (;;) {
      let text: string;
      try {
        text = (await rl.question('> ')).trim();
      } catch {
        return 0;
      }
      if (!text) continue;
      turn = new AbortController();
      try {
        const result = await sendMessage(api, chatId, text, io, { signal: turn.signal });
        if (result.status === 'refused_to_start') io.write(`${startFailure(result.code ?? '')}\n`);
      } catch (error) {
        if (!turn.signal.aborted) throw error;
        io.write('\nStopped.\n');
      } finally {
        turn = undefined;
      }
    }
  } finally {
    rl.close();
  }
}
