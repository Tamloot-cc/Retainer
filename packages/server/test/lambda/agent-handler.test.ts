import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

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
  });
});

afterAll(() => {
  delete (globalThis as { awslambda?: unknown }).awslambda;
  process.env = saved;
});

it('decorates its handler once and answers a function URL request on that stream', async () => {
  const { handler } = await import('../../src/lambda/agent.js');
  expect(decorate).toHaveBeenCalledTimes(1);
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise((resolve) => stream.on('finish', resolve));
  await (handler as (event: unknown, stream: PassThrough, context: unknown) => Promise<void>)(
    {
      version: '2.0',
      rawPath: '/health',
      rawQueryString: '',
      headers: { host: 'agent.test' },
      requestContext: { http: { method: 'GET', path: '/health' }, domainName: 'agent.test' },
      isBase64Encoded: false,
    },
    stream,
    { getRemainingTimeInMillis: () => 60_000 },
  );
  await ended;
  const text = Buffer.concat(chunks).toString();
  expect(text).toContain('"statusCode":200');
  expect(text.endsWith('ok')).toBe(true);
});
