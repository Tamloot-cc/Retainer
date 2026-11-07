import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMIT_PER_MINUTE, loadConfig, rateLimitPerMinute } from '../../src/config.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

// The per-workspace rate limit (accounts spec 4.8, 10): one tenant's spike
// gets 429s with Retry-After while other workspaces keep working. Counted in
// Postgres, so it must count exactly under concurrent requests.

const db = useTestDatabase();

const LIMIT = 5;

describe('rate limit per workspace', () => {
  // An hour-long window, so no boundary passes mid-test.
  const app = () => startTestApp(db, { rateLimit: { limit: LIMIT, windowSeconds: 3600 } });

  it('lets exactly the limit through when requests arrive at once, and 429s the rest', async () => {
    const test = app();
    const { keys } = await test.setupWorkspace(
      { name: 'Busy' },
      { bot: { actor: { type: 'agent', id: 'bot' }, scopes: ['read'] } },
    );
    const responses = await Promise.all(
      Array.from({ length: 3 * LIMIT }, () => test.request('/v1/me', { key: keys.bot })),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2 * LIMIT);
    const limited = responses.find((r) => r.status === 429);
    expect(limited?.body.error.code).toBe('rate_limited');
    const retryAfter = Number(limited?.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
  });

  it('keeps other workspaces working while one is limited, on REST and MCP alike', async () => {
    const test = app();
    const busy = await test.setupWorkspace(
      { name: 'Spike' },
      { bot: { actor: { type: 'agent', id: 'bot' }, scopes: ['read'] } },
    );
    const quiet = await test.setupWorkspace(
      { name: 'Quiet' },
      { bot: { actor: { type: 'agent', id: 'bot' }, scopes: ['read'] } },
    );
    for (let i = 0; i < LIMIT; i++) {
      expect((await test.request('/v1/me', { key: busy.keys.bot })).status).toBe(200);
    }
    expect((await test.request('/v1/me', { key: busy.keys.bot })).status).toBe(429);
    const mcp = await test.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${busy.keys.bot}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(429);
    expect(mcp.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await test.request('/v1/me', { key: quiet.keys.bot })).status).toBe(200);
  });

  it('counts nothing without a limit', async () => {
    const test = startTestApp(db);
    const { workspace, keys } = await test.setupWorkspace(
      { name: 'Unlimited' },
      { bot: { actor: { type: 'agent', id: 'bot' }, scopes: ['read'] } },
    );
    for (let i = 0; i < LIMIT + 2; i++) {
      expect((await test.request('/v1/me', { key: keys.bot })).status).toBe(200);
    }
    expect(
      await db.owner`select 1 from workspace_request_counts where workspace_id = ${workspace.id}`,
    ).toHaveLength(0);
  });
});

describe('the limit a config gives', () => {
  const base = { DATABASE_URL: 'postgres://localhost/x' };
  const accounts = {
    ...base,
    RETAINER_AUTH_SECRET: 'x'.repeat(32),
    RETAINER_GOOGLE_CLIENT_ID: 'id',
    RETAINER_GOOGLE_CLIENT_SECRET: 'secret',
  };

  it('is none in key mode, so an install that sets nothing behaves as before', () => {
    expect(rateLimitPerMinute(loadConfig(base))).toBe(0);
  });

  it('defaults in accounts mode, where anyone can sign up, and can be changed or turned off', () => {
    expect(rateLimitPerMinute(loadConfig(accounts))).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
    expect(
      rateLimitPerMinute(loadConfig({ ...accounts, RETAINER_RATE_LIMIT_PER_MINUTE: '50' })),
    ).toBe(50);
    expect(
      rateLimitPerMinute(loadConfig({ ...accounts, RETAINER_RATE_LIMIT_PER_MINUTE: '0' })),
    ).toBe(0);
    expect(rateLimitPerMinute(loadConfig({ ...base, RETAINER_RATE_LIMIT_PER_MINUTE: '9' }))).toBe(
      9,
    );
  });
});
