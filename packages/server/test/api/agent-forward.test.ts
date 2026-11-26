import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RUNTIME_SECRET } from '../helpers/agent.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

/**
 * The self-hosted stream forward (agent spec §13): the server passes a chat's
 * stream from the agent container to the client without buffering.
 */
const db = useTestDatabase();
let agent: Server;
let upstream: string;

beforeAll(async () => {
  // A fake agent container: one event, then the connection drops mid-turn.
  agent = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-vercel-ai-ui-message-stream': 'v1',
      });
      res.write(`data: ${JSON.stringify({ type: 'start', messageId: 'm1' })}\n\n`);
      setTimeout(() => res.destroy(), 50);
    });
  });
  await new Promise<void>((resolve) => agent.listen(0, '127.0.0.1', resolve));
  upstream = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`;
});
afterAll(async () => {
  agent.closeAllConnections();
  await new Promise<void>((resolve) => agent.close(() => resolve()));
});

describe('the stream forward', () => {
  it('ends the client stream with an error event when the agent connection drops', async () => {
    const t = startTestApp(db, { agent: { runtimeSecret: RUNTIME_SECRET, upstream } });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await t.app.request(
      '/v1/agent/chats/0b9c8a52-7a39-4b55-9a49-1e7a1f2a3c4d/stream',
      {
        method: 'POST',
        headers: { authorization: 'Bearer stream-token', 'content-type': 'application/json' },
        body: JSON.stringify({ message: { parts: [{ type: 'text', text: 'Hi' }] } }),
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    // Reading to the end succeeds: the stream closes cleanly after the error event.
    const text = await response.text();
    expect(text).toContain('"type":"start"');
    expect(text).toContain('"type":"error"');
    expect(text).toContain('connection to the agent was lost');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
