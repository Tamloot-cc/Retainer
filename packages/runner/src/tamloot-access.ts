import { randomUUID } from 'node:crypto';
import {
  type DisconnectInput,
  type ExecutionResult,
  type ExtensionOAuthClient,
  isRetryLater,
} from '@retainer/extension';
import { RetainerApiError, type RetainerClient } from '@retainer/sdk';
import { z } from 'zod';
import { transient } from './outcome.js';
import { TAMLOOT_SECRETS } from './tamloot-contract.js';
import {
  allowedEndpoint,
  codeHash,
  exchangeFailure,
  type OAuthSession,
  type ReleaseEntry,
  refreshFailure,
  refreshGone,
  TokenRefused,
  type TokenStore,
  tokenCall,
  tokenStoreSchema,
} from './tamloot-oauth.js';
import { type TamlootCredential, TamlootError, TamlootProvider } from './tamloot-provider.js';

const DAY = 86400000,
  EARLY_REFRESH = 5 * 60000;

/** Everything one run's token handling needs. Nothing here outlives the invocation. */
export type AccessDeps = {
  sdk: RetainerClient;
  installationId: string;
  signal: AbortSignal;
  transport: typeof fetch;
  now: () => number;
  /** Token endpoint and API timeout; 20 seconds unless a test shortens it. */
  timeoutMs?: number;
  pacingMs?: number;
};
type Locate = (store: TokenStore) => OAuthSession | null;
type Replace = (store: TokenStore, session: OAuthSession) => TokenStore;
type Slot = { locate: Locate; replace: Replace };
const CURRENT: Slot = {
  locate: (s) => s.current,
  replace: (s, current) => ({ ...s, current }),
};
const PENDING: Slot = {
  locate: (s) => s.pending,
  replace: (s, pending) => ({ ...s, pending }),
};
const entrySlot = (id: string): Slot => ({
  locate: (s) => s.release.find((r) => r.id === id)?.session ?? null,
  // A refresh rewrites an entry's tokens, never its id or since (connect spec 5.3).
  replace: (s, session) => ({
    ...s,
    release: s.release.map((r) => (r.id === id ? { ...r, session } : r)),
  }),
});
const addLost = (s: TokenStore, hash: string): TokenStore => ({
  ...s,
  lost: s.lost.includes(hash) ? s.lost : [...s.lost, hash],
});

/** Reads a connection secret; `409 connection_required` means it is not stored. */
export async function readSecret(sdk: RetainerClient, id: string, name: string) {
  try {
    return await sdk.extensionSecret(id, name);
  } catch (error) {
    if (error instanceof RetainerApiError && error.code === 'connection_required') return null;
    throw error;
  }
}

/** Whether an error from a step is worth a retry rather than a final failure. */
function retryable(error: unknown) {
  if (error instanceof TamlootError) return error.retry;
  if (error instanceof TokenRefused) return false;
  return isRetryLater(transient(error));
}
/** The final failure code of a verification step, or undefined for an unexpected error. */
function finalCode(error: unknown): string | undefined {
  if (error instanceof TamlootError) return error.code;
  if (error instanceof TokenRefused) return refreshFailure(error.answer);
  if (error instanceof RetainerApiError)
    return error.code === 'source_account_changed' ? error.code : 'source_api_rejected';
  return undefined;
}

/**
 * The OAuth token store of one connection and the calls that keep it (connect
 * spec 5.3–5.7). Every write uses the revision the run read. A disconnect hook
 * reads and never writes: its changes stay in memory for the run.
 */
export class TamlootAccess {
  store: TokenStore | null = null;
  private revision: number | null = null;
  /** `release:<id>` incidents this run tried and could not settle. */
  readonly report = new Set<string>();
  /** A setup error met while giving a session up, named in an otherwise clean result. */
  setupError: string | null = null;
  readonly provider: TamlootProvider;
  constructor(
    private readonly deps: AccessDeps,
    readonly client: ExtensionOAuthClient,
    private readonly readOnly = false,
  ) {
    const origin = client.apiOrigin ? allowedEndpoint(client.apiOrigin)?.origin : undefined;
    if (client.apiOrigin && !origin) throw new TamlootError('oauth_client_rejected');
    this.provider = new TamlootProvider(this.credential(CURRENT), deps.signal, deps.transport, {
      ...(origin ? { origin } : {}),
      ...(deps.pacingMs !== undefined ? { pacingMs: deps.pacingMs } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  }
  /** Parses the stored value; a value that does not parse throws. */
  async load(): Promise<TokenStore | null> {
    const stored = await readSecret(
      this.deps.sdk,
      this.deps.installationId,
      TAMLOOT_SECRETS.tokens,
    );
    this.revision = stored?.revision ?? null;
    this.store = stored ? tokenStoreSchema.parse(JSON.parse(stored.value)) : null;
    return this.store;
  }
  s(): TokenStore {
    if (!this.store) throw new TamlootError('provider_unauthorized');
    return this.store;
  }
  /** Writes the whole store with the revision read; a conflict propagates (a retry). */
  async save(next: TokenStore): Promise<void> {
    const value = tokenStoreSchema.parse(next);
    if (!this.readOnly) {
      const written = await this.deps.sdk.setExtensionSecret(
        this.deps.installationId,
        TAMLOOT_SECRETS.tokens,
        { expectedRevision: this.revision, value: JSON.stringify(value) },
      );
      this.revision = written.revision;
    }
    this.store = value;
  }
  now() {
    return this.deps.now();
  }
  aged(entry: ReleaseEntry) {
    return this.now() - Date.parse(entry.since) >= DAY;
  }
  newEntry(session: OAuthSession, reason: ReleaseEntry['reason']): ReleaseEntry {
    return { id: randomUUID(), session, since: new Date(this.now()).toISOString(), reason };
  }
  tokenOptions() {
    return {
      transport: this.deps.transport,
      signal: this.deps.signal,
      ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
    };
  }
  /** A bearer source for one stored session: refresh near expiry and once after a `401`. */
  credential(slot: Slot): TamlootCredential {
    return {
      bearer: async () => {
        const session = slot.locate(this.s());
        if (!session) throw new TamlootError('provider_unauthorized');
        if (Date.parse(session.expiresAt) - this.now() < EARLY_REFRESH)
          return (await this.refresh(slot)).accessToken;
        return session.accessToken;
      },
      refreshed: async () => (await this.refresh(slot)).accessToken,
    };
  }
  /** One refresh, written at once (connect spec 5.6). A refusal throws TokenRefused. */
  async refresh(slot: Slot): Promise<OAuthSession> {
    const before = slot.locate(this.s());
    if (!before) throw new TamlootError('provider_unauthorized');
    const answer = await tokenCall(
      this.client,
      { grant_type: 'refresh_token', refresh_token: before.refreshToken },
      this.tokenOptions(),
    );
    if (answer.kind === 'refused') throw new TokenRefused(answer);
    if (answer.kind === 'rateLimited')
      throw new TamlootError('provider_rate_limited', true, answer.retryAfterSeconds ?? 30);
    if (answer.kind !== 'tokens') throw new TamlootError('provider_unavailable', true);
    const next: OAuthSession = {
      accessToken: answer.accessToken,
      // A refresh answer without a refresh token keeps the old one (connect spec 5.4).
      refreshToken: answer.refreshToken ?? before.refreshToken,
      expiresAt: new Date(this.now() + answer.expiresIn * 1000).toISOString(),
    };
    try {
      await this.save(slot.replace(this.s(), next));
    } catch (error) {
      if (!(error instanceof RetainerApiError && error.code === 'revision_conflict')) throw error;
      // Another run wrote first: use what is stored, never write over it (connect spec 5.3).
      await this.load();
      return (this.store && slot.locate(this.store)) ?? next;
    }
    return next;
  }
  /**
   * Gives up one session (connect spec 5.7). True when done: `204`, or Retainer has
   * no access through it any more. Anything else keeps the tokens and the obligation.
   */
  async giveUp(slot: Slot): Promise<boolean> {
    try {
      await this.provider.release(this.credential(slot));
      return true;
    } catch (error) {
      // A second 401 (or a session that is no longer stored): no access through it now.
      if (error instanceof TamlootError && error.code === 'provider_unauthorized') return true;
      if (error instanceof TokenRefused) {
        if (refreshGone(error.answer)) return true;
        this.setupError ??= refreshFailure(error.answer);
        return false;
      }
      if (error instanceof TamlootError) {
        if (error.code === 'provider_forbidden') this.setupError ??= error.code;
        return false;
      }
      throw error;
    }
  }
  /** Gives up every entry in `release`; never fails the run (connect spec 5.5 step 7, 5.6). */
  async drain(): Promise<void> {
    for (const entry of [...this.s().release]) {
      if (await this.giveUp(entrySlot(entry.id))) {
        const s = this.s();
        await this.save({ ...s, release: s.release.filter((r) => r.id !== entry.id) });
      } else if (this.aged(entry)) this.report.add(`release:${entry.id}`);
    }
  }
  /**
   * Checks each entry with a read that never revokes, and drops the ones Retainer has
   * no access through (connect spec 5.5 step 3).
   */
  async checkBacklog(): Promise<void> {
    for (const entry of [...this.s().release]) {
      let gone = false;
      try {
        await this.provider.request(
          '/v1/me',
          z.unknown(),
          {},
          this.credential(entrySlot(entry.id)),
        );
      } catch (error) {
        if (error instanceof TamlootError && error.code === 'provider_unauthorized') gone = true;
        else if (error instanceof TokenRefused) gone = refreshGone(error.answer);
        else if (!(error instanceof TamlootError)) throw error;
      }
      if (gone) {
        const s = this.s();
        await this.save({ ...s, release: s.release.filter((r) => r.id !== entry.id) });
      } else if (this.aged(entry)) this.report.add(`release:${entry.id}`);
    }
  }
  /**
   * The result with its incidents (connect spec 4.7): every `lost` hash when asked
   * (`connect` and cleanup), and the `release:<id>`s this run tried and could not settle.
   */
  decorate(result: ExecutionResult, includeLost: boolean, extra: string[] = []): ExecutionResult {
    const ids = new Set([
      ...(includeLost ? (this.store?.lost ?? []).map((hash) => `exchange:${hash}`) : []),
      ...extra,
      ...this.report,
    ]);
    const named = this.setupError && !result.code ? { code: this.setupError } : {};
    return {
      ...result,
      ...named,
      ...(ids.size ? { releaseIncomplete: [...ids].slice(0, 8) } : {}),
    };
  }
}

/** Verification of a session: `GET /v1/me` with it, then `verifySource`. */
export type Verify = (credential: TamlootCredential) => Promise<void>;

/** `connect` for an OAuth connection (connect spec 5.5). Throws TamlootError to end the run. */
export async function connectOAuth(
  access: TamlootAccess,
  grant: { code: string | null; verifier: string | null },
  verify: Verify,
  importStep: () => Promise<void>,
): Promise<void> {
  let s = access.store;
  const hash = grant.code ? codeHash(grant.code) : (s?.codeHash ?? null);
  if (!hash) throw new TamlootError('provider_unauthorized');
  // Step 2: stage an earlier code. No session is given up before promotion.
  if (s && s.codeHash !== hash) {
    let next = s;
    if (next.pending)
      next = {
        ...next,
        pending: null,
        release: [...next.release, access.newEntry(next.pending, 'rejected')],
      };
    if (next.exchange === 'started' || (next.exchange === 'ready' && next.uncertain))
      next = { ...addLost(next, next.codeHash), exchange: 'lost' };
    if (next !== s) await access.save(next);
    s = access.s();
  }
  if (!s || s.codeHash !== hash) {
    // Step 3: a new code.
    if (!grant.code || !grant.verifier) throw new TamlootError('provider_unauthorized');
    if (s && s.release.length >= 4) {
      await access.checkBacklog();
      if (access.s().release.length >= 4) throw new TamlootError('release_backlog');
    }
    const latest = access.store;
    if (latest && latest.lost.length >= 4) throw new TamlootError('lost_backlog');
    await access.save({
      codeHash: hash,
      exchange: 'ready',
      uncertain: false,
      failure: null,
      lost: latest?.lost ?? [],
      current: latest?.current ?? null,
      pending: null,
      release: latest?.release ?? [],
    });
    await attempt(access, grant.code, grant.verifier);
    await promote(access, verify);
  } else {
    // Step 4: the same code (a retry, or the connect an upgrade or re-enable queues).
    if (s.failure) throw new TamlootError(s.failure);
    if (s.exchange === 'ready' || s.exchange === 'started') {
      if (!grant.code || !grant.verifier) throw new TamlootError('provider_unauthorized');
      await attempt(access, grant.code, grant.verifier);
      await promote(access, verify);
    } else if (s.exchange === 'exchanged' && s.pending) await promote(access, verify);
    else if (s.exchange === 'promoted') await verify(access.credential(CURRENT));
    else throw new TamlootError('provider_unauthorized');
  }
  // Step 6: the cursor and backfill, with `current`.
  await importStep();
  // Step 7: give up every entry in `release`; a failure here never fails the connect.
  await access.drain();
}

/** One token call for the code, with its answer written before any other call. */
async function attempt(access: TamlootAccess, code: string, verifier: string): Promise<void> {
  let s = access.s();
  if (s.exchange === 'started') s = { ...s, uncertain: true };
  await access.save({ ...s, exchange: 'started' });
  const { client } = access;
  const answer = await tokenCall(
    client,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
    },
    access.tokenOptions(),
  );
  s = access.s();
  switch (answer.kind) {
    case 'tokens':
      await access.save({
        ...s,
        exchange: 'exchanged',
        pending: {
          accessToken: answer.accessToken,
          refreshToken: answer.refreshToken ?? '',
          expiresAt: new Date(access.now() + answer.expiresIn * 1000).toISOString(),
        },
      });
      return;
    case 'rateLimited':
      await access.save({ ...s, exchange: 'ready' });
      throw new TamlootError('provider_rate_limited', true, answer.retryAfterSeconds ?? 30);
    case 'notSent':
      await access.save({ ...s, exchange: 'ready' });
      throw new TamlootError('provider_unavailable', true);
    case 'unknown':
      // `started` stays: the call may have been processed.
      throw new TamlootError('provider_unavailable', true);
    case 'refused': {
      const code = exchangeFailure(answer);
      if (!s.uncertain) {
        await access.save({ ...s, exchange: 'refused', failure: code });
        throw new TamlootError(code);
      }
      const failure = code === 'provider_unauthorized' ? 'exchange_interrupted' : code;
      await access.save({ ...addLost(s, s.codeHash), exchange: 'lost', failure });
      throw new TamlootError(failure);
    }
  }
}

/** Step 5: verify `pending`, then promote it, or move it to `release` as rejected. */
async function promote(access: TamlootAccess, verify: Verify): Promise<void> {
  try {
    await verify(access.credential(PENDING));
  } catch (error) {
    // 429, 5xx, a network error: retry later, `pending` kept.
    if (retryable(error)) throw error;
    const code = finalCode(error);
    if (!code) throw error;
    const s = access.s();
    if (s.pending)
      await access.save({
        ...s,
        pending: null,
        failure: code,
        release: [...s.release, access.newEntry(s.pending, 'rejected')],
      });
    throw new TamlootError(code);
  }
  const s = access.s();
  if (!s.pending) throw new TamlootError('provider_unauthorized');
  await access.save({
    ...s,
    current: s.pending,
    pending: null,
    exchange: 'promoted',
    release: s.current ? [...s.release, access.newEntry(s.current, 'replaced')] : s.release,
  });
}

/**
 * The `disconnect` hook (connect spec 5.7): gives up `pending`, every entry in
 * `release` and, unless asked to keep it, `current`. It writes nothing.
 */
export async function releaseAll(
  deps: AccessDeps,
  input: DisconnectInput,
  client: () => Promise<ExtensionOAuthClient>,
): Promise<ExecutionResult> {
  const stored = await readSecret(deps.sdk, deps.installationId, TAMLOOT_SECRETS.tokens);
  // A key connection, or no exchange ever started.
  if (!stored) return { status: 'succeeded' };
  let store: TokenStore;
  try {
    store = tokenStoreSchema.parse(JSON.parse(stored.value));
  } catch {
    return { status: 'failed', code: 'release_incomplete' };
  }
  const extra =
    store.exchange === 'started' || (store.exchange === 'ready' && store.uncertain)
      ? [`exchange:${store.codeHash}`]
      : [];
  let access: TamlootAccess;
  try {
    access = new TamlootAccess(deps, await client(), true);
  } catch (error) {
    const lost = store.lost.map((hash) => `exchange:${hash}`);
    const ids = [...new Set([...lost, ...extra])];
    const code =
      error instanceof RetainerApiError && error.code === 'oauth_unavailable'
        ? 'oauth_unavailable'
        : error instanceof TamlootError
          ? error.code
          : undefined;
    if (!code) throw error;
    return { status: 'retry', code, ...(ids.length ? { releaseIncomplete: ids } : {}) };
  }
  access.store = store;
  let retry = false;
  if (store.pending && !(await access.giveUp(PENDING))) retry = true;
  for (const entry of store.release)
    if (!(await access.giveUp(entrySlot(entry.id)))) {
      retry = true;
      if (access.aged(entry)) access.report.add(`release:${entry.id}`);
    }
  if (input.keep !== 'current' && store.current && !(await access.giveUp(CURRENT))) retry = true;
  return access.decorate(retry ? { status: 'retry' } : { status: 'succeeded' }, true, extra);
}
