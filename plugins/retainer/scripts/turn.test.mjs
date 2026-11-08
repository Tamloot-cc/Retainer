import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isAuthFailure,
  lastTurn,
  MAX_TURN_CHARS,
  parseTranscript,
  parseVerdict,
  skipReason,
  turnText,
} from './turn.mjs';

const long = 'Dana from Acme said they will renew in March, at the same price. '.repeat(4);

function prompt(text, extra = {}) {
  return {
    type: 'user',
    uuid: `u-${text.length}`,
    promptId: 'p1',
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

describe('parseTranscript', () => {
  it('skips lines that are not JSON, such as a line cut by reading the tail', () => {
    const text = `{"type":"use\n${JSON.stringify(prompt('hi'))}\n\n${JSON.stringify(reply('yo'))}\n`;
    assert.deepEqual(
      parseTranscript(text).map((e) => e.type),
      ['user', 'assistant'],
    );
  });
});

describe('lastTurn', () => {
  it('starts at the last prompt and collects replies and tools, not tool results', () => {
    const turn = lastTurn([
      prompt('first'),
      reply('old reply'),
      prompt('second', { uuid: 'u2', turnOrigin: 'human' }),
      toolUse('mcp__gmail__search'),
      toolResult(),
      reply('Found it.'),
    ]);
    assert.equal(turn.prompt, 'second');
    assert.equal(turn.id, 'u2');
    assert.equal(turn.origin, 'human');
    assert.deepEqual(turn.replies, ['Found it.']);
    assert.deepEqual(turn.tools, ['mcp__gmail__search']);
  });

  it("prefers the Stop hook's prompt_id", () => {
    const turn = lastTurn(
      [
        prompt('wanted', { promptId: 'a', uuid: 'ua' }),
        reply('r'),
        prompt('later', { promptId: 'b' }),
      ],
      'a',
    );
    assert.equal(turn.id, 'ua');
  });

  it('ignores meta messages, subagent entries and prompts made of blocks without text', () => {
    const turn = lastTurn([
      prompt('real', { uuid: 'ur' }),
      prompt('caveat', { isMeta: true }),
      prompt('from a subagent', { isSidechain: true }),
      { type: 'user', message: { content: [{ type: 'image' }] } },
      { ...reply('subagent reply'), isSidechain: true },
    ]);
    assert.equal(turn.id, 'ur');
    assert.deepEqual(turn.replies, []);
  });

  it('returns null when there is no prompt', () => {
    assert.equal(lastTurn([reply('x')]), null);
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

describe('turnText', () => {
  it('falls back to last_assistant_message when the transcript has no reply yet', () => {
    const text = turnText({ prompt: 'p', replies: [], tools: [] }, 'final answer');
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
