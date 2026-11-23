import { defineExtension, functionSecrets } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TAMLOOT, TAMLOOT_FUNCTION_IDS, tamlootManifest } from './tamloot-contract.js';
import {
  codeHash,
  exchangeFailure,
  REFRESH_DEAD_CODES,
  refreshFailure,
  refreshGone,
  type TokenAnswer,
  type TokenGrant,
  tokenCall,
} from './tamloot-oauth.js';
import { TamlootProvider } from './tamloot-provider.js';

const client = {
  clientId: 'client-1',
  clientSecret: 's3cret',
  tokenEndpoint: 'https://db.tamloot.test/auth/v1/oauth/token',
};
const exchange: TokenGrant = {
  grant_type: 'authorization_code',
  code: 'code-1',
  redirect_uri: 'https://retainer.test/app/connect/callback',
  code_verifier: 'verifier-1',
};
const refresh: TokenGrant = { grant_type: 'refresh_token', refresh_token: 'rt-1' };
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  tokenCall(client, exchange, {
    signal: new AbortController().signal,
    transport: async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }),
  });
const refused = (status: number, body: Record<string, unknown>) =>
  ({
    kind: 'refused',
    status,
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
    ...(typeof body.error_code === 'string' ? { errorCode: body.error_code } : {}),
  }) as Extract<TokenAnswer, { kind: 'refused' }>;

describe('Tamloot OAuth contract (connect spec 5.1)', () => {
  const manifest = tamlootManifest({
    packageDigest: 'a'.repeat(64),
    handlerDigest: 'b'.repeat(64),
    serverRange: '>=0.1.0 <0.2.0',
  });
  it('declares the OAuth settings, blocks and a disconnect hook', () => {
    expect(manifest.settings.apiKey).toMatchObject({ required: false, secret: true });
    for (const name of ['oauthVerifier', 'oauthCode', 'oauthTokens'])
      expect(manifest.settings[name]).toMatchObject({
        type: 'string',
        level: 'connection',
        secret: true,
        generated: true,
        required: false,
      });
    expect(manifest.oauth).toEqual({
      verifierSetting: 'oauthVerifier',
      codeSetting: 'oauthCode',
      tokenSetting: 'oauthTokens',
      keySetting: 'apiKey',
      revokeUrl: 'https://app.tamloot.cc/dashboard/settings?tab=apps',
    });
    expect(manifest.gettingStarted).toEqual({
      text: 'No meetings to import yet. Record a meeting with Tamloot and it shows up here a few minutes after it ends.',
      linkLabel: 'Open Tamloot',
      url: 'https://app.tamloot.cc',
    });
    const disconnect = manifest.functions.find((fn) => fn.universalId === TAMLOOT.disconnect);
    expect(disconnect).toMatchObject({
      name: 'disconnect',
      trigger: { kind: 'disconnect' },
      timeoutSeconds: 60,
    });
    expect(TAMLOOT_FUNCTION_IDS).toContain(TAMLOOT.disconnect);
    expect(new Set(manifest.functions.map((fn) => fn.universalId)).size).toBe(6);
    expect(() => defineExtension(manifest)).not.toThrow();
  });
  it('gives each function exactly the secrets it reads', () => {
    const secrets = (id: string) =>
      functionSecrets(manifest, manifest.functions.find((fn) => fn.universalId === id)!);
    expect(secrets(TAMLOOT.connect).sort()).toEqual(
      ['apiKey', 'oauthCode', 'oauthTokens', 'oauthVerifier'].sort(),
    );
    for (const id of [TAMLOOT.poll, TAMLOOT.scan, TAMLOOT.sync])
      expect(secrets(id)).toEqual(['apiKey', 'oauthTokens']);
    expect(secrets(TAMLOOT.disconnect)).toEqual(['oauthTokens']);
    // Configure runs before anyone connects, so it reads no connection secret.
    expect(secrets(TAMLOOT.configure)).toEqual([]);
  });
});

describe('token calls (connect spec 5.4)', () => {
  it('posts a form with HTTP Basic, refuses redirects and sends nothing else', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const result = await tokenCall(client, exchange, {
      signal: new AbortController().signal,
      transport: async (url, init) => {
        seen.push({ url: String(url), init });
        return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
      },
    });
    expect(result).toEqual({
      kind: 'tokens',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresIn: 3600,
    });
    const [call] = seen;
    expect(call?.url).toBe(client.tokenEndpoint);
    expect(call?.init?.method).toBe('POST');
    expect(call?.init?.redirect).toBe('error');
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from('client-1:s3cret').toString('base64')}`,
    );
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(String(call?.init?.body)))).toEqual(exchange);
  });
  it('refresh keeps the old refresh token when the answer has none', async () => {
    const result = await tokenCall(client, refresh, {
      signal: new AbortController().signal,
      transport: async () => Response.json({ access_token: 'at2', expires_in: 60 }),
    });
    expect(result).toEqual({ kind: 'tokens', accessToken: 'at2', expiresIn: 60 });
  });
  it('treats a success it cannot read as maybe processed', async () => {
    for (const body of [
      { access_token: 'at' },
      { access_token: 'at', expires_in: 0 },
      { expires_in: 60 },
      'not json',
      'x'.repeat(64 * 1024 + 1),
    ])
      expect(await answer(200, body)).toEqual({ kind: 'unknown' });
  });
  it('a 429 with any body is rate limited; a 5xx may have been processed', async () => {
    for (const body of [{ error: 'invalid_grant' }, { error_code: 'over_request_rate_limit' }, ''])
      expect(await answer(429, body, { 'retry-after': '90' })).toEqual({
        kind: 'rateLimited',
        retryAfterSeconds: 90,
      });
    expect(await answer(503, { error: 'invalid_grant' })).toEqual({ kind: 'unknown' });
  });
  it('tells a call that was never sent from one that timed out', async () => {
    const notSent = await tokenCall(client, exchange, {
      signal: new AbortController().signal,
      transport: async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      },
    });
    expect(notSent).toEqual({ kind: 'notSent' });
    const timedOut = await tokenCall(client, exchange, {
      signal: new AbortController().signal,
      timeoutMs: 20,
      transport: (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    });
    expect(timedOut).toEqual({ kind: 'unknown' });
    const reset = await tokenCall(client, exchange, {
      signal: new AbortController().signal,
      transport: async () => {
        throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
      },
    });
    expect(reset).toEqual({ kind: 'unknown' });
  });
  it('returns the native error fields and nothing else of the body', async () => {
    const result = await answer(400, {
      code: 400,
      error_code: 'refresh_token_not_found',
      msg: 'PRIVATE',
      error_description: 'PRIVATE',
    });
    expect(result).toEqual({ kind: 'refused', status: 400, errorCode: 'refresh_token_not_found' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('refuses an endpoint that is not https, except loopback http', async () => {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      return Response.json({});
    };
    for (const tokenEndpoint of ['http://db.tamloot.test/token', 'ftp://x/token', 'nope'])
      expect(
        await tokenCall({ ...client, tokenEndpoint }, exchange, {
          signal: new AbortController().signal,
          transport,
        }),
      ).toMatchObject({ kind: 'refused' });
    expect(calls).toBe(0);
  });
});

describe('classifying GoTrue answers (connect spec 5.4, 5.8, observed bodies)', () => {
  const observed = {
    spentCode: refused(400, { error: 'invalid_grant', error_description: 'Invalid code' }),
    notFound: refused(400, { code: 400, error_code: 'refresh_token_not_found' }),
    alreadyUsed: refused(400, { code: 400, error_code: 'refresh_token_already_used' }),
    banned: refused(400, { code: 400, error_code: 'user_banned' }),
    expired: refused(400, { code: 400, error_code: 'session_expired' }),
    otherClient: refused(400, { error: 'invalid_client' }),
    badCredentials: refused(400, { code: 400, error_code: 'invalid_credentials' }),
  };
  it('names exactly the four observed refresh codes', () => {
    expect([...REFRESH_DEAD_CODES].sort()).toEqual(
      [
        'refresh_token_already_used',
        'refresh_token_not_found',
        'session_expired',
        'user_banned',
      ].sort(),
    );
  });
  it('an ordinary run treats every dead refresh as the member’s: provider_unauthorized', () => {
    for (const a of [
      observed.notFound,
      observed.alreadyUsed,
      observed.banned,
      observed.expired,
      refused(400, { error: 'invalid_grant' }),
    ])
      expect(refreshFailure(a)).toBe('provider_unauthorized');
  });
  it('giving a session up counts only refresh_token_not_found as done', () => {
    expect(refreshGone(observed.notFound)).toBe(true);
    for (const a of [
      observed.alreadyUsed,
      observed.banned,
      observed.expired,
      refused(400, { error: 'invalid_grant' }),
      observed.otherClient,
      observed.badCredentials,
    ])
      expect(refreshGone(a)).toBe(false);
  });
  it('client and unknown refusals are setup errors on either grant', () => {
    for (const a of [
      observed.otherClient,
      observed.badCredentials,
      refused(401, { error: 'invalid_client' }),
      refused(401, { error: 'invalid_grant' }),
      refused(400, { error: 'invalid_request' }),
      refused(400, { error: 'invalid_scope' }),
      refused(400, { error: 'unauthorized_client' }),
      refused(400, { error: 'unsupported_grant_type' }),
      refused(400, { code: 400, error_code: 'validation_failed' }),
      refused(400, {}),
      refused(404, {}),
    ]) {
      expect(exchangeFailure(a)).toBe('oauth_client_rejected');
      expect(refreshFailure(a)).toBe('oauth_client_rejected');
    }
  });
  it('the refresh codes are not the member’s on an exchange', () => {
    expect(exchangeFailure(observed.spentCode)).toBe('provider_unauthorized');
    for (const a of [observed.notFound, observed.alreadyUsed, observed.banned, observed.expired])
      expect(exchangeFailure(a)).toBe('oauth_client_rejected');
  });
  it('hashes a code as lowercase SHA-256 hex', () => {
    expect(codeHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('provider with OAuth (connect spec 5.6, 5.7, 5.8)', () => {
  const signal = new AbortController().signal;
  it('allows DELETE /v1/access as the only request that is not a GET', async () => {
    const calls: { method?: string; path: string }[] = [];
    const provider = new TamlootProvider(
      'key',
      signal,
      async (url, init) => {
        calls.push({ method: init?.method, path: new URL(String(url)).pathname });
        return new Response(null, { status: 204 });
      },
      { pacingMs: 0 },
    );
    await provider.release({ bearer: async () => 'at' });
    expect(calls).toEqual([{ method: 'DELETE', path: '/v1/access' }]);
    await expect(provider.request('/v1/access', z.unknown())).rejects.toMatchObject({
      code: 'invalid_provider_path',
    });
  });
  it('refreshes once on 401 and repeats; a second 401 is provider_unauthorized', async () => {
    const bearers: (string | null)[] = [];
    let status = 401;
    const provider = new TamlootProvider(
      'unused',
      signal,
      async (_url, init) => {
        bearers.push(new Headers(init?.headers).get('authorization'));
        return Response.json({ ok: true }, { status });
      },
      { pacingMs: 0, origin: 'http://127.0.0.1:1' },
    );
    let refreshes = 0;
    const credential = {
      bearer: async () => 'old',
      refreshed: async () => {
        refreshes++;
        status = 200;
        return 'new';
      },
    };
    expect(await provider.request('/v1/me', z.unknown(), {}, credential)).toEqual({ ok: true });
    expect(bearers).toEqual(['Bearer old', 'Bearer new']);
    status = 401;
    const stuck = { ...credential, refreshed: async () => 'still-bad' };
    await expect(provider.request('/v1/me', z.unknown(), {}, stuck)).rejects.toMatchObject({
      code: 'provider_unauthorized',
    });
  });
  it('an OAuth 403 with any code is provider_forbidden; a key 403 stays unauthorized', async () => {
    for (const body of [{ code: 'forbidden' }, { message: 'Forbidden' }, {}]) {
      const provider = new TamlootProvider(
        'key',
        signal,
        async () => Response.json(body, { status: 403 }),
        { pacingMs: 0 },
      );
      await expect(
        provider.request(
          '/v1/me',
          z.unknown(),
          {},
          {
            bearer: async () => 'at',
            refreshed: async () => 'at2',
          },
        ),
      ).rejects.toMatchObject({ code: 'provider_forbidden' });
      await expect(provider.request('/v1/me', z.unknown())).rejects.toMatchObject({
        code: 'provider_unauthorized',
      });
    }
  });
});
