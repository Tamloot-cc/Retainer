import { describe, expect, it } from 'vitest';
import { uuidv7 } from './proxy.js';
import { UsageMeter } from './usage.js';

const encode = (text: string) => new TextEncoder().encode(text);
const sse = (type: string, data: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = sse('message_start', {
  message: {
    id: 'msg_1',
    model: 'claude-opus-5-5',
    content: [],
    usage: {
      input_tokens: 40,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2,
      output_tokens: 1,
    },
  },
});
const delta = sse('message_delta', {
  delta: { stop_reason: 'end_turn' },
  usage: { output_tokens: 90, server_tool_use: { web_search_requests: 1 } },
});
const stop = sse('message_stop', {});

describe('UsageMeter (model calls spec 3.4)', () => {
  it('reads a non-streamed response, in pieces', () => {
    const meter = new UsageMeter(false);
    const body = JSON.stringify({
      model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: 'secret content' }],
      usage: { input_tokens: 10, output_tokens: 3, speed: 'standard' },
    });
    meter.push(encode(body.slice(0, 7)));
    meter.push(encode(body.slice(7)));
    meter.end();
    const report = meter.report('00000000-0000-4000-8000-000000000001', 'req_1', false);
    expect(report).toMatchObject({
      model: 'claude-haiku-5-5',
      providerRequestId: 'req_1',
      partial: false,
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      usage: { input_tokens: 10, output_tokens: 3, speed: 'standard' },
    });
    expect(JSON.stringify(report)).not.toContain('secret content');
  });

  it('reads a stream across chunk boundaries, with the final counts from message_delta', () => {
    const meter = new UsageMeter(true);
    const text = start + sse('content_block_delta', { delta: { text: 'secret' } }) + delta + stop;
    for (let i = 0; i < text.length; i += 7) meter.push(encode(text.slice(i, i + 7)));
    meter.end();
    expect(meter.report('00000000-0000-4000-8000-000000000001', null, false)).toMatchObject({
      model: 'claude-opus-5-5',
      partial: false,
      inputTokens: 40,
      outputTokens: 90,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      usage: { server_tool_use: { web_search_requests: 1 } },
    });
  });

  it('marks a stream cut before its final event as partial, with what it saw', () => {
    const meter = new UsageMeter(true);
    meter.push(encode(start));
    expect(meter.report('00000000-0000-4000-8000-000000000001', null, true)).toMatchObject({
      partial: true,
      inputTokens: 40,
      outputTokens: 1,
    });
    const ended = new UsageMeter(true);
    ended.push(encode(start + delta));
    ended.end();
    expect(ended.report('00000000-0000-4000-8000-000000000001', null, false)?.partial).toBe(true);
  });

  it('records nothing when no model was named', () => {
    const meter = new UsageMeter(true);
    meter.push(encode('event: ping\ndata: {"type":"ping"}\n\n'));
    expect(meter.report('00000000-0000-4000-8000-000000000001', null, true)).toBeUndefined();
    const json = new UsageMeter(false);
    json.push(encode('not json'));
    json.end();
    expect(json.report('00000000-0000-4000-8000-000000000001', null, false)).toBeUndefined();
  });
});

describe('uuidv7', () => {
  it('makes version 7 IDs ordered by time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});
