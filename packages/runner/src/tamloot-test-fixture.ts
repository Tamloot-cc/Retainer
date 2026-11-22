// Test support only (excluded from the build). A local HTTP stand-in for Tamloot's
// token endpoint (GoTrue, with the answers observed in the spike, connect spec 5.4)
// and API, plus an in-process stand-in for the Retainer runtime routes the bundle
// calls. Neither is evidence of real provider behaviour.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecutionResult, ExtensionOAuthClient, Invocation } from '@retainer/extension';
import { executeTamloot } from './tamloot.js';
import { TAMLOOT } from './tamloot-contract.js';
import { type TokenStore, tokenStoreSchema } from './tamloot-oauth.js';

export type Clock = { now(): number; advance(ms: number): void };
export const testClock = (start = Date.parse('2026-11-15T10:00:00Z')): Clock => {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
};

/** One injected fault, consumed by the next matching request. */
export type Fault =
  | { kind: 'status'; status: number; body?: unknown; retryAfter?: string }
  /** Never answers: the client times out after sending. */
  | { kind: 'hang' }
  /** Processes the request, then kills the socket. */
  | { kind: 'dropAfterProcessing' }
  /** Nothing reaches the server (connection refused). */
  | { kind: 'refuse' }
  /** Processes after `release` resolves. */
  | { kind: 'hold'; release: Promise<void> };
export type Route =
  | 'token'
  | 'me'
  | 'head'
  | 'changes'
  | 'sessions'
  | 'session'
  | 'tasks'
  | 'access';
type Session = {
  id: string;
  user: string;
  access: string;
  activeRefresh: string;
};
type RefreshToken = { session: string; parent: string | null; revoked: boolean; usedAt?: number };
export type FixtureOptions = {
  clock: Clock;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  codeLifetimeMs?: number;
  accessLifetimeMs?: number;
  reuseIntervalMs?: number;
};
export const MEETING = '7a0c5d64-1b0b-4d55-9a54-0d2f1c0e9b11';

export class TamlootFixture {
  private server!: Server;
  origin = '';
  private closedPort = 0;
  readonly faults: Record<Route, Fault[]> = {
    token: [],
    me: [],
    head: [],
    changes: [],
    sessions: [],
    session: [],
    tasks: [],
    access: [],
  };
  readonly log: {
    route: Route;
    session?: string;
    /** The Tamloot account an API request was answered for. */
    user?: string;
    status: number;
    grant?: string;
    bearer?: string;
  }[] = [];
  readonly sessions = new Map<string, Session>();
  private readonly refresh = new Map<string, RefreshToken>();
  /** Access tokens are JWTs: each one stays valid until it expires or its session ends. */
  private readonly accessTokens = new Map<string, { session: string; expiresAt: number }>();
  private readonly codes = new Map<
    string,
    { user: string; challenge: string; expiresAt: number; used: boolean }
  >();
  /** The member's approval of Retainer: revoked when its last session is released. */
  readonly approvals = new Map<string, { revoked: boolean }>();
  readonly revocations: { user: string; at: number }[] = [];
  private readonly users = new Map<string, string>();
  readonly o: Required<FixtureOptions>;
  constructor(
    options: FixtureOptions,
    private readonly events: string[] = [],
  ) {
    this.o = {
      codeLifetimeMs: 10 * 60_000,
      accessLifetimeMs: 3600_000,
      reuseIntervalMs: 10_000,
      ...options,
    };
  }
  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    this.closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return this;
  }
  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  /** fetch for Tamloot: a `refuse` fault sends to a closed port, so nothing is sent. */
  transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const route = this.routeOf(url.pathname, init?.method ?? 'GET');
    if (route && this.faults[route][0]?.kind === 'refuse') {
      this.faults[route].shift();
      url.port = String(this.closedPort);
    }
    return fetch(url, init);
  };
  /** A Tamloot account, by a name tests use; its ID is a UUID as on the real API. */
  user(name: string) {
    let id = this.users.get(name);
    if (!id) {
      id = randomUUID();
      this.users.set(name, id);
    }
    return id;
  }
  /** The member approves Retainer (re-approval clears a revoke) and gets a code. */
  approve(name: string, challenge: string) {
    const user = this.user(name);
    this.approvals.set(user, { revoked: false });
    const code = randomBytes(16).toString('base64url');
    this.codes.set(code, {
      user,
      challenge,
      expiresAt: this.o.clock.now() + this.o.codeLifetimeMs,
      used: false,
    });
    return code;
  }
  /** The member revokes Retainer in Connected apps: GoTrue deletes the sessions. */
  revokeGrant(name: string) {
    const user = this.user(name);
    for (const [id, s] of this.sessions) if (s.user === user) this.sessions.delete(id);
    this.approvals.set(user, { revoked: true });
  }
  revokeApproval(name: string) {
    this.approvals.set(this.user(name), { revoked: true });
  }
  liveSessions(name: string) {
    const user = this.user(name);
    return [...this.sessions.values()].filter((s) => s.user === user);
  }
  /** Connected apps lists Retainer while a session is live under an approval. */
  listsRetainer(name: string) {
    return !this.approvals.get(this.user(name))?.revoked && this.liveSessions(name).length > 0;
  }
  sessionOfRefresh(token: string) {
    return this.refresh.get(token)?.session;
  }
  sessionOfAccess(token: string) {
    return this.accessTokens.get(token)?.session;
  }
  calls(route: Route) {
    return this.log.filter((l) => l.route === route);
  }
  private routeOf(path: string, method: string): Route | undefined {
    if (path === '/auth/v1/oauth/token' && method === 'POST') return 'token';
    if (path === '/v1/me') return 'me';
    if (path === '/v1/changes/head') return 'head';
    if (path === '/v1/changes') return 'changes';
    if (path === '/v1/sessions') return 'sessions';
    if (path.startsWith('/v1/sessions/')) return 'session';
    if (path === '/v1/tasks') return 'tasks';
    if (path === '/v1/access' && method === 'DELETE') return 'access';
    return undefined;
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.origin);
    const route = this.routeOf(url.pathname, req.method ?? 'GET');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    if (!route) return this.send(res, 404, { error: 'not_found' });
    const fault = this.faults[route].shift();
    if (fault?.kind === 'hang') return;
    if (fault?.kind === 'hold') await fault.release;
    if (fault?.kind === 'status') {
      this.log.push({ route, status: fault.status });
      this.events.push(`tamloot:${route}:${fault.status}`);
      if (fault.retryAfter) res.setHeader('retry-after', fault.retryAfter);
      return this.send(res, fault.status, fault.body ?? { error: 'injected' });
    }
    const [status, payload, meta] =
      route === 'token' ? this.token(req, body) : this.api(route, req.headers.authorization);
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    this.log.push({ route, status, ...meta, ...(route === 'token' ? {} : { bearer }) });
    this.events.push(`tamloot:${route}:${status}`);
    if (fault?.kind === 'dropAfterProcessing') {
      req.socket.destroy();
      return;
    }
    this.send(res, status, payload);
  }
  private send(res: ServerResponse, status: number, payload: unknown) {
    if (status === 204) return void res.writeHead(204).end();
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  }
  private mint(s: Session) {
    s.access = `at_${randomBytes(12).toString('hex')}`;
    this.accessTokens.set(s.access, {
      session: s.id,
      expiresAt: this.o.clock.now() + this.o.accessLifetimeMs,
    });
  }
  private issue(user: string): Session {
    const s: Session = {
      id: randomUUID(),
      user,
      access: '',
      activeRefresh: `rt_${randomBytes(12).toString('hex')}`,
    };
    this.mint(s);
    this.sessions.set(s.id, s);
    this.refresh.set(s.activeRefresh, { session: s.id, parent: null, revoked: false });
    return s;
  }
  private tokens(s: Session) {
    return {
      access_token: s.access,
      refresh_token: s.activeRefresh,
      token_type: 'bearer',
      expires_in: Math.floor(this.o.accessLifetimeMs / 1000),
    };
  }
  /** Answers in the shapes GoTrue v2.197.0 gave in the spike, not RFC 6749 guesses. */
  private token(
    req: IncomingMessage,
    body: string,
  ): [number, unknown, { grant?: string; session?: string }] {
    const expected = `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64')}`;
    if (req.headers.authorization !== expected)
      return [
        400,
        { code: 400, error_code: 'invalid_credentials', msg: 'Invalid client credentials' },
        {},
      ];
    const form = new URLSearchParams(body);
    const grant = form.get('grant_type') ?? '';
    const now = this.o.clock.now();
    if (grant === 'authorization_code') {
      const code = this.codes.get(form.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url');
      if (!code || code.used || code.expiresAt <= now || code.challenge !== challenge)
        return [400, { error: 'invalid_grant', error_description: 'Invalid code' }, { grant }];
      if (form.get('redirect_uri') !== this.o.redirectUri)
        return [400, { error: 'invalid_grant', error_description: 'redirect_uri' }, { grant }];
      code.used = true;
      const s = this.issue(code.user);
      return [200, this.tokens(s), { grant, session: s.id }];
    }
    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      const rt = this.refresh.get(presented);
      const s = rt && this.sessions.get(rt.session);
      if (!rt || !s)
        return [
          400,
          { code: 400, error_code: 'refresh_token_not_found', msg: 'Refresh Token Not Found' },
          { grant },
        ];
      if (rt.revoked) {
        const active = this.refresh.get(s.activeRefresh);
        const withinReuse = rt.usedAt !== undefined && now - rt.usedAt < this.o.reuseIntervalMs;
        // Observed: the parent of the active token returns the active one, no new rotation.
        if (withinReuse || active?.parent === presented) {
          this.mint(s);
          return [200, this.tokens(s), { grant, session: s.id }];
        }
        return [
          400,
          { code: 400, error_code: 'refresh_token_already_used', msg: 'Already Used' },
          { grant, session: s.id },
        ];
      }
      rt.revoked = true;
      rt.usedAt = now;
      const next = `rt_${randomBytes(12).toString('hex')}`;
      this.refresh.set(next, { session: s.id, parent: presented, revoked: false });
      s.activeRefresh = next;
      this.mint(s);
      return [200, this.tokens(s), { grant, session: s.id }];
    }
    return [400, { error: 'unsupported_grant_type' }, { grant }];
  }
  private api(route: Route, auth?: string): [number, unknown, { session?: string; user?: string }] {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const at = this.accessTokens.get(token);
    const s = at && this.sessions.get(at.session);
    const approval = s && this.approvals.get(s.user);
    if (!s || !(at.expiresAt > this.o.clock.now()) || !approval || approval.revoked)
      return [401, { code: s && approval?.revoked ? 'access_revoked' : 'invalid_token' }, {}];
    const meta = { session: s.id, user: s.user };
    switch (route) {
      case 'me':
        return [200, { data: { user_id: s.user, email: `${s.user}@tamloot.test` } }, meta];
      case 'head':
        return [200, { data: { cursor: 'cursor-1' } }, meta];
      case 'changes':
        return [200, { data: [], next_cursor: 'cursor-1', has_more: false }, meta];
      case 'sessions':
        return [
          200,
          {
            data: [{ id: MEETING, recording_status: 'completed' }],
            pagination: { has_more: false, next_offset: null },
          },
          meta,
        ];
      case 'session':
        return [
          200,
          {
            data: {
              id: MEETING,
              revision: 1,
              session_date: '2026-11-10T10:00:00Z',
              title: 'Weekly',
              recording_status: 'completed',
              participants: [{ name: 'Pat', emails: ['pat@example.test'] }],
              notes: [{ title: 'Notes', content: 'Shipped' }],
            },
          },
          meta,
        ];
      case 'tasks':
        return [200, { data: [] }, meta];
      default: {
        // DELETE /v1/access ends this session; the last one revokes the approval.
        this.sessions.delete(s.id);
        if (![...this.sessions.values()].some((x) => x.user === s.user)) {
          this.approvals.set(s.user, { revoked: true });
          this.revocations.push({ user: s.user, at: this.o.clock.now() });
        }
        return [204, null, meta];
      }
    }
  }
}

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

export class Crash extends Error {}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const apiError = (status: number, code: string) => json({ error: { code, message: code } }, status);

/**
 * One member connection on the Retainer side: its secrets with their revisions,
 * its bound source account, KV and the work it queued. Answers like the runtime
 * routes do, including `409 revision_conflict` and a disconnect hook's refused write.
 */
export class RetainerConnection {
  readonly installationId = randomUUID();
  readonly secrets = new Map<string, { value: string; revision: number }>();
  /** Every store the bundle wrote, in order. */
  readonly history: TokenStore[] = [];
  readonly refusedWrites: string[] = [];
  account: string | null = null;
  readonly kv = new Map<string, { value: unknown; revision: number }>();
  readonly children: { functionId: string; input: unknown }[] = [];
  readonly scans: unknown[] = [];
  readonly imported: string[] = [];
  oauthClient: ExtensionOAuthClient | null;
  settings: Record<string, unknown> = {
    shareMeetings: true,
    backfillDays: 31,
    createPeople: 'never',
  };
  /** Ends the run at the matching token-store write, after committing it or not. */
  crashOn: { match: (store: TokenStore) => boolean; commit: boolean } | null = null;
  /**
   * Runtime paths answered `503 release_not_loaded`, as an API process a
   * rolling deploy has not reached yet answers a run of the new release.
   */
  readonly behind = new Set<string>();
  dead = false;
  constructor(
    client: ExtensionOAuthClient | null,
    private readonly events: string[] = [],
  ) {
    this.oauthClient = client;
  }
  store(): TokenStore | null {
    const stored = this.secrets.get('oauthTokens');
    return stored ? tokenStoreSchema.parse(JSON.parse(stored.value)) : null;
  }
  /** Stages a secret as the server does at the start or the end of the handshake. */
  stage(name: string, value: string) {
    const prior = this.secrets.get(name);
    this.secrets.set(name, { value, revision: (prior?.revision ?? 0) + 1 });
  }
  /** Writes the token store directly (test setup), as a bundle write would. */
  put(store: TokenStore | string) {
    this.stage('oauthTokens', typeof store === 'string' ? store : JSON.stringify(store));
  }
  async handle(url: URL, init: RequestInit | undefined, functionId: string): Promise<Response> {
    if (this.dead) throw new Crash('dead');
    const prefix = `/v1/extensions/${this.installationId}`;
    if (!url.pathname.startsWith(prefix)) throw new Error(`unexpected ${url.pathname}`);
    const path = url.pathname.slice(prefix.length),
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.events.push(`retainer:${method} ${path}`);
    if (this.behind.has(path)) return apiError(503, 'release_not_loaded');
    if (path === '' && method === 'GET')
      return json({
        id: this.installationId,
        settings: this.settings,
        secrets: Object.fromEntries([...this.secrets.keys()].map((n) => [n, true])),
      });
    if (path === '/runtime/oauth-client')
      return this.oauthClient ? json(this.oauthClient) : apiError(409, 'oauth_unavailable');
    const secret = /^\/runtime\/secrets\/([A-Za-z]+)$/.exec(path)?.[1];
    if (secret && !DECLARED[functionId]?.includes(secret)) return apiError(403, 'forbidden');
    if (secret && method === 'GET') {
      const stored = this.secrets.get(secret);
      return stored ? json(stored) : apiError(409, 'connection_required');
    }
    if (secret && method === 'PUT') {
      if (functionId === TAMLOOT.disconnect) {
        this.refusedWrites.push(secret);
        return apiError(409, 'installation_disabled');
      }
      const prior = this.secrets.get(secret);
      if ((prior?.revision ?? null) !== body.expectedRevision)
        return apiError(409, 'revision_conflict');
      const parsed = tokenStoreSchema.parse(JSON.parse(body.value));
      const crash = this.crashOn?.match(parsed) ? this.crashOn : null;
      if (crash && !crash.commit) {
        this.dead = true;
        throw new Crash('before write');
      }
      const revision = (prior?.revision ?? 0) + 1;
      this.secrets.set(secret, { value: body.value, revision });
      this.history.push(parsed);
      this.events.push(`write:${parsed.exchange}`);
      if (crash) {
        this.dead = true;
        throw new Crash('after write');
      }
      return json({ revision });
    }
    if (path === '/source/verify') {
      if (this.account && this.account !== body.accountId)
        return apiError(409, 'source_account_changed');
      this.account = body.accountId;
      this.events.push(`verified:${body.accountId}`);
      return json({
        sourceAccountId: 'acct',
        provider: 'tamloot',
        identity: 'x',
        sharing: 'workspace',
      });
    }
    if (path === '/source') return json({ sourceAccountId: 'acct', provider: 'tamloot' });
    const kvKey = /^\/runtime\/kv\/(.+)$/.exec(path)?.[1];
    if (kvKey) return json(this.kv.get(decodeURIComponent(kvKey)) ?? null);
    if (path === '/runtime/checkpoint') {
      if (body.kv) {
        const prior = this.kv.get(body.kv.key);
        this.kv.set(body.kv.key, { value: body.kv.value, revision: (prior?.revision ?? 0) + 1 });
      }
      this.children.push(...body.children);
      return json({ ids: body.children.map(() => randomUUID()) });
    }
    if (path === '/source-sync' && method === 'GET')
      return json({ activeScan: null, lastSuccessfulScanAt: null });
    if (path === '/source-sync') {
      this.scans.push(body);
      return json({ scanId: body.scanId });
    }
    if (path === '/source-items/batch')
      return json({
        items: body.externalIds.map((externalId: string) => {
          this.imported.push(externalId);
          return {
            externalId,
            sourceItemId: randomUUID(),
            state: 'reserved',
            providerRevision: null,
          };
        }),
      });
    if (/^\/source-items\/[0-9a-f-]{36}$/.test(path))
      return json({
        state: 'reserved',
        externalId: MEETING,
        revisionId: null,
        taskWriteRevision: 0,
      });
    if (path.endsWith('/prepare')) return json({ prepared: true });
    if (path === '/source-events') {
      this.imported.push(body.sourceItemId);
      return json({ stale: false, revisionId: randomUUID() });
    }
    if (path.endsWith('/tasks'))
      return json({ hasMore: false, checkpoint: 'c', bindingStatus: 'ok', warnings: [] });
    throw new Error(`unexpected ${method} ${path}`);
  }
}

/** The secrets each function declares (connect spec 5.1); the broker refuses the rest. */
const DECLARED: Record<string, string[]> = {
  [TAMLOOT.connect]: ['apiKey', 'oauthVerifier', 'oauthCode', 'oauthTokens'],
  [TAMLOOT.poll]: ['apiKey', 'oauthTokens'],
  [TAMLOOT.scan]: ['apiKey', 'oauthTokens'],
  [TAMLOOT.sync]: ['apiKey', 'oauthTokens'],
  [TAMLOOT.disconnect]: ['oauthTokens'],
};
export const CLIENT_ID = 'client-1',
  CLIENT_SECRET = 'secret-1',
  REDIRECT = 'https://retainer.test/app/connect/callback';

/** A Tamloot fixture, a clock and the connections a test runs functions for. */
export class Harness {
  readonly events: string[] = [];
  clock = testClock();
  fx!: TamlootFixture;
  client!: ExtensionOAuthClient;
  async start() {
    this.fx = await new TamlootFixture(
      {
        clock: this.clock,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT,
      },
      this.events,
    ).start();
    this.client = {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      tokenEndpoint: `${this.fx.origin}/auth/v1/oauth/token`,
      redirectUri: REDIRECT,
      apiOrigin: this.fx.origin,
    };
    return this;
  }
  stop() {
    return this.fx.stop();
  }
  connection(oauth = true) {
    return new RetainerConnection(oauth ? this.client : null, this.events);
  }
  /** The member approves in Tamloot; the server stages the code and verifier. */
  approve(conn: RetainerConnection, name: string) {
    const p = pkce();
    const code = this.fx.approve(name, p.challenge);
    conn.stage('oauthVerifier', p.verifier);
    conn.stage('oauthCode', code);
    return code;
  }
  /** Runs one function of the bundle for the connection, as the platform would. */
  async run(
    conn: RetainerConnection,
    functionId: string,
    input: unknown = {},
    options: { timeoutMs?: number; tamloot?: typeof fetch } = {},
  ): Promise<ExecutionResult & { crashed?: true }> {
    const invocation: Invocation = {
      protocolVersion: 1,
      runId: randomUUID(),
      attempt: 1,
      installationId: conn.installationId,
      releaseDigest: 'a'.repeat(64),
      functionId,
      input: input as Invocation['input'],
      bindings: {
        bindings_revision: 1,
        createPeople: 'everyone',
        bindings: {
          task: {
            status: 'ok',
            objects: [{ id: randomUUID(), name: 'taskTest', label: 'Tasks' }],
            fields: {},
          },
        },
      },
      apiOrigin: 'https://retainer.test',
      runToken: 'rt_run_tamloot',
      deadline: new Date(Date.now() + 120000).toISOString(),
    };
    const tamloot = options.tamloot ?? this.fx.transport;
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.origin === 'https://retainer.test') return conn.handle(url, init, functionId);
      if (conn.dead) throw new Crash('dead');
      return tamloot(input, init);
    };
    conn.dead = false;
    const result = await executeTamloot(invocation, new AbortController().signal, transport, {
      now: this.clock.now,
      pacingMs: 0,
      timeoutMs: options.timeoutMs ?? 300,
    });
    const crashed = conn.dead;
    conn.dead = false;
    conn.crashOn = null;
    return crashed ? { ...result, crashed: true } : result;
  }
}
