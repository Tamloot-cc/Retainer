import { describe, expect, it } from 'vitest';
import { withTurnEndings } from '../src/history.js';

const user = (id: string) => ({ id, role: 'user', parts: [{ type: 'text', text: id }] });
const agent = (id: string) => ({ id, role: 'assistant', parts: [{ type: 'text', text: id }] });
const end = (status: string) => ({ type: 'data-turn-end', data: { status, code: null } });

describe('withTurnEndings', () => {
  it("adds an ending to the turn's last assistant message, before the next person's message", () => {
    const out = withTurnEndings(
      [user('u1'), agent('a1'), agent('a2'), user('u2'), agent('a3')],
      [{ messageId: 'u1', status: 'incomplete', code: null }],
    );
    expect(out.map((m) => [m.id, m.parts.length])).toEqual([
      ['u1', 1],
      ['a1', 1],
      ['a2', 2],
      ['u2', 1],
      ['a3', 1],
    ]);
    expect(out[2]?.parts[1]).toEqual(end('incomplete'));
  });

  it('gives a turn that saved no answer an assistant message of its own, last turn included', () => {
    const out = withTurnEndings(
      [user('u1'), user('u2')],
      [
        { messageId: 'u1', status: 'cancelled', code: null },
        { messageId: 'u2', status: 'timed_out', code: null },
      ],
    );
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(out[1]?.parts).toEqual([end('cancelled')]);
    expect(out[3]?.parts).toEqual([end('timed_out')]);
  });

  it("leaves out an ending whose message was never saved, and doesn't change its input", () => {
    const messages = [user('u1'), agent('a1')];
    const out = withTurnEndings(messages, [{ messageId: 'lost', status: 'failed', code: null }]);
    expect(out).toEqual(messages);
    const placed = withTurnEndings(messages, [{ messageId: 'u1', status: 'refused', code: null }]);
    expect(placed[1]?.parts).toHaveLength(2);
    expect(messages[1]?.parts).toHaveLength(1);
  });
});
