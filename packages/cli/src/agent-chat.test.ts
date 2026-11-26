import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RetainerClient } from '@retainer/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderChunk, renderState, sendMessage, sseChunks } from './agent-chat.js';

describe('rendering the agent stream', () => {
  it('dims reasoning and prints tool calls and results as short lines', () => {
    const state = renderState(false);
    const out = [
      { type: 'data-received', data: { messageId: 'm' } },
      { type: 'start' },
      { type: 'reasoning-delta', id: '0', delta: 'Let me look.' },
      { type: 'tool-input-start', toolCallId: 't1', toolName: 'search' },
      {
        type: 'tool-input-available',
        toolCallId: 't1',
        toolName: 'search',
        input: { query: 'Acme' },
      },
      { type: 'tool-output-available', toolCallId: 't1', output: { hits: [] } },
      { type: 'tool-input-available', toolCallId: 't2', toolName: 'upsert_record', input: {} },
      {
        type: 'tool-output-available',
        toolCallId: 't2',
        output: { error: { code: 'elevation_required', message: 'x' } },
      },
      { type: 'text-delta', id: 'a', delta: 'Acme ' },
      { type: 'text-delta', id: 'a', delta: 'is a customer.' },
      { type: 'finish' },
    ]
      .map((chunk) => renderChunk(state, chunk))
      .join('');
    expect(out).toBe(
      'Let me look.\n→ search {"query":"Acme"}\n← search {"hits":[]}\n→ upsert_record {}\n← upsert_record error: elevation_required\nAcme is a customer.',
    );
    expect(state.text).toBe('Acme is a customer.');
  });

  it('colours reasoning only on a terminal', () => {
    const state = renderState(true);
    expect(renderChunk(state, { type: 'reasoning-delta', delta: 'hmm' })).toBe(
      '\x1b[2mhmm\x1b[22m',
    );
  });

  it('says in plain words how a cut turn ended', () => {
    const state = renderState(false);
    expect(
      renderChunk(state, {
        type: 'data-turn-end',
        data: { status: 'context_limit_reached', code: 'context_limit_reached' },
      }),
    ).toContain('Start a new chat');
    expect(state.ended?.status).toBe('context_limit_reached');
  });

  it('reads SSE events split across reads', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"text-de'));
        controller.enqueue(encoder.encode('lta","delta":"hi"}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const chunks = [];
    for await (const chunk of sseChunks(body)) chunks.push(chunk);
    expect(chunks).toEqual([{ type: 'text-delta', delta: 'hi' }]);
  });
});

describe('sending a message', () => {
  let origin = '';
  const seen: Array<{ url: string; auth?: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
    if (req.url === '/v1/agent/chats/c1/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ token: 'st', expiresAt: '', streamUrl: `${origin}/chats/c1/stream` }),
      );
    } else if (req.url === '/v1/agent/chats/c2/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ token: 'st', expiresAt: '', streamUrl: `${origin}/chats/c2/stream` }),
      );
    } else if (req.url === '/chats/c2/stream') {
      // Cut before its `finish`.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"text-delta","id":"a","delta":"Hel"}\n\n');
    } else if (req.url === '/chats/c1/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"type":"text-delta","id":"a","delta":"Hello."}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n',
      );
    } else {
      res.writeHead(404).end();
    }
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('gets a stream token, sends only the message, and renders the answer', async () => {
    const api = new RetainerClient({ baseUrl: origin, accessToken: 'cli-token', workspace: 'w1' });
    let out = '';
    const result = await sendMessage(api, 'c1', 'Hi', { write: (t) => (out += t), color: false });
    expect(result).toEqual({ status: 'completed', code: null, text: 'Hello.' });
    expect(out).toBe('Hello.\n');
    const stream = seen.find((r) => r.url === '/chats/c1/stream');
    expect(stream?.auth).toBe('Bearer st');
    expect(JSON.parse(stream?.body ?? '')).toEqual({
      message: { parts: [{ type: 'text', text: 'Hi' }] },
    });
  });

  it('reports a stream cut before its finish as incomplete, never completed', async () => {
    const api = new RetainerClient({ baseUrl: origin, accessToken: 'cli-token', workspace: 'w1' });
    let out = '';
    const result = await sendMessage(api, 'c2', 'Hi', { write: (t) => (out += t), color: false });
    expect(result).toEqual({ status: 'incomplete', code: 'stream_cut', text: 'Hel' });
    expect(out).toContain('The answer was cut short.');
  });
});
