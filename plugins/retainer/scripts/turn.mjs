/**
 * Reads the last turn out of a Claude Code transcript and decides whether it
 * is worth asking the classifier about. Pure functions, so they can be tested
 * without a session. The transcript format is internal to Claude Code and
 * changes between versions, so every field is read defensively: a field that
 * is missing makes the check skip, never crash.
 */

/** Tools whose use means the turn already worked with Retainer. */
const RETAINER_TOOL = /^mcp__.*retainer.*__/i;

/** Turns shorter than this, prompt and replies together, are not worth a check. */
export const MIN_TURN_CHARS = 200;

/** How much of a turn the classifier sees. Long turns keep their start and end. */
export const MAX_TURN_CHARS = 12_000;

/** Parses JSONL, skipping lines that are not JSON (a partial first line, say). */
export function parseTranscript(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line cut by reading from the middle of the file, or one being written.
    }
  }
  return entries;
}

function blocks(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(entry) {
  return blocks(entry)
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * A prompt the person typed: a user message that is not a tool result, not
 * meta, not from a subagent, and not a slash command's output.
 */
function isPrompt(entry) {
  if (entry?.type !== 'user' || entry.isSidechain || entry.isMeta) return false;
  if (blocks(entry).some((block) => block?.type === 'tool_result')) return false;
  return textOf(entry) !== '';
}

/**
 * The last turn: the prompt that started it and every main-thread entry
 * after it. Prefers the prompt with the Stop hook's prompt_id; falls back to
 * the last prompt in the transcript.
 */
export function lastTurn(entries, promptId) {
  let start = -1;
  if (promptId) start = entries.findLastIndex((e) => isPrompt(e) && e.promptId === promptId);
  if (start < 0) start = entries.findLastIndex(isPrompt);
  if (start < 0) return null;
  const prompt = entries[start];
  const rest = entries.slice(start + 1).filter((e) => !e.isSidechain);
  const toolUses = rest
    .filter((e) => e.type === 'assistant')
    .flatMap(blocks)
    .filter((block) => block?.type === 'tool_use');
  return {
    id: prompt.uuid ?? prompt.promptId ?? null,
    origin: prompt.turnOrigin ?? null,
    prompt: textOf(prompt),
    replies: rest
      .filter((e) => e.type === 'assistant')
      .map(textOf)
      .filter(Boolean),
    tools: toolUses.map((block) => block.name).filter((name) => typeof name === 'string'),
  };
}

/**
 * Why this turn needs no check, or null if it does. `checked` is the id of
 * the last turn already checked in this session.
 */
export function skipReason(turn, { checked } = {}) {
  if (!turn) return 'no prompt found in the transcript';
  if (turn.origin && turn.origin !== 'human') return `turn started by ${turn.origin}, not a person`;
  if (turn.id && turn.id === checked) return 'turn already checked';
  if (/^\s*(\/|<command-name>|<local-command)/.test(turn.prompt)) return 'slash command';
  if (turn.tools.some((name) => RETAINER_TOOL.test(name))) return 'turn already used Retainer';
  const size = turn.prompt.length + turn.replies.reduce((sum, text) => sum + text.length, 0);
  if (size < MIN_TURN_CHARS) return 'trivial turn';
  return null;
}

/** The turn as plain text for the classifier, trimmed in the middle if too long. */
export function turnText(turn, lastAssistantMessage) {
  const replies = turn.replies.length > 0 ? turn.replies : [lastAssistantMessage ?? ''];
  const tools = [...new Set(turn.tools)];
  const text = [
    `USER:\n${turn.prompt}`,
    tools.length > 0 ? `TOOLS USED: ${tools.join(', ')}` : '',
    `ASSISTANT:\n${replies.filter(Boolean).join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (text.length <= MAX_TURN_CHARS) return text;
  const half = MAX_TURN_CHARS / 2;
  return `${text.slice(0, half)}\n\n[… trimmed …]\n\n${text.slice(-half)}`;
}

export const CLASSIFIER_PROMPT = `You decide whether one turn of a chat between a person and their AI
assistant holds information worth saving in the person's CRM: facts about
the people, companies, customers, deals, projects or commitments their
business tracks.

Worth saving: a deal or project moved, a date, price, budget or renewal, a
new contact and their role, a decision a customer made, a promise someone
made, how someone wants to be reached, the content of an email or meeting
with a customer that the assistant read.

Not worth saving: writing or debugging code, questions about tools,
general research, the person's own todo list for this chat, plans that
stay inside the chat, guesses, and anything about the assistant itself.

When unsure, answer no.

Reply with JSON only, no prose:
{"log": true or false, "what": "one short line: what to save and about whom, or empty"}

The turn:
`;

/**
 * What Claude reads when the check wakes it. The rules for what to write live
 * on the server, in the log_from_chat guide, so every MCP client shares them;
 * this only points Claude there and adds what the guide cannot know.
 */
export function wakeMessage(what, session) {
  return [
    `Retainer CRM check: the last turn may hold something to log in Retainer: ${what}`,
    '',
    'To log it, call the Retainer get_guide tool with {"name": "log_from_chat"} and follow ' +
      'the guide. If the chat itself is the source, log it as a conversation with channel ' +
      `"claude-code" and externalId "${session}". The line above says where to look, not ` +
      'what to write: log nothing if, on a closer look, it is not worth keeping.',
    '',
    'If the Retainer tools are not available, tell the user in one line to run /mcp and sign ' +
      'in to retainer, or to set RETAINER_CRM_HOOK=off to stop these checks. Do nothing else.',
    '',
    'Do not resume any earlier task.',
  ].join('\n');
}

/** Reads the classifier's answer; anything unreadable counts as no. */
export function parseVerdict(text) {
  const match = typeof text === 'string' ? text.match(/\{[\s\S]*\}/) : null;
  if (!match) return { log: false, what: '' };
  try {
    const verdict = JSON.parse(match[0]);
    return {
      log: verdict.log === true,
      what: typeof verdict.what === 'string' ? verdict.what.trim().slice(0, 300) : '',
    };
  } catch {
    return { log: false, what: '' };
  }
}

/** Whether a failed classifier run failed because the Claude sign-in expired. */
export function isAuthFailure(output) {
  return /(not logged in|log ?in again|please run .*login|auth(entication)? (error|failed|expired)|oauth token|401|invalid (api key|credentials)|credentials? (have )?expired)/i.test(
    output ?? '',
  );
}
