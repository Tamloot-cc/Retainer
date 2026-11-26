import { describe, expect, it } from 'vitest';
import {
  avatarMood,
  type ChatMessage,
  chatRequestBody,
  errorCode,
  sendErrorText,
  type ToolPart,
  toolError,
  toolLine,
  turnEnd,
} from './model.js';

const assistant = (parts: unknown[]): ChatMessage =>
  ({ id: 'a', role: 'assistant', parts }) as ChatMessage;
const mood = (over: Partial<Parameters<typeof avatarMood>[0]>) =>
  avatarMood({
    status: 'ready',
    messages: [],
    typing: false,
    ended: false,
    running: false,
    ...over,
  });

describe('chatRequestBody', () => {
  it('is exactly one text part, the only shape the runtime takes', () => {
    expect(chatRequestBody('Who is Dana?')).toEqual({
      message: { parts: [{ type: 'text', text: 'Who is Dana?' }] },
    });
  });
});

describe('toolLine', () => {
  const tool = (type: string, over: Partial<ToolPart> = {}): ToolPart => ({
    type,
    state: 'input-available',
    ...over,
  });
  it('says what a call is doing, then what it did', () => {
    expect(toolLine(tool('tool-search', { input: { query: 'Acme' } }))).toBe(
      'Searching for “Acme”',
    );
    expect(
      toolLine(tool('tool-search', { input: { query: 'Acme' }, state: 'output-available' })),
    ).toBe('Searched for “Acme”');
    expect(toolLine(tool('tool-web_search', { input: { query: 'Acme funding' } }))).toBe(
      'Searching the web for “Acme funding”',
    );
    expect(toolLine(tool('tool-upsert_record', { state: 'output-available' }))).toBe(
      'Saved a record',
    );
    expect(toolLine(tool('tool-get_context', { input: { recordId: 'me' } }))).toBe(
      'Reading your personal memory',
    );
  });
  it('names a tool it has no words for, dynamic ones included', () => {
    expect(toolLine(tool('tool-ext_lookup'))).toBe('Using ext_lookup');
    expect(toolLine(tool('dynamic-tool', { toolName: 'ext_crm', state: 'output-available' }))).toBe(
      'Used ext_crm',
    );
  });
});

describe('toolError', () => {
  it('reads an error result and a thrown error, and nothing from a success', () => {
    expect(
      toolError({
        type: 'tool-upsert_record',
        state: 'output-available',
        output: { ok: false, error: { code: 'role' } },
      }),
    ).toBe('role');
    expect(toolError({ type: 'tool-search', state: 'output-error', errorText: 'boom' })).toBe(
      'boom',
    );
    expect(
      toolError({ type: 'tool-search', state: 'output-available', output: { results: [] } }),
    ).toBeUndefined();
  });
});

describe('avatarMood', () => {
  it('thinks while waiting and while reasoning', () => {
    expect(mood({ status: 'submitted' })).toBe('thinking');
    expect(
      mood({ status: 'streaming', messages: [assistant([{ type: 'reasoning', text: '' }])] }),
    ).toBe('thinking');
  });
  it('reads for read tools, saves for writes and works while the answer streams', () => {
    const streaming = (part: unknown) =>
      mood({ status: 'streaming', messages: [assistant([part])] });
    expect(streaming({ type: 'tool-search', state: 'input-available' })).toBe('reading');
    expect(streaming({ type: 'tool-remember', state: 'input-streaming' })).toBe('saving');
    expect(streaming({ type: 'text', text: 'Dana is…' })).toBe('working');
    expect(streaming({ type: 'tool-search', state: 'output-available' })).toBe('thinking');
  });
  it('skips step markers and data parts to find what is happening', () => {
    expect(
      mood({
        status: 'streaming',
        messages: [assistant([{ type: 'text', text: 'x' }, { type: 'step-start' }])],
      }),
    ).toBe('working');
  });
  it('listens while the person types, and marks a finished or failed turn', () => {
    expect(mood({ typing: true })).toBe('listening');
    expect(mood({ ended: true })).toBe('done');
    expect(mood({ status: 'error' })).toBe('error');
    expect(mood({ running: true })).toBe('working');
    expect(mood({})).toBe('idle');
  });
});

describe('errors in plain words', () => {
  it("reads the code from the runtime's JSON body", () => {
    expect(errorCode(new Error('{"code":"turn_running"}'))).toBe('turn_running');
    expect(errorCode(new Error('{"error":{"code":"limit_reached"}}'))).toBe('limit_reached');
    expect(errorCode(new Error('Failed to fetch'))).toBeUndefined();
  });
  it('explains each refusal', () => {
    expect(sendErrorText(new Error('{"code":"turn_stopping"}'))).toMatch(/still stopping/);
    expect(sendErrorText(new Error('{"code":"limit_reached"}'))).toMatch(/today's limit/);
    expect(sendErrorText(new Error('Failed to fetch'))).toMatch(/couldn't be sent/);
    expect(sendErrorText(new Error('connection to the agent was lost'))).toMatch(/reload the page/);
  });
  it('reads how a turn ended', () => {
    expect(turnEnd({ type: 'data-turn-end', data: { status: 'context_limit_reached' } })).toBe(
      'context_limit_reached',
    );
    expect(turnEnd({ type: 'text' })).toBeUndefined();
  });
});
