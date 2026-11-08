import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isAuthFailure,
  lastTurn,
  MAX_TURN_CHARS,
  parseVerdict,
  skipReason,
  turnText,
  wakeMessage,
  withFinalReply,
} from './turn.mjs';

const long = 'Dana from Acme said they will renew in March, at the same price. '.repeat(4);

function prompt(text, extra = {}) {
  return {
    type: 'user',
    message: { content: text },
    ...extra,
  };
}
function reply(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}
function toolUse(name) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, input: {} }] } };
}
function toolResult() {
  return { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };
}

/** A transcript's JSONL text, as the hook reads it. */
const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join('\n');

describe('lastTurn', () => {
  it('starts at the last prompt and collects replies and tools, not tool results', () => {
    const turn = lastTurn(
      jsonl(
        prompt('first'),
        reply('old reply'),
        prompt('second', { promptId: 'p2', turnOrigin: 'human' }),
        toolUse('mcp__gmail__search'),
        toolResult(),
        reply('Found it.'),
      ),
    );
    assert.equal(turn.prompt, 'second');
    assert.equal(turn.id, 'p2');
    assert.equal(turn.origin, 'human');
    assert.deepEqual(turn.replies, ['Found it.']);
    assert.deepEqual(turn.tools, ['mcp__gmail__search']);
  });

  it('skips lines that are not JSON, such as a line cut by reading the tail', () => {
    const text = `{"type":"use\n${jsonl(prompt('hi', { promptId: 'p1' }), reply('yo'))}\n{"type":"assi`;
    const turn = lastTurn(text);
    assert.equal(turn.id, 'p1');
    assert.deepEqual(turn.replies, ['yo']);
  });

  it("prefers the Stop hook's prompt_id, and falls back to the last prompt", () => {
    const text = jsonl(
      prompt('wanted', { promptId: 'a' }),
      reply('r'),
      prompt('later', { promptId: 'b' }),
    );
    assert.equal(lastTurn(text, 'a').prompt, 'wanted');
    assert.equal(lastTurn(text, 'missing').prompt, 'later');
  });

  it('ignores meta messages, subagent entries and prompts made of blocks without text', () => {
    const turn = lastTurn(
      jsonl(
        prompt('real', { promptId: 'pr' }),
        prompt('caveat', { isMeta: true }),
        prompt('from a subagent', { isSidechain: true }),
        { type: 'user', message: { content: [{ type: 'image' }] } },
        { ...reply('subagent reply'), isSidechain: true },
      ),
    );
    assert.equal(turn.id, 'pr');
    assert.deepEqual(turn.replies, []);
  });

  it('returns null when there is no prompt', () => {
    assert.equal(lastTurn(jsonl(reply('x'))), null);
  });
});

describe('skipReason', () => {
  const turn = (over = {}) => ({
    id: 'u1',
    origin: 'human',
    prompt: long,
    replies: ['ok'],
    tools: [],
    ...over,
  });

  it('checks a long human turn that has not used Retainer', () => {
    assert.equal(skipReason(turn()), null);
    assert.equal(skipReason(turn({ origin: null })), null);
  });

  it('skips turns a person did not start, such as task notifications and its own wake-up', () => {
    assert.match(skipReason(turn({ origin: 'task_notification' })), /not a person/);
    assert.match(skipReason(turn({ origin: 'sdk' })), /not a person/);
  });

  it('skips a turn it already checked, slash commands, and short turns', () => {
    assert.match(skipReason(turn(), { checked: 'u1' }), /already checked/);
    assert.match(skipReason(turn({ prompt: '/mcp' })), /slash command/);
    assert.match(skipReason(turn({ prompt: '<command-name>/clear</command-name>' })), /slash/);
    assert.match(skipReason(turn({ prompt: 'thanks', replies: ['sure'] })), /trivial/);
  });

  it('skips a turn that already used any Retainer server, however it was added', () => {
    for (const name of [
      'mcp__retainer__log_event',
      'mcp__plugin_retainer_retainer__upsert_record',
      'mcp__claude_ai_Retainer__search',
    ]) {
      assert.match(skipReason(turn({ tools: ['Read', name] })), /already used Retainer/);
    }
    assert.equal(skipReason(turn({ tools: ['mcp__gmail__search'] })), null);
  });
});

describe('withFinalReply', () => {
  const turn = { prompt: 'p', replies: ['Looking at the inbox.'], tools: [] };

  it('adds the final reply the transcript has not caught up with', () => {
    assert.deepEqual(withFinalReply(turn, ' Acme renews in March. ').replies, [
      'Looking at the inbox.',
      'Acme renews in March.',
    ]);
  });

  it('does not repeat a final reply the transcript already has, and leaves null alone', () => {
    assert.equal(withFinalReply(turn, 'Looking at the inbox.'), turn);
    assert.equal(withFinalReply(turn, undefined), turn);
    assert.equal(withFinalReply(null, 'x'), null);
  });
});

describe('turnText', () => {
  it('falls back to last_assistant_message when the transcript has no reply yet', () => {
    const text = turnText(withFinalReply({ prompt: 'p', replies: [], tools: [] }, 'final answer'));
    assert.match(text, /ASSISTANT:\nfinal answer/);
  });

  it('keeps the start and end of a long turn', () => {
    const text = turnText({ prompt: `START${'x'.repeat(30_000)}`, replies: ['END'], tools: [] });
    assert.ok(text.length < MAX_TURN_CHARS + 50);
    assert.match(text, /START/);
    assert.match(text, /END$/);
    assert.match(text, /trimmed/);
  });
});

describe('parseVerdict', () => {
  it('reads the JSON answer, even wrapped in prose or a code fence', () => {
    assert.deepEqual(parseVerdict('```json\n{"log": true, "what": "Acme renews in March"}\n```'), {
      log: true,
      what: 'Acme renews in March',
    });
  });

  it('treats anything unreadable as no', () => {
    assert.deepEqual(parseVerdict('yes'), { log: false, what: '' });
    assert.deepEqual(parseVerdict('{"log": "yes"}'), { log: false, what: '' });
    assert.deepEqual(parseVerdict(undefined), { log: false, what: '' });
  });
});

describe('isAuthFailure', () => {
  it('recognizes an expired sign-in but not other failures', () => {
    assert.ok(isAuthFailure('Invalid API key · Please run /login'));
    assert.ok(isAuthFailure('OAuth token has expired. Please log in again.'));
    assert.ok(isAuthFailure('API Error: 401 {"type":"authentication_error"}'));
    assert.ok(!isAuthFailure('spawn claude ENOENT'));
    assert.ok(!isAuthFailure('API Error: 529 overloaded'));
  });
});

describe('wakeMessage', () => {
  it("points Claude at the server's guide, with the chat's channel and session ID", () => {
    const text = wakeMessage('Acme renews in March', 'session-123', 'p7');
    assert.match(text, /Acme renews in March/);
    assert.match(text, /get_guide tool with \{"name": "log_from_chat"\}/);
    assert.match(text, /channel\s+"claude-code" and externalId "session-123:p7"/);
    assert.match(text, /run \/mcp/);
    assert.match(text, /RETAINER_CRM_HOOK=off/);
  });
});
