import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One content block of a scripted response. */
export type FakeBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'server_tool_use';
      id: string;
      name: 'web_search';
      input: unknown;
    }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown[] };

export type FakeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
};

/** One scripted answer: an HTTP error, or a streamed message. */
export type FakeAnswer =
  | { error: { status: number; type: string; message: string } }
  | {
      blocks: FakeBlock[];
      stopReason: string;
      usage?: FakeUsage;
      /** Waits this long before the first event, to model a slow model. */
      delayMs?: number;
      /** Breaks the connection after this many SSE events. */
      dropAfterEvents?: number;
    };

export type FakeRequest = { headers: IncomingMessage['headers']; body: Record<string, unknown> };

/**
 * A fake Anthropic Messages API for tests. Answers are taken from a queue
 * in order; every request body is recorded. Point the provider at it with
 * ANTHROPIC_BASE_URL.
 */
export class FakeAnthropic {
  readonly requests: FakeRequest[] = [];
  readonly #answers: FakeAnswer[] = [];
  #server: Server | undefined;
  url = '';

  enqueue(...answers: FakeAnswer[]): this {
    this.#answers.push(...answers);
    return this;
  }

  /** Forgets recorded requests and queued answers, between tests. */
  reset(): void {
    this.requests.length = 0;
    this.#answers.length = 0;
  }

  pending(): number {
    return this.#answers.length;
  }

  async start(): Promise<this> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/v1`;
    return this;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    this.requests.push({ headers: req.headers, body });
    const answer = this.#answers.shift();
    if (!answer) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'no answer' } }),
      );
      return;
    }
    if ('error' in answer) {
      res.writeHead(answer.error.status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: answer.error.type, message: answer.error.message },
        }),
      );
      return;
    }
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const events = sseEvents(answer);
    let sent = 0;
    for (const [event, data] of events) {
      if (answer.dropAfterEvents !== undefined && sent >= answer.dropAfterEvents) {
        // Let the client read what was sent, then cut the connection.
        await new Promise((resolve) => setTimeout(resolve, 300));
        res.destroy();
        return;
      }
      if (res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sent++;
    }
    res.end();
  }
}

function sseEvents(answer: Extract<FakeAnswer, { blocks: FakeBlock[] }>): Array<[string, unknown]> {
  const usage = answer.usage ?? {};
  const events: Array<[string, unknown]> = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: `msg_${Math.random().toString(36).slice(2)}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.input_tokens ?? 10,
            output_tokens: 1,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          },
        },
      },
    ],
  ];
  answer.blocks.forEach((block, index) => {
    switch (block.type) {
      case 'thinking':
        events.push(
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index,
              delta: { type: 'thinking_delta', thinking: block.thinking },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index,
              delta: { type: 'signature_delta', signature: block.signature },
            },
          ],
        );
        break;
      case 'text':
        events.push(
          [
            'content_block_start',
            { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
          ],
          [
            'content_block_delta',
            { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
          ],
        );
        break;
      case 'tool_use':
      case 'server_tool_use':
        events.push(
          [
            'content_block_start',
            {
              type: 'content_block_start',
              index,
              content_block: { type: block.type, id: block.id, name: block.name, input: {} },
            },
          ],
          [
            'content_block_delta',
            {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
            },
          ],
        );
        break;
      case 'web_search_tool_result':
        events.push([
          'content_block_start',
          {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'web_search_tool_result',
              tool_use_id: block.tool_use_id,
              content: block.content,
            },
          },
        ]);
        break;
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: answer.stopReason, stop_sequence: null },
        usage: {
          output_tokens: usage.output_tokens ?? 5,
          input_tokens: usage.input_tokens ?? 10,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          ...(usage.server_tool_use ? { server_tool_use: usage.server_tool_use } : {}),
        },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  );
  return events;
}
