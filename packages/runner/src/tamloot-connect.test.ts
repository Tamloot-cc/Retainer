// The Tamloot bundle's OAuth connections against HTTP fixtures (connect spec 5, 9).
import { randomUUID } from 'node:crypto';
import { executionResultSchema } from '@retainer/extension';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TAMLOOT } from './tamloot-contract.js';
import { codeHash, type TokenStore } from './tamloot-oauth.js';
import {
  type Fault,
  Harness,
  MEETING,
  type RetainerConnection,
  type Route,
} from './tamloot-test-fixture.js';

const DAY = 86_400_000;
let h: Harness;
beforeEach(async () => {
  h = await new Harness().start();
});
afterEach(() => h.stop());

const connect = (c: RetainerConnection) => h.run(c, TAMLOOT.connect);
const poll = (c: RetainerConnection) =>
  h.run(c, TAMLOOT.poll, { scheduledAt: new Date().toISOString() });
const scan = (c: RetainerConnection) =>
  h.run(c, TAMLOOT.scan, {
    scanId: randomUUID(),
    mode: 'created',
    from: '2026-10-01T00:00:00.000Z',
    through: '2026-11-15T00:00:00.000Z',
  });
const sync = (c: RetainerConnection) => h.run(c, TAMLOOT.sync, { sourceItemId: randomUUID() });
const hook = (c: RetainerConnection, input: { keep?: 'current' } = {}) =>
  h.run(c, TAMLOOT.disconnect, input);
/** Approve in Tamloot as `name` and run the `connect` the completion queues. */
const reconnect = (c: RetainerConnection, name: string) => {
  h.approve(c, name);
  return connect(c);
};
const store = (c: RetainerConnection) => c.store() as TokenStore;
const tokenCalls = () => h.fx.calls('token').length;
const deletes = () => h.fx.calls('access').length;
const fault = (route: Route, ...faults: Fault[]) => h.fx.faults[route].push(...faults);
const status = (code: number, body?: unknown, retryAfter?: string): Fault => ({
  kind: 'status',
  status: code,
  ...(body !== undefined ? { body } : {}),
  ...(retryAfter ? { retryAfter } : {}),
});
const always = (route: Route, code: number, times = 16) =>
  fault(route, ...Array.from({ length: times }, () => status(code)));
const crashOn = (c: RetainerConnection, exchange: TokenStore['exchange'], commit: boolean) => {
  // `exchanged` names the write of the token answer, the one with `pending` set.
  c.crashOn = {
    match: (s) => s.exchange === exchange && (exchange !== 'exchanged' || s.pending !== null),
    commit,
  };
};
const IMPORTS: Route[] = ['head', 'changes', 'sessions', 'session', 'tasks'];
/** Successful import reads answered for a Tamloot account. */
const importsBy = (name: string) =>
  h.fx.log.filter(
    (l) => IMPORTS.includes(l.route) && l.status === 200 && l.user === h.fx.user(name),
  ).length;
const accepted = (r: unknown) => {
  const { crashed: _c, ...rest } = r as Record<string, unknown>;
  return executionResultSchema.safeParse(rest).success;
};

describe('exchange, verify, import (connect spec 5.5)', () => {
  it('exchanges then imports; pending is written before /v1/me and nothing imports before verifySource', async () => {
    const c = h.connection();
    const r = await reconnect(c, 'alice');
    expect(r).toEqual({ status: 'succeeded' });
    expect(c.history.map((s) => s.exchange)).toEqual(['ready', 'started', 'exchanged', 'promoted']);
    expect(c.history[2]).toMatchObject({ current: null, pending: expect.any(Object) });
    const order = h.events.filter(
      (e) => e.startsWith('write:') || e.startsWith('tamloot:') || e.startsWith('verified:'),
    );
    expect(order).toEqual([
      'write:ready',
      'write:started',
      'tamloot:token:200',
      'write:exchanged',
      'tamloot:me:200',
      `verified:${h.fx.user('alice')}`,
      'write:promoted',
      'tamloot:head:200',
    ]);
    expect(c.scans).toHaveLength(1);
    expect(importsBy('alice')).toBe(1);
  });
  it('a retried connect does not exchange twice', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    const before = store(c);
    expect(await connect(c)).toEqual({ status: 'succeeded' });
    expect(tokenCalls()).toBe(1);
    expect(store(c).current).toEqual(before.current);
    expect(store(c).release).toEqual([]);
  });
  it('reads the client and sends requests to its API origin with the session, never a key', async () => {
    const c = h.connection();
    c.stage('apiKey', 'never-use-this-key');
    await reconnect(c, 'alice');
    expect(h.fx.log.filter((l) => l.bearer).every((l) => l.bearer?.startsWith('at_'))).toBe(true);
  });
  it('fails oauth_unavailable when the operator configured no client', async () => {
    const c = h.connection();
    h.approve(c, 'alice');
    c.oauthClient = null;
    expect(await connect(c)).toEqual({ status: 'failed', code: 'oauth_unavailable' });
    expect(tokenCalls()).toBe(0);
  });
});

describe('every row of the attempt table (connect spec 5.5)', () => {
  const rows: {
    name: string;
    uncertain: boolean;
    fault: Fault;
    status: 'retry' | 'failed';
    code?: string;
    exchange: TokenStore['exchange'];
    lost: boolean;
  }[] = [
    {
      name: '429',
      uncertain: false,
      fault: status(429),
      status: 'retry',
      exchange: 'ready',
      lost: false,
    },
    {
      name: '429 keeps uncertain',
      uncertain: true,
      fault: status(429),
      status: 'retry',
      exchange: 'ready',
      lost: false,
    },
    {
      name: 'refused before send',
      uncertain: false,
      fault: { kind: 'refuse' },
      status: 'retry',
      exchange: 'ready',
      lost: false,
    },
    {
      name: 'timeout',
      uncertain: false,
      fault: { kind: 'hang' },
      status: 'retry',
      exchange: 'started',
      lost: false,
    },
    {
      name: 'connection lost after sending',
      uncertain: false,
      fault: { kind: 'dropAfterProcessing' },
      status: 'retry',
      exchange: 'started',
      lost: false,
    },
    {
      name: '5xx',
      uncertain: false,
      fault: status(503),
      status: 'retry',
      exchange: 'started',
      lost: false,
    },
    {
      name: 'invalid_grant, certain',
      uncertain: false,
      fault: status(400, { error: 'invalid_grant' }),
      status: 'failed',
      code: 'provider_unauthorized',
      exchange: 'refused',
      lost: false,
    },
    {
      name: 'invalid_grant, uncertain',
      uncertain: true,
      fault: status(400, { error: 'invalid_grant' }),
      status: 'failed',
      code: 'exchange_interrupted',
      exchange: 'lost',
      lost: true,
    },
    {
      name: 'other OAuth 4xx, certain',
      uncertain: false,
      fault: status(400, { error: 'invalid_request' }),
      status: 'failed',
      code: 'oauth_client_rejected',
      exchange: 'refused',
      lost: false,
    },
    {
      name: 'other OAuth 4xx, uncertain',
      uncertain: true,
      fault: status(400, { error: 'invalid_scope' }),
      status: 'failed',
      code: 'oauth_client_rejected',
      exchange: 'lost',
      lost: true,
    },
  ];
  for (const row of rows)
    it(row.name, async () => {
      const c = h.connection();
      const code = h.approve(c, 'alice');
      const hash = codeHash(code);
      if (row.uncertain) {
        fault('token', { kind: 'hang' });
        expect((await connect(c)).status).toBe('retry');
      }
      const calls = tokenCalls();
      fault('token', row.fault);
      const r = await connect(c);
      expect(r.status).toBe(row.status);
      if (row.code) expect(r.code).toBe(row.code);
      // The attempt sets uncertain before sending when the store said `started`.
      expect(c.history.at(-1)?.exchange === 'started' || row.exchange !== 'started').toBe(true);
      // A refused connection or a hung request never reaches the fixture's log.
      if (!['refuse', 'hang'].includes(row.fault.kind)) expect(tokenCalls()).toBe(calls + 1);
      expect(store(c)).toMatchObject({
        exchange: row.exchange,
        uncertain: row.uncertain,
        failure: row.code ?? null,
        pending: null,
      });
      expect(store(c).lost.includes(hash)).toBe(row.lost);
      expect(r.releaseIncomplete ?? []).toEqual(row.lost ? [`exchange:${hash}`] : []);
      if (row.status === 'failed') {
        // Replayed by a same-code run, with no token call.
        expect(await connect(c)).toMatchObject({ status: 'failed', code: row.code });
        expect(tokenCalls()).toBe(calls + 1);
      }
    });
  it('tokens: pending and exchanged, then step 5', async () => {
    const c = h.connection();
    h.approve(c, 'alice');
    fault('me', status(503));
    expect((await connect(c)).status).toBe('retry');
    expect(store(c)).toMatchObject({ exchange: 'exchanged', pending: expect.any(Object) });
  });
  it('an unknown 400 code, or none, is oauth_client_rejected, stored and replayed', async () => {
    for (const body of [{ error: 'whatever' }, { code: 400, error_code: 'mystery' }, {}]) {
      const c = h.connection();
      h.approve(c, 'alice');
      fault('token', status(400, body));
      expect(await connect(c)).toMatchObject({ status: 'failed', code: 'oauth_client_rejected' });
      expect(store(c)).toMatchObject({ exchange: 'refused', failure: 'oauth_client_rejected' });
      const calls = tokenCalls();
      expect(await connect(c)).toMatchObject({ status: 'failed', code: 'oauth_client_rejected' });
      expect(tokenCalls()).toBe(calls);
    }
  });
  it('a wrong client secret (GoTrue invalid_credentials) is a setup error', async () => {
    const c = h.connection();
    h.approve(c, 'alice');
    c.oauthClient = { ...h.client, clientSecret: 'wrong' };
    expect(await connect(c)).toMatchObject({ status: 'failed', code: 'oauth_client_rejected' });
  });
});

describe('every row of the same-code table (connect spec 5.5 step 4)', () => {
  it('failure set, in any state: fails with it and makes no token call', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    for (const exchange of ['promoted', 'exchanged', 'ready', 'lost'] as const) {
      c.put({ ...store(c), exchange, failure: 'source_account_changed' });
      const calls = tokenCalls();
      expect(await connect(c)).toMatchObject({ status: 'failed', code: 'source_account_changed' });
      expect(tokenCalls()).toBe(calls);
    }
  });
  it('ready or started: an attempt', async () => {
    for (const exchange of ['ready', 'started'] as const) {
      const c = h.connection();
      h.approve(c, 'alice');
      fault('token', status(429));
      await connect(c);
      c.put({ ...store(c), exchange });
      const calls = tokenCalls();
      expect((await connect(c)).status).toBe('succeeded');
      expect(tokenCalls()).toBe(calls + 1);
      expect(store(c).uncertain).toBe(exchange === 'started');
    }
  });
  it('exchanged with pending: step 5, no token call', async () => {
    const c = h.connection();
    h.approve(c, 'alice');
    fault('me', status(503));
    await connect(c);
    const calls = tokenCalls();
    expect(await connect(c)).toEqual({ status: 'succeeded' });
    expect(tokenCalls()).toBe(calls);
    expect(store(c).exchange).toBe('promoted');
  });
  it('promoted: verifies current, no token call, no promotion; release stays apart from the drain', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    always('access', 503, 1);
    await reconnect(c, 'alice');
    const before = store(c);
    expect(before.release).toHaveLength(1);
    const calls = tokenCalls();
    const writes = c.history.length;
    always('access', 503, 1);
    expect(await connect(c)).toEqual({ status: 'succeeded' });
    expect(tokenCalls()).toBe(calls);
    expect(c.history.length).toBe(writes);
    expect(store(c)).toEqual(before);
    expect(h.fx.calls('me').at(-1)?.status).toBe(200);
  });
  it('anything else: provider_unauthorized, no token call', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    for (const s of [
      { exchange: 'exchanged' as const, pending: null },
      { exchange: 'refused' as const },
      { exchange: 'lost' as const },
    ]) {
      c.put({ ...store(c), ...s, failure: null });
      const calls = tokenCalls();
      expect(await connect(c)).toMatchObject({ status: 'failed', code: 'provider_unauthorized' });
      expect(tokenCalls()).toBe(calls);
    }
  });
});

describe('named failure sequences (connect spec 9)', () => {
  it('only 429s, then expired: refused, uncertain false, nothing reported', async () => {
    const c = h.connection();
    h.approve(c, 'alice');
    fault('token', status(429), status(429, undefined, '900'));
    expect(await connect(c)).toMatchObject({ status: 'retry', code: 'provider_rate_limited' });
    expect(await connect(c)).toMatchObject({ status: 'retry', retryAfterSeconds: 900 });
    h.clock.advance(15 * 60_000);
    const r = await connect(c);
    expect(r).toEqual({ status: 'failed', code: 'provider_unauthorized' });
    expect(store(c)).toMatchObject({ exchange: 'refused', uncertain: false, lost: [] });
  });
  it('timeout, then 429, then invalid_grant: lost, reported', async () => {
    const c = h.connection();
    const code = h.approve(c, 'alice');
    fault('token', { kind: 'hang' }, status(429), status(400, { error: 'invalid_grant' }));
    expect((await connect(c)).status).toBe('retry');
    expect(store(c)).toMatchObject({ exchange: 'started', uncertain: false });
    expect((await connect(c)).status).toBe('retry');
    // Set before sending, kept by the 429.
    expect(c.history.at(-2)).toMatchObject({ exchange: 'started', uncertain: true });
    expect(store(c)).toMatchObject({ exchange: 'ready', uncertain: true });
    expect(await connect(c)).toEqual({
      status: 'failed',
      code: 'exchange_interrupted',
      releaseIncomplete: [`exchange:${codeHash(code)}`],
    });
  });
  it('timeout, then invalid_client: lost, reported, oauth_client_rejected', async () => {
    const c = h.connection();
    const code = h.approve(c, 'alice');
    fault('token', { kind: 'hang' }, status(401, { error: 'invalid_client' }));
    await connect(c);
    expect(await connect(c)).toEqual({
      status: 'failed',
      code: 'oauth_client_rejected',
      releaseIncomplete: [`exchange:${codeHash(code)}`],
    });
    expect(store(c)).toMatchObject({ exchange: 'lost', failure: 'oauth_client_rejected' });
  });
  it('a failure before any byte was sent, then invalid_grant: refused, nothing reported', async () => {
    const c = h.connection();
    h.approve(c, 'alice');
    fault('token', { kind: 'refuse' }, status(400, { error: 'invalid_grant' }));
    expect((await connect(c)).status).toBe('retry');
    expect(await connect(c)).toEqual({ status: 'failed', code: 'provider_unauthorized' });
    expect(store(c)).toMatchObject({ exchange: 'refused', uncertain: false });
  });
  it('the run dies after Tamloot answered, before pending is written: the retry reports it', async () => {
    const c = h.connection();
    const code = h.approve(c, 'alice');
    crashOn(c, 'exchanged', false);
    expect((await connect(c)).crashed).toBe(true);
    expect(store(c).exchange).toBe('started');
    expect(h.fx.liveSessions('alice')).toHaveLength(1);
    expect(await connect(c)).toEqual({
      status: 'failed',
      code: 'exchange_interrupted',
      releaseIncomplete: [`exchange:${codeHash(code)}`],
    });
    expect(c.history.at(-2)).toMatchObject({ exchange: 'started', uncertain: true });
    expect(store(c)).toMatchObject({ exchange: 'lost', failure: 'exchange_interrupted' });
    // Only the member's revoke ends that session; the hook reports it.
    expect(await hook(c, { keep: 'current' })).toEqual({
      status: 'succeeded',
      releaseIncomplete: [`exchange:${codeHash(code)}`],
    });
    expect(h.fx.listsRetainer('alice')).toBe(true);
  });
  it('the same crash, then a new code before any retry: step 2 records it and the connect that succeeds reports it', async () => {
    const c = h.connection();
    const first = h.approve(c, 'alice');
    crashOn(c, 'exchanged', false);
    await connect(c);
    expect(await reconnect(c, 'alice')).toEqual({
      status: 'succeeded',
      releaseIncomplete: [`exchange:${codeHash(first)}`],
    });
    expect(store(c).lost).toEqual([codeHash(first)]);
  });
  it('crash between the store write and the result: the retry, the cleanup and the next connect report the same ID', async () => {
    const c = h.connection();
    const code = h.approve(c, 'alice');
    crashOn(c, 'exchanged', false);
    await connect(c);
    crashOn(c, 'lost', true);
    expect((await connect(c)).crashed).toBe(true);
    expect(store(c).exchange).toBe('lost');
    const id = `exchange:${codeHash(code)}`;
    const retry = await connect(c);
    const cleanup = await hook(c, { keep: 'current' });
    const next = await reconnect(c, 'alice');
    for (const r of [retry, cleanup, next]) expect(r.releaseIncomplete).toEqual([id]);
    expect(next.status).toBe('succeeded');
  });
  it('the first exchange refused with uncertain false: replayed, current never reactivated (new connection and reconnect)', async () => {
    for (const body of [{ error: 'invalid_grant' }, { error: 'invalid_client' }]) {
      const fresh = h.connection();
      h.approve(fresh, 'alice');
      fault('token', status(400, body));
      const first = await connect(fresh);
      expect(first.releaseIncomplete).toBeUndefined();
      expect(store(fresh)).toMatchObject({ exchange: 'refused', current: null });
      const calls = tokenCalls();
      expect(await connect(fresh)).toEqual(first);
      expect(tokenCalls()).toBe(calls);

      const c = h.connection();
      await reconnect(c, 'alice');
      const old = store(c).current;
      h.approve(c, 'alice');
      fault('token', status(400, body));
      const failed = await connect(c);
      expect(failed).toEqual(first);
      const imports = h.fx.calls('head').length;
      expect(await connect(c)).toEqual(first);
      expect(store(c).current).toEqual(old);
      expect(h.fx.calls('head').length).toBe(imports);
    }
  });
  it('step 2 after an exchanged code refused by verifySource with uncertain true adds nothing to lost', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    h.approve(c, 'bob');
    fault('token', { kind: 'hang' });
    await connect(c);
    expect(await connect(c)).toMatchObject({ code: 'source_account_changed' });
    expect(store(c)).toMatchObject({ exchange: 'exchanged', uncertain: true, pending: null });
    await reconnect(c, 'alice');
    expect(store(c).lost).toEqual([]);
  });
});

describe('reconnect and release order (connect spec 5.5 steps 2, 3, 5, 7)', () => {
  it('same account: the new session becomes current; the old one is released only after that write', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    const old = store(c).current;
    h.events.length = 0;
    expect(await reconnect(c, 'alice')).toEqual({ status: 'succeeded' });
    const order = h.events.filter((e) => e.startsWith('write:') || e.startsWith('tamloot:'));
    expect(order.indexOf('tamloot:access:204')).toBeGreaterThan(order.indexOf('write:promoted'));
    expect(store(c).current).not.toEqual(old);
    expect(store(c).release).toEqual([]);
    expect(h.fx.liveSessions('alice')).toHaveLength(1);
    expect(h.fx.listsRetainer('alice')).toBe(true);
  });
  it('another account: refused, current kept, new session in release as rejected, no DELETE; the keep-current hook releases it and retries on 503', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    const current = store(c).current;
    const r = await reconnect(c, 'bob');
    expect(r).toEqual({ status: 'failed', code: 'source_account_changed' });
    expect(store(c)).toMatchObject({ current, pending: null, failure: 'source_account_changed' });
    expect(store(c).release).toEqual([expect.objectContaining({ reason: 'rejected' })]);
    expect(deletes()).toBe(0);
    expect(importsBy('bob')).toBe(0);
    // An upgrade's connect with the same code replays the failure and never uses current.
    const reads = h.fx.log.length;
    expect(await connect(c)).toEqual({ status: 'failed', code: 'source_account_changed' });
    expect(h.fx.log.length).toBe(reads);
    fault('access', status(503));
    expect(await hook(c, { keep: 'current' })).toEqual({ status: 'retry' });
    expect(await hook(c, { keep: 'current' })).toEqual({ status: 'succeeded' });
    expect(h.fx.liveSessions('bob')).toHaveLength(0);
    expect(h.fx.liveSessions('alice')).toHaveLength(1);
    expect(c.refusedWrites).toEqual([]);
  });
  it('no release call before promotion: a stale pending P1, then C2', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    fault('me', status(503));
    expect((await reconnect(c, 'alice')).status).toBe('retry');
    h.events.length = 0;
    expect((await reconnect(c, 'alice')).status).toBe('succeeded');
    const order = h.events.filter((e) => e.startsWith('write:') || e.startsWith('tamloot:'));
    expect(order.indexOf('tamloot:access:204')).toBeGreaterThan(order.indexOf('write:promoted'));
    expect(h.fx.revocations).toEqual([]);
    expect(h.fx.liveSessions('alice')).toHaveLength(1);
    expect(store(c).release).toEqual([]);
  });
  it('no release call before promotion, with a stored current already gone in Tamloot', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    h.fx.sessions.clear();
    fault('me', status(503));
    await reconnect(c, 'alice');
    h.events.length = 0;
    expect((await reconnect(c, 'alice')).status).toBe('succeeded');
    const order = h.events.filter((e) => e.startsWith('write:') || e.startsWith('tamloot:'));
    const firstDelete = order.findIndex((e) => e.startsWith('tamloot:access'));
    expect(firstDelete).toBeGreaterThan(order.indexOf('write:promoted'));
    expect(h.fx.listsRetainer('alice')).toBe(true);
  });
});

describe('release backlog bounds (connect spec 5.5 step 3)', () => {
  async function fill(c: RetainerConnection, entries: number) {
    await reconnect(c, 'alice');
    for (let i = 0; i < entries; i++) {
      always('access', 503);
      await reconnect(c, 'alice');
      h.fx.faults.access.length = 0;
    }
  }
  it('four live entries: step 3 reads each, keeps them, and fails release_backlog with no token call and no DELETE', async () => {
    const c = h.connection();
    await fill(c, 4);
    expect(store(c).release).toHaveLength(4);
    const tokens = tokenCalls(),
      dels = deletes(),
      reads = h.fx.calls('me').length;
    expect(await reconnect(c, 'alice')).toEqual({ status: 'failed', code: 'release_backlog' });
    expect(tokenCalls()).toBe(tokens);
    expect(deletes()).toBe(dels);
    expect(h.fx.calls('me').length).toBe(reads + 4);
  });
  it('four entries the hook already gave up: step 3 gets 401 and a failed refresh, drops them and exchanges', async () => {
    const c = h.connection();
    await fill(c, 4);
    const keep = h.fx.sessionOfAccess(store(c).current!.accessToken);
    for (const id of [...h.fx.sessions.keys()]) if (id !== keep) h.fx.sessions.delete(id);
    expect((await reconnect(c, 'alice')).status).toBe('succeeded');
    expect(store(c).release).toEqual([]);
  });
  it('kept entries keep their refreshed tokens, id and since; dropped ones stay dropped', async () => {
    const c = h.connection();
    await fill(c, 4);
    const entries = store(c).release;
    for (const e of entries.slice(0, 2))
      h.fx.sessions.delete(h.fx.sessionOfRefresh(e.session.refreshToken)!);
    h.clock.advance(2 * 3600e3);
    always('access', 503);
    expect((await reconnect(c, 'alice')).status).toBe('succeeded');
    const after = store(c).release;
    for (const e of entries.slice(0, 2)) expect(after.find((x) => x.id === e.id)).toBeUndefined();
    for (const e of entries.slice(2)) {
      const kept = after.find((x) => x.id === e.id)!;
      expect(kept.since).toBe(e.since);
      expect(kept.session.refreshToken).not.toBe(e.session.refreshToken);
    }
  });
  it('repeating step 2 for the same earlier code after a release_backlog failure adds no duplicate', async () => {
    const c = h.connection();
    await fill(c, 4);
    // An earlier code whose attempt never got an answer.
    const stale = 'stale-code';
    c.put({ ...store(c), codeHash: codeHash(stale), exchange: 'started' });
    for (let i = 0; i < 2; i++) {
      const r = await reconnect(c, 'alice');
      expect(r).toEqual({
        status: 'failed',
        code: 'release_backlog',
        releaseIncomplete: [`exchange:${codeHash(stale)}`],
      });
      expect(store(c).lost).toEqual([codeHash(stale)]);
    }
  });
  it('lost at four: lost_backlog without a token call; no duplicates; a new connection connects', async () => {
    const c = h.connection();
    for (let i = 0; i < 4; i++) {
      crashOn(c, 'exchanged', false);
      await reconnect(c, 'alice');
    }
    expect(store(c).lost).toHaveLength(3);
    const tokens = tokenCalls();
    expect(await reconnect(c, 'alice')).toMatchObject({ status: 'failed', code: 'lost_backlog' });
    expect(store(c).lost).toHaveLength(4);
    expect(tokenCalls()).toBe(tokens);
    const again = await reconnect(c, 'alice');
    expect(again).toMatchObject({ status: 'failed', code: 'lost_backlog' });
    expect(again.releaseIncomplete).toHaveLength(4);
    expect(new Set(store(c).lost).size).toBe(4);
    const fresh = h.connection();
    expect((await reconnect(fresh, 'alice')).status).toBe('succeeded');
  });
  it('a store with four lost hashes and four aged entries gives a result of eight IDs that is accepted', async () => {
    const c = h.connection();
    for (let i = 0; i < 4; i++) {
      crashOn(c, 'exchanged', false);
      await reconnect(c, 'alice');
    }
    await reconnect(c, 'alice');
    const s = store(c);
    const session = {
      accessToken: 'x',
      refreshToken: 'y',
      expiresAt: new Date(h.clock.now() + 3600e3).toISOString(),
    };
    c.put({
      ...s,
      release: Array.from({ length: 4 }, () => ({
        id: randomUUID(),
        session,
        since: new Date(h.clock.now() - 2 * DAY).toISOString(),
        reason: 'replaced' as const,
      })),
    });
    always('access', 503);
    const r = await hook(c);
    expect(r.releaseIncomplete).toHaveLength(8);
    expect(accepted(r)).toBe(true);
  });
});

describe('access in every other function (connect spec 5.6, 5.8)', () => {
  it('refreshes when less than five minutes remain and writes at once', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    h.clock.advance(56 * 60_000);
    const before = store(c).current!;
    expect(await scan(c)).toEqual({ status: 'succeeded' });
    expect(store(c).current!.refreshToken).not.toBe(before.refreshToken);
    expect(h.fx.log.slice(-2).map((l) => l.route)).toEqual(['token', 'sessions']);
  });
  const rows: { name: string; setup: () => void; status: string; code?: string }[] = [
    {
      name: '401, refresh, retry',
      setup: () => fault('sessions', status(401)),
      status: 'succeeded',
    },
    {
      name: '401 twice: provider_unauthorized',
      setup: () => fault('sessions', status(401), status(401)),
      status: 'failed',
      code: 'provider_unauthorized',
    },
    {
      name: '401 then refresh invalid_grant: provider_unauthorized',
      setup: () => {
        fault('sessions', status(401));
        fault('token', status(400, { error: 'invalid_grant' }));
      },
      status: 'failed',
      code: 'provider_unauthorized',
    },
    ...[
      'refresh_token_not_found',
      'refresh_token_already_used',
      'user_banned',
      'session_expired',
    ].map((code) => ({
      name: `401 then refresh ${code}: provider_unauthorized`,
      setup: () => {
        fault('sessions', status(401));
        fault('token', status(400, { code: 400, error_code: code, msg: 'x' }));
      },
      status: 'failed',
      code: 'provider_unauthorized',
    })),
    {
      name: '401 then refresh invalid_client: oauth_client_rejected',
      setup: () => {
        fault('sessions', status(401));
        fault('token', status(400, { error: 'invalid_client' }));
      },
      status: 'failed',
      code: 'oauth_client_rejected',
    },
    {
      name: '401 then an unknown refresh code: oauth_client_rejected',
      setup: () => {
        fault('sessions', status(401));
        fault('token', status(400, { code: 400, error_code: 'validation_failed' }));
      },
      status: 'failed',
      code: 'oauth_client_rejected',
    },
    ...[503, 429].map((code) => ({
      name: `401 then refresh ${code}: retry`,
      setup: () => {
        fault('sessions', status(401));
        fault('token', status(code));
      },
      status: 'retry',
    })),
    ...[{ code: 'forbidden' }, { message: 'Forbidden' }, undefined].map((body) => ({
      name: `403 ${JSON.stringify(body)}: provider_forbidden`,
      setup: () => fault('sessions', status(403, body)),
      status: 'failed',
      code: 'provider_forbidden',
    })),
    {
      name: '429: retry',
      setup: () => fault('sessions', status(429, undefined, '5')),
      status: 'retry',
    },
    { name: '503: retry', setup: () => fault('sessions', status(503)), status: 'retry' },
    { name: 'network: retry', setup: () => fault('sessions', { kind: 'refuse' }), status: 'retry' },
    { name: 'timeout: retry', setup: () => fault('sessions', { kind: 'hang' }), status: 'retry' },
  ];
  for (const row of rows)
    it(row.name, async () => {
      const c = h.connection();
      await reconnect(c, 'alice');
      const health = store(c);
      row.setup();
      const r = await scan(c);
      expect(r.status).toBe(row.status);
      if (row.code) expect(r.code).toBe(row.code);
      // 5xx and 429 never touch the connection's tokens.
      if (row.status === 'retry') expect(store(c).current?.refreshToken).toBeDefined();
      expect(health.codeHash).toBe(store(c).codeHash);
    });
  it('5xx and 429 at the token endpoint during an exchange retry and never fail the connect', async () => {
    const c = h.connection();
    h.approve(c, 'alice');
    fault('token', status(503), status(429));
    expect((await connect(c)).status).toBe('retry');
    expect((await connect(c)).status).toBe('retry');
    expect((await connect(c)).status).toBe('succeeded');
  });
  it('a revoked approval answers 401 and a failed refresh: provider_unauthorized, then no further runs import', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    h.fx.revokeGrant('alice');
    expect(await scan(c)).toEqual({ status: 'failed', code: 'provider_unauthorized' });
    expect(await sync(c)).toEqual({ status: 'failed', code: 'provider_unauthorized' });
  });
  it('a write conflict uses the stored tokens', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    h.clock.advance(56 * 60_000);
    const writes = c.history.length;
    const [a, b] = await Promise.all([scan(c), scan(c)]);
    expect([a.status, b.status]).toEqual(['succeeded', 'succeeded']);
    expect(h.fx.calls('token').filter((l) => l.grant === 'refresh_token')).toHaveLength(2);
    expect(c.history.length).toBe(writes + 1);
    expect((await scan(c)).status).toBe('succeeded');
  });
  it('poll, scan and sync-session use oauthTokens, receive no oauthCode, and never use apiKey', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    c.secrets.delete('oauthCode');
    c.secrets.delete('oauthVerifier');
    c.stage('apiKey', 'never-use-this-key');
    const before = h.fx.log.length;
    for (const run of [poll, scan, sync]) expect(await run(c)).toEqual({ status: 'succeeded' });
    const used = h.fx.log.slice(before);
    expect(used.map((l) => l.route)).toEqual(['sessions', 'session', 'tasks']);
    expect(used.every((l) => l.user === h.fx.user('alice'))).toBe(true);
    expect(h.events.some((e) => e.includes('/runtime/secrets/apiKey'))).toBe(false);
    expect(c.imported).toContain(MEETING);
  });
  it('fails provider_unauthorized when nothing was ever promoted', async () => {
    const c = h.connection();
    h.approve(c, 'alice');
    fault('me', status(503));
    await connect(c);
    c.secrets.delete('oauthCode');
    expect(await poll(c)).toEqual({ status: 'failed', code: 'provider_unauthorized' });
  });
  it('two handler runs in one process share nothing', async () => {
    const a = h.connection(),
      b = h.connection();
    await reconnect(a, 'alice');
    await reconnect(b, 'bob');
    const storeA = store(a),
      storeB = store(b);
    h.fx.log.length = 0;
    await Promise.all([scan(a), scan(b), scan(a), scan(b)]);
    const byUser = h.fx.log.map((l) => l.user);
    expect(byUser.filter((u) => u === h.fx.user('alice'))).toHaveLength(2);
    expect(byUser.filter((u) => u === h.fx.user('bob'))).toHaveLength(2);
    expect(store(a)).toEqual(storeA);
    expect(store(b)).toEqual(storeB);
    expect(storeA.current?.accessToken).not.toBe(storeB.current?.accessToken);
  });
});

describe('a key connection behaves exactly as before', () => {
  it('connects, imports and disconnects with the key, and never asks for an OAuth client', async () => {
    const c = h.connection(false);
    c.stage('apiKey', 'fixture-tamloot-key');
    const seen: { origin: string; auth: string | null; path: string }[] = [];
    const account = randomUUID();
    const tamloot: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      seen.push({
        origin: u.origin,
        auth: new Headers(init?.headers).get('authorization'),
        path: u.pathname,
      });
      if (u.pathname === '/v1/me')
        return Response.json({ data: { user_id: account, email: 'k@t.test' } });
      return Response.json({ data: { cursor: 'c' } });
    };
    expect(await h.run(c, TAMLOOT.connect, {}, { tamloot })).toEqual({ status: 'succeeded' });
    expect(seen).toEqual([
      { origin: 'https://api.tamloot.cc', auth: 'Bearer fixture-tamloot-key', path: '/v1/me' },
      {
        origin: 'https://api.tamloot.cc',
        auth: 'Bearer fixture-tamloot-key',
        path: '/v1/changes/head',
      },
    ]);
    expect(h.events.some((e) => e.includes('oauth-client') || e.includes('oauthTokens'))).toBe(
      false,
    );
    const forbidden: typeof fetch = async () => Response.json({}, { status: 403 });
    expect(await h.run(c, TAMLOOT.connect, {}, { tamloot: forbidden })).toEqual({
      status: 'failed',
      code: 'provider_unauthorized',
    });
    // No exchange ever started: the hook succeeds without a call.
    expect(await hook(c)).toEqual({ status: 'succeeded' });
    expect(h.events.some((e) => e.includes('oauth-client'))).toBe(false);
  });
});

describe('drain, aging and reporting (connect spec 5.6, 4.7)', () => {
  it('poll, scan and sync-session drain release before importing, and still import when the drain fails', async () => {
    for (const run of [poll, scan, sync]) {
      const c = h.connection();
      await reconnect(c, 'alice');
      always('access', 503, 1);
      await reconnect(c, 'alice');
      expect(store(c).release).toHaveLength(1);
      h.events.length = 0;
      always('access', 503, 1);
      const imported = c.imported.length + c.scans.length;
      expect(await run(c)).toEqual({ status: 'succeeded' });
      const first = h.events.findIndex((e) => e.startsWith('tamloot:access'));
      const importEvent = h.events.findIndex(
        (e) => e.startsWith('retainer:POST /source-sync') || /tamloot:(sessions|session):/.test(e),
      );
      expect(first).toBeGreaterThan(-1);
      expect(importEvent).toBeGreaterThan(first);
      expect(c.imported.length + c.scans.length).toBeGreaterThan(imported);
      expect(store(c).release).toHaveLength(1);
    }
  });
  it('an entry that outlives 24 hours is reported, again, until a 204 removes it; refreshing keeps id and since', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    always('access', 503, 1);
    await reconnect(c, 'alice');
    const entry = store(c).release[0]!;
    for (const hours of [1, 11, 11]) {
      h.clock.advance(hours * 3600e3);
      always('access', 503, 1);
      expect(await poll(c)).toEqual({ status: 'succeeded' });
    }
    h.clock.advance(2 * 3600e3);
    always('access', 503, 1);
    expect(await poll(c)).toEqual({
      status: 'succeeded',
      releaseIncomplete: [`release:${entry.id}`],
    });
    always('access', 503, 1);
    expect(await poll(c)).toEqual({
      status: 'succeeded',
      releaseIncomplete: [`release:${entry.id}`],
    });
    expect(store(c).release[0]).toMatchObject({ id: entry.id, since: entry.since });
    expect(store(c).release[0]!.session.refreshToken).not.toBe(entry.session.refreshToken);
    expect(await poll(c)).toEqual({ status: 'succeeded' });
    expect(store(c).release).toEqual([]);
  });
  it('entries the keep-current hook already released are removed by the next poll or connect without error', async () => {
    for (const next of [poll, (c: RetainerConnection) => reconnect(c, 'alice')]) {
      const c = h.connection();
      await reconnect(c, 'alice');
      await reconnect(c, 'bob');
      expect(await hook(c, { keep: 'current' })).toEqual({ status: 'succeeded' });
      expect(store(c).release).toHaveLength(1);
      expect((await next(c)).status).toBe('succeeded');
      expect(store(c).release).toEqual([]);
    }
  });
  it('connect reports only what it tried', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    await reconnect(c, 'bob');
    const p1 = store(c).release[0]!;
    await hook(c, { keep: 'current' });
    h.clock.advance(25 * 3600e3);
    fault('me', status(503));
    const r1 = await reconnect(c, 'alice');
    expect(r1.status).toBe('retry');
    const r2 = await reconnect(c, 'bob');
    expect(r2.code).toBe('source_account_changed');
    for (const r of [r1, r2]) expect(r.releaseIncomplete ?? []).not.toContain(`release:${p1.id}`);
    const r3 = await reconnect(c, 'alice');
    expect(r3).toEqual({ status: 'succeeded' });
    expect(store(c).release.find((e) => e.id === p1.id)).toBeUndefined();
  });
  it('a 403 on a release entry keeps it, still imports, names the code and ages normally', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    always('access', 503, 1);
    await reconnect(c, 'alice');
    const entry = store(c).release[0]!;
    fault('access', status(403));
    const r = await poll(c);
    expect(r).toEqual({ status: 'succeeded', code: 'provider_forbidden' });
    expect(accepted(r)).toBe(true);
    expect(store(c).release.map((e) => e.id)).toEqual([entry.id]);
    h.clock.advance(25 * 3600e3);
    fault('access', status(403));
    expect(await poll(c)).toEqual({
      status: 'succeeded',
      code: 'provider_forbidden',
      releaseIncomplete: [`release:${entry.id}`],
    });
  });
  it('a refresh refused while giving a session up keeps the entry and names the code', async () => {
    for (const [body, code] of [
      [{ error: 'invalid_client' }, 'oauth_client_rejected'],
      [{ code: 400, error_code: 'invalid_credentials' }, 'oauth_client_rejected'],
      [{ code: 400, error_code: 'refresh_token_already_used' }, 'provider_unauthorized'],
      [{ code: 400, error_code: 'user_banned' }, 'provider_unauthorized'],
      [{ code: 400, error_code: 'session_expired' }, 'provider_unauthorized'],
      [{ error: 'invalid_grant' }, 'provider_unauthorized'],
    ] as const) {
      const c = h.connection();
      await reconnect(c, 'alice');
      always('access', 503, 1);
      await reconnect(c, 'alice');
      fault('access', status(401));
      fault('token', status(400, body));
      expect(await poll(c)).toEqual({ status: 'succeeded', code });
      expect(store(c).release).toHaveLength(1);
    }
  });
  it('a refresh answering refresh_token_not_found while giving up counts as done', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    always('access', 503, 1);
    await reconnect(c, 'alice');
    const old = store(c).release[0]!;
    h.fx.sessions.delete(h.fx.sessionOfRefresh(old.session.refreshToken)!);
    expect(await poll(c)).toEqual({ status: 'succeeded' });
    expect(store(c).release).toEqual([]);
    h.clock.advance(25 * 3600e3);
    expect(await poll(c)).toEqual({ status: 'succeeded' });
  });
  it("a run's own failure code wins over a release setup error", async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    always('access', 503, 1);
    await reconnect(c, 'alice');
    fault('access', status(403));
    fault('sessions', status(401), status(401));
    expect(await scan(c)).toEqual({ status: 'failed', code: 'provider_unauthorized' });
  });
});

describe('disconnect (connect spec 5.7)', () => {
  it('releases current, pending and release, tolerates a session that is gone, and reports lost and started hashes', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    always('access', 503, 1);
    await reconnect(c, 'alice');
    fault('me', status(503));
    await reconnect(c, 'alice');
    expect(store(c).pending).not.toBeNull();
    const code = h.approve(c, 'alice');
    crashOn(c, 'exchanged', false);
    await connect(c);
    expect(store(c)).toMatchObject({ exchange: 'started' });
    expect(store(c).release).toHaveLength(2);
    h.fx.sessions.delete([...h.fx.sessions.keys()][0]!);
    const r = await hook(c);
    expect(r).toEqual({ status: 'succeeded', releaseIncomplete: [`exchange:${codeHash(code)}`] });
    expect(h.fx.liveSessions('alice')).toHaveLength(1);
    expect(c.refusedWrites).toEqual([]);
  });
  it('reports an uncertain ready code and every lost hash', async () => {
    const c = h.connection();
    const first = h.approve(c, 'alice');
    crashOn(c, 'exchanged', false);
    await connect(c);
    const second = h.approve(c, 'alice');
    fault('token', { kind: 'hang' }, status(429));
    await connect(c);
    await connect(c);
    expect(store(c)).toMatchObject({ exchange: 'ready', uncertain: true });
    expect(await hook(c)).toEqual({
      status: 'succeeded',
      releaseIncomplete: [`exchange:${codeHash(first)}`, `exchange:${codeHash(second)}`],
    });
  });
  it('keeps current with { keep: "current" }', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    expect(await hook(c, { keep: 'current' })).toEqual({ status: 'succeeded' });
    expect(h.fx.liveSessions('alice')).toHaveLength(1);
    expect(await hook(c)).toEqual({ status: 'succeeded' });
    expect(h.fx.liveSessions('alice')).toHaveLength(0);
    expect(h.fx.revocations).toHaveLength(1);
  });
  it('fails release_incomplete only for a store that does not parse', async () => {
    const c = h.connection();
    expect(await hook(c)).toEqual({ status: 'succeeded' });
    c.put('{"nope":1}');
    expect(await hook(c)).toEqual({ status: 'failed', code: 'release_incomplete' });
    c.put('not json');
    expect(await hook(c)).toEqual({ status: 'failed', code: 'release_incomplete' });
  });
  it('refreshes an expired session without writing, and retries until DELETE ends it', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    h.clock.advance(2 * 3600e3);
    for (let i = 0; i < 3; i++) {
      fault('access', status(503));
      expect(await hook(c)).toEqual({ status: 'retry' });
      h.clock.advance(60_000);
    }
    expect(await hook(c)).toEqual({ status: 'succeeded' });
    expect(h.fx.liveSessions('alice')).toHaveLength(0);
    expect(c.refusedWrites).toEqual([]);
  });
  it('a 403 or a refused refresh keeps the session and retries with the code', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    fault('access', status(403));
    const r = await hook(c);
    expect(r).toEqual({ status: 'retry', code: 'provider_forbidden' });
    expect(accepted(r)).toBe(true);
    expect(h.fx.liveSessions('alice')).toHaveLength(1);
    h.clock.advance(2 * 3600e3);
    c.oauthClient = { ...h.client, clientSecret: 'wrong' };
    expect(await hook(c)).toEqual({ status: 'retry', code: 'oauth_client_rejected' });
    c.oauthClient = h.client;
    expect(await hook(c)).toEqual({ status: 'succeeded' });
  });
  it('retries oauth_unavailable when the client is gone, still reporting lost exchanges', async () => {
    const c = h.connection();
    await reconnect(c, 'alice');
    c.oauthClient = null;
    expect(await hook(c)).toEqual({ status: 'retry', code: 'oauth_unavailable' });
  });
  it('refuses an input other than {} or { keep: "current" }', async () => {
    const c = h.connection();
    expect(await hook(c, { keep: 'all' } as never)).toEqual({
      status: 'failed',
      code: 'invalid_input',
    });
  });
});

describe('a DELETE already in flight when the installation changes (connect spec 4.7)', () => {
  async function setup() {
    const c = h.connection();
    h.approve(c, 'alice');
    fault('me', status(503));
    expect((await connect(c)).status).toBe('retry');
    let release!: () => void;
    fault('access', { kind: 'hold', release: new Promise<void>((r) => (release = r)) });
    const held = h.run(c, TAMLOOT.disconnect, { keep: 'current' }, { timeoutMs: 5000 });
    while (!h.fx.faults.access.length && h.fx.calls('access').length === 0)
      await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    return { c, held, release };
  }
  it('it lands before the superseding connect verifies pending: provider_unauthorized, nothing imported', async () => {
    const { c, held, release } = await setup();
    release();
    expect(await held).toEqual({ status: 'succeeded' });
    expect(await connect(c)).toEqual({ status: 'failed', code: 'provider_unauthorized' });
    expect(h.fx.calls('head')).toHaveLength(0);
    expect((await reconnect(c, 'alice')).status).toBe('succeeded');
  });
  it('it lands after that connect promoted the session: imports came from the verified account; the next run needs reconnect', async () => {
    const { c, held, release } = await setup();
    expect(await connect(c)).toEqual({ status: 'succeeded' });
    release();
    await held;
    expect(await scan(c)).toEqual({ status: 'failed', code: 'provider_unauthorized' });
    expect(h.fx.calls('head').filter((l) => l.status === 200)).toHaveLength(1);
  });
  it('it ended the last session: a code exchanged meanwhile fails at its first check', async () => {
    const a = h.connection(),
      b = h.connection();
    await reconnect(a, 'alice');
    h.approve(b, 'alice');
    await hook(a);
    expect(h.fx.revocations).toHaveLength(1);
    expect(await connect(b)).toEqual({ status: 'failed', code: 'provider_unauthorized' });
    expect(store(b).release).toEqual([expect.objectContaining({ reason: 'rejected' })]);
    expect(h.fx.calls('head').filter((l) => l.status === 200)).toHaveLength(1);
  });
});

describe('property: random reconnects, rejections, release outcomes and crashes (connect spec 9)', () => {
  it('the store never holds more than six sessions; every session ever stored is released or still stored', async () => {
    let runs = 0;
    for (let seed = 1; seed <= 25; seed++) {
      await h.stop();
      h = await new Harness().start();
      let x = seed;
      const rand = (n: number) => {
        x = (x * 1103515245 + 12345) % 2 ** 31;
        return x % n;
      };
      const c = h.connection();
      await reconnect(c, 'alice');
      const crashed = new Set<string>();
      for (let step = 0; step < 30; step++) {
        const op = rand(8),
          f = rand(4);
        if (f === 0) fault('access', status(503));
        if (f === 1) fault('me', status(503));
        if (f === 2) fault('access', status(403));
        const before = new Set(h.fx.sessions.keys());
        runs++;
        let r: Awaited<ReturnType<typeof connect>> | undefined;
        if (op <= 1) r = await reconnect(c, 'alice');
        else if (op === 2) r = await reconnect(c, 'bob');
        else if (op === 3) {
          crashOn(c, 'exchanged', false);
          r = await reconnect(c, 'alice');
        } else if (op === 4) r = await poll(c);
        else if (op === 5) r = await hook(c, { keep: 'current' });
        else if (op === 6) r = await connect(c);
        else h.clock.advance(rand(48) * 3600e3);
        if (r?.crashed)
          for (const id of h.fx.sessions.keys())
            if (!before.has(id)) crashed.add(id);
            else if (r) expect(accepted(r)).toBe(true);
        h.fx.faults.access.length = 0;
        h.fx.faults.me.length = 0;
        const s = store(c);
        const held = [s.current, s.pending, ...s.release.map((e) => e.session)].filter(
          (v) => v !== null,
        );
        expect(held.length).toBeLessThanOrEqual(6);
        const storedIds = new Set(held.map((v) => h.fx.sessionOfRefresh(v.refreshToken)));
        const everIds = new Set(
          c.history.flatMap((v) =>
            [v.current, v.pending, ...v.release.map((e) => e.session)]
              .filter((y) => y !== null)
              .map((y) => h.fx.sessionOfRefresh(y.refreshToken)),
          ),
        );
        // A live session with access is stored, or came from a crashed exchange (the accepted window).
        for (const [id, live] of h.fx.sessions)
          if (!h.fx.approvals.get(live.user)?.revoked)
            expect(storedIds.has(id) || crashed.has(id)).toBe(true);
        // A session that left the store was released, or has no access left.
        for (const id of everIds)
          if (id && !storedIds.has(id) && h.fx.sessions.has(id)) {
            const live = h.fx.sessions.get(id)!;
            expect(h.fx.approvals.get(live.user)?.revoked).toBe(true);
          }
      }
    }
    expect(runs).toBe(25 * 30);
  }, 120_000);
});
