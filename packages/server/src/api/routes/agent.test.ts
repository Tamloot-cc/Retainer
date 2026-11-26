import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { MAX_STREAM_BODY_BYTES } from '../../agent-sessions/service.js';
import type { AppEnv } from '../../http/response.js';
import { agentStreamForward } from './agent.js';

describe('the self-hosted stream forward', () => {
  it('refuses an oversized body before buffering it or calling the agent', async () => {
    let calls = 0;
    const upstream = createServer((_req, res) => {
      calls++;
      res.end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { port } = upstream.address() as AddressInfo;
    try {
      const app = new Hono<AppEnv>();
      agentStreamForward(app, `http://127.0.0.1:${port}`);
      const response = await app.request(`/v1/agent/chats/${crypto.randomUUID()}/stream`, {
        method: 'POST',
        headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
        body: 'x'.repeat(MAX_STREAM_BODY_BYTES + 1),
      });
      expect(response.status).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});
