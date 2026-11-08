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

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null; // A line cut by reading from the middle of the file, or one being written.
  }
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
 * The last turn in a transcript's JSONL text: the prompt that started it and
 * the main-thread replies after it. Walks back from the end and parses only
 * as far as the prompt with the Stop hook's prompt_id, or without one, the
 * last prompt; falls back to the last prompt if that id is not found.
 */
export function lastTurn(text, promptId) {
  const lines = text.split('\n');
  // Replies seen since the last prompt passed, walking back: they belong to the next prompt.
  let replies = [];
  let found = null;
  let latest = null;
  for (let i = lines.length - 1; i >= 0 && !found; i--) {
    const entry = parseLine(lines[i]);
    if (!isPrompt(entry)) {
      if (entry?.type === 'assistant' && !entry.isSidechain) replies.push(entry);
      continue;
    }
    const turn = { prompt: entry, assistant: replies.reverse() };
    replies = [];
    latest ??= turn;
    if (!promptId || entry.promptId === promptId) found = turn;
  }
  const { prompt, assistant } = found ?? latest ?? {};
  if (!prompt) return null;
  return {
    id: prompt.promptId ?? prompt.uuid ?? null,
    origin: prompt.turnOrigin ?? null,
    prompt: textOf(prompt),
    replies: assistant.map(textOf).filter(Boolean),
    tools: assistant
      .flatMap(blocks)
      .filter((block) => block?.type === 'tool_use' && typeof block.name === 'string')
      .map((block) => block.name),
  };
}

/** A prompt a person typed, not one a task notification or the hook itself started. */
const isHumanPrompt = (entry) =>
  isPrompt(entry) && (!entry.turnOrigin || entry.turnOrigin === 'human');

/**
 * How many prompts the person has typed since the turn with this id, or null
 * if that turn is no longer in the text. The check runs in the background,
 * so the person may have moved on by the time it wakes Claude.
 */
export function promptsAfter(text, turnId) {
  let count = 0;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseLine(lines[i]);
    if (!isPrompt(entry)) continue;
    if ((entry.promptId ?? entry.uuid) === turnId) return count;
    if (isHumanPrompt(entry)) count++;
  }
  return null;
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

/**
 * The turn with the Stop hook's last_assistant_message as its final reply.
 * The transcript is written asynchronously and may not hold that reply yet,
 * so the hook's copy is the one to trust.
 */
export function withFinalReply(turn, lastAssistantMessage) {
  const final = typeof lastAssistantMessage === 'string' ? lastAssistantMessage.trim() : '';
  if (!turn || !final || turn.replies.at(-1) === final) return turn;
  return { ...turn, replies: [...turn.replies, final] };
}

/** The turn as plain text for the classifier, trimmed in the middle if too long. */
export function turnText(turn) {
  const { replies } = turn;
  const tools = [...new Set(turn.tools)];
  const text = [
    `USER:\n${turn.prompt}`,
    tools.length > 0 ? `TOOLS USED: ${tools.join(', ')}` : '',
    `ASSISTANT:\n${replies.join('\n\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (text.length <= MAX_TURN_CHARS) return text;
  const half = MAX_TURN_CHARS / 2;
  return `${text.slice(0, half)}\n\n[… trimmed …]\n\n${text.slice(-half)}`;
}

/**
 * The classifier's system prompt. Its idea of what is worth saving is a
 * coarse filter; the precise rules are in the server's log_from_chat guide,
 * which Claude reads before writing anything. Keep the two in step.
 */
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

The user message is the turn. Reply with JSON only, no prose:
{"log": true or false, "what": "one short line: what to save and about whom, or empty"}`;

/** Keeps an ID to the characters IDs use, so it cannot carry text into the message. */
const safeId = (id) => String(id).replace(/[^\w.:-]/g, '');

/**
 * What Claude reads when the check wakes it, delivered as a system reminder.
 * It is static apart from the IDs Claude Code gave the hook: the classifier's
 * own words stay in the log, because a turn that quotes a customer's email
 * could steer them. The rules for what to write live on the server, in the
 * log_from_chat guide; this only points Claude there and adds what the guide
 * cannot know.
 */
export function wakeMessage(session, turnId, later = 0) {
  const which =
    later === 0
      ? 'The last turn of this chat'
      : later === null
        ? 'A recent turn of this chat'
        : `The turn your user started ${later} message${later === 1 ? '' : 's'} before their latest one`;
  return [
    `Retainer CRM check: ${which} may hold something worth logging in Retainer, about a ` +
      'person, company or piece of work the CRM tracks. Read that turn again yourself to ' +
      'find it, and log only what it holds.',
    '',
    'To log it, call the Retainer get_guide tool with {"name": "log_from_chat"} and follow ' +
      'the guide. If the chat itself is the source, log it as a conversation with channel ' +
      `"claude-code" and externalId "${safeId(session)}:${safeId(turnId)}".`,
    '',
    'If the Retainer tools are not available, tell the user in one line to run /mcp and sign ' +
      'in to retainer, or to set RETAINER_CRM_HOOK=off to stop these checks. Do nothing else.',
    '',
    'Do not resume any earlier task.',
  ].join('\n');
}

const NO = Object.freeze({ log: false, what: '' });

/** Reads the classifier's answer; anything unreadable counts as no. */
export function parseVerdict(text) {
  const match = typeof text === 'string' ? text.match(/\{[\s\S]*\}/) : null;
  if (!match) return NO;
  try {
    const verdict = JSON.parse(match[0]);
    return {
      log: verdict.log === true,
      what: typeof verdict.what === 'string' ? verdict.what.trim().slice(0, 300) : '',
    };
  } catch {
    return NO;
  }
}

/** Whether a failed classifier run failed because the Claude sign-in expired. */
export function isAuthFailure(output) {
  return /(not logged in|log ?in again|please run .*login|auth(entication)? (error|failed|expired)|oauth token|401|invalid (api key|credentials)|credentials? (have )?expired)/i.test(
    output ?? '',
  );
}
