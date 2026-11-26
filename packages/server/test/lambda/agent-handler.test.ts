import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { httpEvent } from '../helpers/lambda.js';

/**
 * The hosted `agent` entry (agent spec §13) is decorated with
 * `streamifyResponse` once: a function URL request is answered on the stream
 * Lambda handed that one handler, and a task's native event is told apart.
 */
const decorate = vi.fn((handler: unknown) => handler);
const saved = { ...process.env };

beforeAll(() => {
  Object.assign(globalThis, {
    awslambda: {
      streamifyResponse: decorate,
      HttpResponseStream: {
        from: (stream: PassThrough, metadata: unknown) => {
          stream.write(`${JSON.stringify(metadata)}\n`);
          return stream;
        },
      },
    },
  });
  Object.assign(process.env, {
    RETAINER_MASTRA_DATABASE_URL: 'postgres://retainer_mastra:x@127.0.0.1:1/retainer',
    ANTHROPIC_API_KEY: 'test-key',
    RETAINER_AGENT_RUNTIME_SECRET: 'r'.repeat(40),
    RETAINER_API_ORIGIN: 'http://127.0.0.1:1',
    // Hosted sets it; the function URL, not the app, must answer with CORS.
    RETAINER_AGENT_ALLOWED_ORIGINS: 'https://app.test',
  });
});

afterAll(() => {
  delete (globalThis as { awslambda?: unknown }).awslambda;
  process.env = saved;
});

/** Invokes the entry with a function URL event; returns the response metadata line and body. */
async function invoke(event: unknown) {
  const { handler } = await import('../../src/lambda/agent.js');
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => stream.on('finish', resolve));
  await (handler as (event: unknown, stream: PassThrough, context: unknown) => Promise<void>)(
    event,
    stream,
    { getRemainingTimeInMillis: () => 60_000 },
  );
  await ended;
  const text = Buffer.concat(chunks).toString();
  const newline = text.indexOf('\n');
  return {
    metadata: JSON.parse(text.slice(0, newline)) as {
      statusCode: number;
      headers?: Record<string, string>;
    },
    body: text.slice(newline + 1),
  };
}

it('decorates its handler once and answers a function URL request on that stream', async () => {
  const { metadata, body } = await invoke(httpEvent('GET', '/health'));
  expect(decorate).toHaveBeenCalledTimes(1);
  expect(metadata.statusCode).toBe(200);
  expect(body).toBe('ok');
});

it("leaves CORS to the function URL, so a chat's stream carries its headers once", async () => {
  const { metadata } = await invoke(
    httpEvent('POST', '/chats/c1/stream', {
      headers: {
        origin: 'https://app.test',
        authorization: 'Bearer not-a-token',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
  );
  expect(metadata.statusCode).toBeGreaterThanOrEqual(400);
  const names = Object.keys(metadata.headers ?? {}).map((name) => name.toLowerCase());
  expect(names.filter((name) => name.startsWith('access-control-'))).toEqual([]);
});
