import { describe, expect, it } from 'vitest';
import {
  answerText,
  avatarMood,
  type ChatMessage,
  chatRequestBody,
  errorCode,
  groupTraceParts,
  hostname,
  segmentParts,
  sendErrorText,
  sourceLinks,
  stepsSummary,
  type ToolPart,
  toolError,
  toolGroupLine,
  toolLine,
  turnEnd,
  webResults,
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
  it('counts saved and failed bulk items and labels in-flight and dry-run writes', () => {
    const bulk = { type: 'tool-upsert_records', input: { items: [{}, {}] } };
    const result = (results: unknown[]) =>
      toolLine({ ...bulk, state: 'output-available', output: { results } });
    expect(result([{ id: 'a' }, { id: 'b' }])).toBe('Saved 2 records');
    expect(result([{ id: 'a' }, { error: { code: 'not_found' } }])).toBe(
      'Saved 1 record, 1 failed',
    );
    expect(result([{ error: {} }, { error: {} }])).toBe('Saved 0 records, 2 failed');
    expect(toolLine({ ...bulk, state: 'input-available' })).toBe('Saving 2 records');
    expect(toolLine({ ...bulk, state: 'output-available', output: { dryRun: true } })).toBe(
      'Would save 2 records',
    );
  });

  it('names a tool it has no words for, dynamic ones included', () => {
    expect(toolLine(tool('tool-ext_lookup'))).toBe('Using ext_lookup');
    expect(toolLine(tool('dynamic-tool', { toolName: 'ext_crm', state: 'output-available' }))).toBe(
      'Used ext_crm',
    );
  });
});

describe('groupTraceParts', () => {
  it('groups adjacent finished calls across hidden step starts, with a label for the count', () => {
    const calls = Array.from({ length: 31 }, (_, i) => ({
      type: 'tool-upsert_record',
      toolCallId: `save-${i}`,
      state: 'output-available',
    }));
    const parts = assistant(calls.flatMap((call) => [{ type: 'step-start' }, call])).parts;
    const [group] = groupTraceParts(parts);
    expect(group).toEqual({ index: 1, calls });
    if (!group || !('calls' in group)) throw new Error('expected a tool group');
    expect(toolGroupLine(group.calls)).toBe('Saved 31 records');
  });

  it('keeps different outcomes, tools and visible intervening parts apart', () => {
    const save = { type: 'tool-upsert_record', state: 'output-available' };
    const failure = { ...save, output: { error: { code: 'not_found' } } };
    const otherFailure = { ...save, output: { error: { code: 'role' } } };
    const dry = { ...save, output: { dryRun: true } };
    const running = { ...save, state: 'input-available' };
    const search = { ...save, type: 'tool-search' };
    const text = { type: 'text', text: 'Then I saved another one.' };
    const parts = assistant([
      save,
      failure,
      failure,
      otherFailure,
      dry,
      running,
      save,
      search,
      text,
      save,
    ]).parts;
    expect(groupTraceParts(parts)).toEqual([
      { index: 0, calls: [save] },
      { index: 1, calls: [failure, failure] },
      { index: 3, calls: [otherFailure] },
      { index: 4, calls: [dry] },
      { index: 5, part: running },
      { index: 6, calls: [save] },
      { index: 7, calls: [search] },
      { index: 8, part: text },
      { index: 9, calls: [save] },
    ]);
    expect(toolGroupLine([failure, failure])).toBe('Tried to save 2 records, but not found');
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

const tool = (name: string, over: Partial<ToolPart> = {}) =>
  ({ type: `tool-${name}`, toolCallId: name, state: 'output-available', ...over }) as never;

describe('segmentParts', () => {
  it('splits a reply into runs of steps and the answer between them, in order', () => {
    const parts = assistant([
      { type: 'step-start' },
      { type: 'reasoning', text: 'Look first.', state: 'done' },
      tool('search'),
      { type: 'text', text: 'Found her.' },
      { type: 'step-start' },
      tool('upsert_record'),
      { type: 'text', text: '' },
      { type: 'source-url', sourceId: 's', url: 'https://a.example' },
      { type: 'text', text: 'Saved.' },
    ]).parts;
    expect(
      segmentParts(parts).map((s) => (s.kind === 'steps' ? s.parts.length : s.part.type)),
    ).toEqual([2, 'text', 1, 'text']);
  });

  it('drops thinking that finished empty', () => {
    const parts = assistant([
      { type: 'reasoning', text: ' ', state: 'done' },
      tool('search'),
    ]).parts;
    const [run] = segmentParts(parts);
    expect(run?.kind === 'steps' && run.parts.map((p) => p.type)).toEqual(['tool-search']);
  });
});

describe('stepsSummary', () => {
  it('says what the agent did in plain words, counting saved records', () => {
    expect(stepsSummary([{ type: 'reasoning', text: 'x', state: 'done' }] as never)).toBe(
      'Thought it through',
    );
    expect(
      stepsSummary([
        tool('search'),
        tool('get_record'),
        tool('web_search'),
        tool('upsert_record'),
        tool('upsert_records', { output: { results: [{}, {}, { error: 'x' }] } }),
        tool('remember'),
      ]),
    ).toBe('Checked your workspace, searched the web, saved 3 records and took notes');
    expect(
      stepsSummary([tool('upsert_record', { state: 'output-error', errorText: 'role' })]),
    ).toBe("Tried, but it didn't work");
  });

  it('counts only calls that finished and worked', () => {
    // Stopped mid-save: the record was never written.
    expect(
      stepsSummary([tool('search'), tool('upsert_record', { state: 'input-available' })]),
    ).toBe('Checked your workspace');
    expect(stepsSummary([tool('upsert_record', { state: 'input-available' })])).toBe(
      'Stopped before finishing',
    );
    expect(
      stepsSummary([
        tool('remember', { state: 'output-error', errorText: 'x' }),
        tool('get_record'),
      ]),
    ).toBe('Checked your workspace');
    expect(
      stepsSummary([tool('upsert_record', { output: { dryRun: true } }), tool('web_search')]),
    ).toBe('Searched the web');
  });
});

describe('answerText', () => {
  it('keeps the pieces of an answer apart, as they show between steps', () => {
    const message = assistant([
      { type: 'text', text: "I'll check." },
      tool('search'),
      { type: 'text', text: '' },
      { type: 'text', text: 'Found it.' },
    ]);
    expect(answerText(message)).toBe("I'll check.\n\nFound it.");
  });
});

describe('web results and sources', () => {
  it('takes each page a web search found once, with http links only', () => {
    const part = tool('web_search', {
      output: [
        { type: 'web_search_result', url: 'https://www.acme.com/about', title: 'About' },
        { url: 'https://www.acme.com/about' },
        { url: 'javascript:alert(1)' },
        { url: 'https://news.example/acme', title: ' ' },
      ],
    });
    expect(webResults(part)).toEqual([
      { url: 'https://www.acme.com/about', title: 'About' },
      { url: 'https://news.example/acme', title: undefined },
    ]);
    expect(webResults(tool('search', { output: [{ url: 'https://a.example' }] }))).toEqual([]);
    expect(hostname('https://www.acme.com/about')).toBe('acme.com');
    expect(hostname('not a url')).toBe('not a url');
  });

  it('lists the links a reply used once each', () => {
    const parts = assistant([
      { type: 'source-url', sourceId: '1', url: 'https://a.example', title: 'A' },
      { type: 'source-url', sourceId: '2', url: 'https://a.example' },
      { type: 'source-url', sourceId: '3', url: 'https://b.example' },
    ]).parts;
    expect(sourceLinks(parts)).toEqual([
      { url: 'https://a.example', title: 'A' },
      { url: 'https://b.example', title: undefined },
    ]);
  });
});
