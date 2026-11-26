import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { type AgentSessions, MAX_STREAM_BODY_BYTES } from '../../agent-sessions/service.js';
import type { AppEnv } from '../../http/response.js';
import { agentRuntimeRoutes, agentStreamForward } from './agent.js';

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

describe('the runtime routes', () => {
  it('refuse an oversized body before any credential is checked', async () => {
    const touched: string[] = [];
    const agent = new Proxy({} as AgentSessions, {
      get: (_target, name) => () => {
        touched.push(String(name));
        throw new Error('not reached');
      },
    });
    const app = new Hono<AppEnv>();
    agentRuntimeRoutes(app, agent);
    const base = `/v1/agent/runtime/sessions/${crypto.randomUUID()}`;
    for (const [path, size] of [
      ['/claim', 64 * 1024],
      ['/report', 64 * 1024],
      ['/close', 64 * 1024],
      ['/tools/search', 6 * 1024 * 1024],
    ] as const) {
      const response = await app.request(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
        body: 'x'.repeat(size + 1),
      });
      expect(response.status, path).toBe(413);
    }
    expect(touched).toEqual([]);
  });
});
