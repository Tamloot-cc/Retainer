import type { UIMessage } from 'ai';
import type { LogoMood } from '../../ui/index.js';

/** A message as the chat shows it: the AI SDK's UI message (agent spec §6.1). */
export type ChatMessage = UIMessage;
export type ChatPart = ChatMessage['parts'][number];

/** The only request body the agent runtime takes (agent spec §6.1). */
export function chatRequestBody(text: string) {
  return { message: { parts: [{ type: 'text' as const, text }] } };
}

/**
 * An answer's text for copying: its text parts, kept apart as paragraphs as
 * they are on screen (steps can sit between them).
 */
export function answerText(message: Pick<ChatMessage, 'parts'>) {
  return message.parts
    .flatMap((part) => (part.type === 'text' && part.text.trim() ? [part.text.trim()] : []))
    .join('\n\n');
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
const WRITE_TOOLS = new Set(['upsert_record', 'upsert_records', 'log_event', 'remember']);

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

function dryRun(part: ToolPart) {
  return (part.output as { dryRun?: boolean } | undefined)?.dryRun === true;
}

function upsertCounts(part: ToolPart) {
  if (part.state !== 'output-available') return undefined;
  const { results } = (part.output ?? {}) as { results?: unknown };
  if (!Array.isArray(results)) return undefined;
  const failed = results.filter(
    (item) => item && typeof item === 'object' && 'error' in item,
  ).length;
  return { saved: results.length - failed, failed };
}

const records = (count: number) => `${count} ${count === 1 ? 'record' : 'records'}`;

function savedRecords(saved: number, failed: number) {
  return `Saved ${records(saved)}${failed ? `, ${failed} failed` : ''}`;
}

function bulkToolLine(part: ToolPart) {
  const counts = upsertCounts(part);
  if (counts) return savedRecords(counts.saved, counts.failed);
  const { items } = inputOf(part);
  const label = Array.isArray(items) ? records(items.length) : 'records';
  if (dryRun(part)) return `Would save ${label}`;
  return toolFinished(part) ? `Tried to save ${label}` : `Saving ${label}`;
}

type ToolRun = [ToolPart, ...ToolPart[]];
type TracePart = { index: number; part: ChatPart } | { index: number; calls: ToolRun };

function outcome(part: ToolPart) {
  const error = toolError(part);
  if (error !== undefined) return `error:${error}`;
  if (dryRun(part)) return 'dry_run';
  if (toolName(part) === 'upsert_records') {
    const counts = upsertCounts(part);
    if (!counts) return 'unknown';
    if (counts.failed) return counts.saved ? 'partial' : 'failed';
  }
  return 'success';
}

/** Groups finished, adjacent calls in the displayed trace, leaving streaming calls in place. */
export function groupTraceParts(parts: ChatPart[]): TracePart[] {
  const trace: TracePart[] = [];
  let previous: { name: string; outcome: string; calls: ToolRun } | undefined;
  for (const [index, part] of parts.entries()) {
    // Step boundaries are wire metadata and don't appear in the trace.
    if (part.type === 'step-start') continue;
    if (!isToolPart(part) || !toolFinished(part)) {
      trace.push({ index, part });
      previous = undefined;
      continue;
    }
    const name = toolName(part);
    const key = outcome(part);
    if (previous?.name === name && previous.outcome === key) {
      previous.calls.push(part);
    } else {
      const calls: ToolRun = [part];
      trace.push({ index, calls });
      previous = { name, outcome: key, calls };
    }
  }
  return trace;
}

export function toolGroupLine(calls: ToolRun) {
  const [first] = calls;
  const name = toolName(first);
  const count = calls.length;
  const error = toolError(first);
  if (name === 'upsert_record' && !dryRun(first)) {
    return error
      ? `Tried to save ${records(count)}, but ${toolErrorText(error)}`
      : savedRecords(count, 0);
  }
  if (name === 'upsert_records' && upsertCounts(first)) {
    let saved = 0;
    let failed = 0;
    for (const call of calls) {
      const counts = upsertCounts(call);
      saved += counts?.saved ?? 0;
      failed += counts?.failed ?? 0;
    }
    return savedRecords(saved, failed);
  }
  const label = toolLine({ ...first, input: undefined });
  return `${label} (${count} calls)${error ? `, but ${toolErrorText(error)}` : ''}`;
}

export function toolHasFailures(part: ToolPart) {
  return (
    toolError(part) !== undefined ||
    (toolName(part) === 'upsert_records' && (upsertCounts(part)?.failed ?? 0) > 0)
  );
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
      if (dryRun(part)) return 'Would save a record';
      return verb('Saving a record', 'Saved a record');
    case 'upsert_records':
      return bulkToolLine(part);
    case 'log_event':
      return verb('Logging an event', 'Logged an event');
    case 'remember':
      return verb('Remembering a fact', 'Remembered a fact');
    default:
      return verb(`Using ${name}`, `Used ${name}`);
  }
}

/** What kind of step a tool call is, for its icon. */
export type ToolKind = 'search' | 'web' | 'read' | 'save' | 'remember' | 'other';

export function toolKind(part: ToolPart): ToolKind {
  const name = toolName(part);
  if (name === 'web_search') return 'web';
  if (name === 'search' || name === 'query_records') return 'search';
  if (name === 'remember') return 'remember';
  if (WRITE_TOOLS.has(name)) return 'save';
  if (READ_TOOLS.has(name)) return 'read';
  return 'other';
}

/** The pages a web search found: the provider's results, each with a URL. */
export function webResults(part: ToolPart): { url: string; title?: string }[] {
  if (toolName(part) !== 'web_search' || !Array.isArray(part.output)) return [];
  const seen = new Set<string>();
  return part.output.flatMap((item) => {
    const { url, title } = (item ?? {}) as { url?: unknown; title?: unknown };
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) return [];
    seen.add(url);
    return [{ url, title: typeof title === 'string' && title.trim() ? title : undefined }];
  });
}

/** A URL's site, without `www.`; the URL itself if it doesn't parse. */
export function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** The links a reply used, once each (`source-url` parts). */
export function sourceLinks(parts: ChatPart[]) {
  const seen = new Set<string>();
  return parts.flatMap((part) => {
    if (part.type !== 'source-url' || seen.has(part.url)) return [];
    seen.add(part.url);
    return [{ url: part.url, title: part.title }];
  });
}

/** A run of the agent's steps between pieces of its answer, or a piece of the answer. */
type Segment =
  | { kind: 'steps'; index: number; parts: ChatPart[] }
  | { kind: 'part'; index: number; part: ChatPart };

/**
 * Splits a reply into runs of steps (thinking and tool calls) and the parts
 * between them (text, endings), in order. Step boundaries and sources aren't
 * shown in place.
 */
export function segmentParts(parts: ChatPart[]): Segment[] {
  const segments: Segment[] = [];
  let run: Extract<Segment, { kind: 'steps' }> | undefined;
  for (const [index, part] of parts.entries()) {
    if (part.type === 'step-start' || part.type === 'source-url') continue;
    if (part.type === 'reasoning' || isToolPart(part)) {
      if (part.type === 'reasoning' && !part.text.trim() && part.state === 'done') continue;
      if (!run) {
        run = { kind: 'steps', index, parts: [] };
        segments.push(run);
      }
      run.parts.push(part);
      continue;
    }
    if (part.type === 'text' && !part.text) continue;
    run = undefined;
    segments.push({ kind: 'part', index, part });
  }
  return segments;
}

/**
 * The line a finished run of steps folds into: what the agent did, in plain
 * words. Only calls that finished and worked count; the steps inside show
 * the rest. Thinking alone is "Thought it through".
 */
export function stepsSummary(parts: ChatPart[]): string {
  const tools = parts.filter(isToolPart);
  if (tools.length === 0) return 'Thought it through';
  let read = false;
  let web = false;
  let noted = false;
  let other = false;
  let wouldSave = false;
  let saved = 0;
  for (const part of tools) {
    const name = toolName(part);
    // A routine's dry run answers writes without making them.
    if (toolFinished(part) && dryRun(part)) {
      wouldSave = true;
      continue;
    }
    // A bulk save that partly failed still saved some.
    if (name === 'upsert_records') {
      saved += upsertCounts(part)?.saved ?? 0;
      continue;
    }
    if (!toolFinished(part) || toolError(part) !== undefined) continue;
    const kind = toolKind(part);
    if (kind === 'web') web = true;
    else if (kind === 'read' || kind === 'search') read = true;
    else if (kind === 'other') other = true;
    else if (name === 'upsert_record') saved += 1;
    else noted = true;
  }
  const said: string[] = [];
  if (read) said.push('checked your workspace');
  if (web) said.push('searched the web');
  if (saved) said.push(`saved ${records(saved)}`);
  if (wouldSave) said.push('would save changes');
  if (noted) said.push('took notes');
  if (other) said.push('used other tools');
  if (said.length === 0)
    return tools.some((part) => !toolFinished(part))
      ? 'Stopped before finishing'
      : "Tried, but it didn't work";
  const text = said.join(', ').replace(/, ([^,]*)$/, ' and $1');
  return text.charAt(0).toUpperCase() + text.slice(1);
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

/** Endings worth asking again after: something went wrong, not the agent's choice. */
export const RETRYABLE = new Set([
  'incomplete',
  'model_unavailable',
  'timed_out',
  'failed',
  'cancelled',
]);

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
 * writes, working while the answer streams, stopping while cancellation settles,
 * and done or error for the outcome of a turn seen on this page.
 */
export function avatarMood(input: {
  status: ChatStatus;
  messages: ChatMessage[];
  typing: boolean;
  outcome: 'done' | 'error' | null;
  running: boolean;
  stopping: boolean;
}): LogoMood {
  const { status, messages } = input;
  if (status === 'error') return 'error';
  if (input.stopping) return 'stopping';
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
  if (input.outcome === 'error') return 'error';
  if (input.running && !input.outcome) return 'working';
  if (input.typing) return 'listening';
  return input.outcome ?? 'idle';
}

/** The words beside the mark, so the motion is never the only signal. */
export const MOOD_TEXT: Partial<Record<LogoMood, string>> = {
  thinking: 'Thinking…',
  reading: 'Reading…',
  saving: 'Saving to your workspace…',
  working: 'Writing the answer…',
  stopping: 'Stopping…',
};
