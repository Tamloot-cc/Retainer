import type { UIMessage } from 'ai';
import type { LogoMood } from '../../ui/index.js';

/** A message as the chat shows it: the AI SDK's UI message (agent spec §6.1). */
export type ChatMessage = UIMessage;
export type ChatPart = ChatMessage['parts'][number];

/** The only request body the agent runtime takes (agent spec §6.1). */
export function chatRequestBody(text: string) {
  return { message: { parts: [{ type: 'text' as const, text }] } };
}

/** The text a person typed in a message, from its text parts. */
export function messageText(message: Pick<ChatMessage, 'parts'>) {
  return message.parts
    .filter((part): part is Extract<ChatPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** A tool call or result part, typed loosely: the chat's tools aren't known to the client. */
export type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export function isToolPart(part: { type: string }): part is ToolPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

/** A tool part's tool name: `tool-search` is `search`, a dynamic tool names itself. */
export function toolName(part: ToolPart) {
  return part.type === 'dynamic-tool' ? (part.toolName ?? 'tool') : part.type.slice(5);
}

/** Tools that read: Retainer's and the web (agent spec §8.1). */
const READ_TOOLS = new Set([
  'search',
  'query_records',
  'get_record',
  'get_context',
  'get_timeline',
  'describe_schema',
  'get_event_content',
  'web_search',
]);
/** Tools that write to Retainer. */
const WRITE_TOOLS = new Set(['upsert_record', 'log_event', 'remember']);

/** Whether the call has been made and its result is in. */
export function toolFinished(part: ToolPart) {
  return part.state === 'output-available' || part.state === 'output-error';
}

/** The error a tool answered with, if it failed: a thrown error or an `{ ok: false }` result. */
export function toolError(part: ToolPart): string | undefined {
  if (part.state === 'output-error') return part.errorText ?? 'failed';
  const output = part.output as { ok?: boolean; error?: { code?: string } } | undefined;
  if (output && typeof output === 'object' && output.error && typeof output.error === 'object')
    return output.error.code ?? 'failed';
  return undefined;
}

const quoted = (value: unknown) =>
  typeof value === 'string' && value.trim() ? `“${value.trim()}”` : undefined;

function inputOf(part: ToolPart) {
  return (part.input && typeof part.input === 'object' ? part.input : {}) as Record<
    string,
    unknown
  >;
}

/** One short line saying what a tool call does, in plain words. */
export function toolLine(part: ToolPart): string {
  const name = toolName(part);
  const input = inputOf(part);
  const done = toolFinished(part);
  const verb = (doing: string, did: string) => (done ? did : doing);
  switch (name) {
    case 'search': {
      const q = quoted(input.query);
      return q ? verb(`Searching for ${q}`, `Searched for ${q}`) : verb('Searching', 'Searched');
    }
    case 'web_search': {
      const q = quoted(input.query);
      return q
        ? verb(`Searching the web for ${q}`, `Searched the web for ${q}`)
        : verb('Searching the web', 'Searched the web');
    }
    case 'query_records': {
      const object = typeof input.object === 'string' ? input.object : 'records';
      return verb(`Looking through ${object}`, `Looked through ${object}`);
    }
    case 'get_record':
      return verb('Opening a record', 'Opened a record');
    case 'get_context':
      if (input.recordId === 'me' || input.record === 'me')
        return verb('Reading your personal memory', 'Read your personal memory');
      if (input.recordId === 'workspace' || input.record === 'workspace')
        return verb("Reading the workspace's memory", "Read the workspace's memory");
      return verb('Reading what is known about a record', 'Read what is known about a record');
    case 'get_timeline':
      return verb('Reading a timeline', 'Read a timeline');
    case 'describe_schema':
      return verb('Reading how this workspace is set up', 'Read how this workspace is set up');
    case 'get_event_content':
      return verb('Reading a conversation', 'Read a conversation');
    case 'upsert_record':
      return verb('Saving a record', 'Saved a record');
    case 'log_event':
      return verb('Logging an event', 'Logged an event');
    case 'remember':
      return verb('Remembering a fact', 'Remembered a fact');
    default:
      return verb(`Using ${name}`, `Used ${name}`);
  }
}

/** Why a tool call failed, in plain words. */
export function toolErrorText(code: string) {
  switch (code) {
    case 'elevation_required':
      return 'this needs a CLI elevation';
    case 'role':
      return "your role doesn't allow it";
    case 'extension_removed':
      return 'the extension is no longer installed';
    case 'not_found':
      return 'not found';
    case 'invalid_input':
      return 'the request was not valid';
    default:
      return 'it failed';
  }
}

/** How a turn that didn't complete ended, in plain words (`data-turn-end`, agent spec §3.4). */
export const TURN_ENDINGS: Record<string, string> = {
  refused: 'The agent declined to answer this.',
  incomplete: 'The answer was cut short.',
  context_limit_reached: 'This chat is too long to continue. Start a new chat.',
  history_rejected: 'This chat can no longer continue. Start a new chat.',
  model_unavailable: 'The model is unavailable right now. Send your message again in a moment.',
  limit_reached: 'The agent reached its limit for this message or for today.',
  cancelled: 'Stopped.',
  timed_out: 'The agent ran out of time on this message.',
  failed: 'Something went wrong while answering.',
};

/** Endings after which the chat can't go on: the person starts a new one. */
export const CHAT_OVER = new Set(['context_limit_reached', 'history_rejected']);

/** The status a `data-turn-end` part carries. */
export function turnEnd(part: { type: string; data?: unknown }) {
  if (part.type !== 'data-turn-end') return undefined;
  const data = part.data as { status?: string } | undefined;
  return data?.status ?? 'failed';
}

/** The code in an error the stream request was refused with, if it carried one. */
export function errorCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  try {
    const body = JSON.parse(message) as { code?: unknown; error?: { code?: unknown } };
    if (typeof body.code === 'string') return body.code;
    if (body.error && typeof body.error.code === 'string') return body.error.code;
  } catch {
    // Not a JSON error body.
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Why a message couldn't be sent, in plain words. */
export function sendErrorText(error: unknown) {
  // The server's forward lost the agent mid-turn; the turn itself may still finish.
  if (error instanceof Error && error.message === 'connection to the agent was lost')
    return 'The connection to the agent was lost. Its answer may still finish: reload the page to see it.';
  switch (errorCode(error)) {
    case 'turn_running':
      return 'The agent is still answering your last message. Wait for it, or stop it.';
    case 'turn_stopping':
      return 'The agent is still stopping. Try again in a few seconds.';
    case 'limit_reached':
      return "You've reached today's limit for the agent. Try again tomorrow.";
    case 'agent_unavailable':
      return "The agent isn't available right now. Try again later.";
    case 'unauthorized':
    case 'not_found':
      return "This chat isn't available any more. Reload the page.";
    default:
      return "The message couldn't be sent. Check your connection and try again.";
  }
}

export type ChatStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/**
 * What the assistant's mark shows (assistant avatar spec §7): listening while
 * the person types, thinking before it acts, reading for read tools, saving for
 * writes, working while the answer streams, done when a turn ends and error
 * when one fails.
 */
export function avatarMood(input: {
  status: ChatStatus;
  messages: ChatMessage[];
  typing: boolean;
  ended: boolean;
  running: boolean;
}): LogoMood {
  const { status, messages } = input;
  if (status === 'error') return 'error';
  if (status === 'submitted') return 'thinking';
  if (status === 'streaming') {
    const last = messages.at(-1);
    const parts = last?.role === 'assistant' ? last.parts : [];
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i] as ChatPart;
      if (part.type === 'step-start' || part.type.startsWith('data-')) continue;
      if (part.type === 'reasoning') return 'thinking';
      if (part.type === 'text') return 'working';
      if (isToolPart(part)) {
        if (toolFinished(part)) return 'thinking';
        const name = toolName(part);
        if (WRITE_TOOLS.has(name)) return 'saving';
        if (READ_TOOLS.has(name)) return 'reading';
        return 'working';
      }
      return 'working';
    }
    return 'thinking';
  }
  if (input.running) return 'working';
  if (input.typing) return 'listening';
  if (input.ended) return 'done';
  return 'idle';
}

/** The words beside the mark, so the motion is never the only signal. */
export const MOOD_TEXT: Partial<Record<LogoMood, string>> = {
  thinking: 'Thinking…',
  reading: 'Reading…',
  saving: 'Saving to your workspace…',
  working: 'Writing the answer…',
};
