import { createHash } from 'node:crypto';
import type { ExtensionOAuthClient } from '@retainer/extension';
import { z } from 'zod';
import { retryAfter } from './tamloot-provider.js';

/** One Tamloot session: what an exchange or a refresh gives (connect spec 5.3). */
export const oauthSession = z.strictObject({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
});
/** The `oauthTokens` connection secret, parsed on every read (connect spec 5.3). */
export const tokenStoreSchema = z.strictObject({
  /** SHA-256 of the last code this connection was given. */
  codeHash: z.string().length(64),
  /** That code's state (connect spec 5.5). */
  exchange: z.enum(['ready', 'started', 'exchanged', 'promoted', 'refused', 'lost']),
  /** Sticky: an attempt for `codeHash` may have been processed unseen. */
  uncertain: z.boolean(),
  /** Terminal failure code for `codeHash`, replayed on a same-code run. */
  failure: z.string().nullable(),
  /** Unique code hashes of exchanges that may have left a session nobody holds. */
  lost: z.array(z.string().length(64)).max(4),
  /** The verified session runs use. */
  current: oauthSession.nullable(),
  /** Exchanged, not yet verified; never used to import. */
  pending: oauthSession.nullable(),
  /** Sessions to give up in Tamloot. */
  release: z
    .array(
      z.strictObject({
        id: z.uuid(),
        session: oauthSession,
        since: z.iso.datetime({ offset: true }),
        reason: z.enum(['replaced', 'rejected']),
      }),
    )
    .max(4),
});
export type OAuthSession = z.infer<typeof oauthSession>;
export type TokenStore = z.infer<typeof tokenStoreSchema>;
export type ReleaseEntry = TokenStore['release'][number];

export const codeHash = (code: string) => createHash('sha256').update(code).digest('hex');

/** What one token call came to. Bodies are never kept beyond the native error fields. */
export type TokenAnswer =
  | { kind: 'tokens'; accessToken: string; refreshToken?: string; expiresIn: number }
  /** Failed before any byte was sent (DNS, connection refused): certainly not processed. */
  | { kind: 'notSent' }
  | { kind: 'rateLimited'; retryAfterSeconds?: number }
  /** Timeout, connection lost after sending, 5xx or an unreadable success: may have been processed. */
  | { kind: 'unknown' }
  /** Any other answer, with the native `error` and GoTrue's `error_code` as they came. */
  | { kind: 'refused'; status: number; error?: string; errorCode?: string };
export type TokenGrant =
  | { grant_type: 'authorization_code'; code: string; redirect_uri: string; code_verifier: string }
  | { grant_type: 'refresh_token'; refresh_token: string };
export type TokenCallOptions = {
  transport: typeof fetch;
  signal: AbortSignal;
  timeoutMs?: number;
};

const CAP = 64 * 1024;
/** Errors fetch reports when nothing reached the token endpoint. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME']);

/** `https`, or `http` for loopback only (connect spec 4.1); anything else is a setup error. */
export function allowedEndpoint(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) return url;
  return null;
}

async function readCapped(response: Response, signal: AbortSignal): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) return null;
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > CAP) return null;
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * One form post to the token endpoint with HTTP Basic client authentication
 * (connect spec 5.4): 20-second timeout, no redirects, a 64 KiB answer cap, and
 * nothing of the body kept or logged except the native error fields.
 */
export async function tokenCall(
  client: Pick<ExtensionOAuthClient, 'clientId' | 'clientSecret' | 'tokenEndpoint'>,
  grant: TokenGrant,
  options: TokenCallOptions,
): Promise<TokenAnswer> {
  const endpoint = allowedEndpoint(client.tokenEndpoint);
  if (!endpoint) return { kind: 'refused', status: 0, error: 'invalid_client' };
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 20000)]);
  // Raw, not form-encoded: GoTrue reads Basic credentials as Go's BasicAuth does (spike).
  const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');
  let response: Response;
  try {
    response = await options.transport(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(grant).toString(),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    return typeof code === 'string' && NOT_SENT.has(code)
      ? { kind: 'notSent' }
      : { kind: 'unknown' };
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    const after = retryAfter(response.headers);
    return { kind: 'rateLimited', ...(after ? { retryAfterSeconds: after } : {}) };
  }
  if (response.status >= 500) {
    await response.body?.cancel().catch(() => {});
    return { kind: 'unknown' };
  }
  const text = await readCapped(response, signal);
  let body: unknown;
  try {
    body = text === null ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (response.ok) {
    const parsed = z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1).optional(),
        expires_in: z.number().positive(),
      })
      .safeParse(body);
    // A success Retainer cannot read may still have created a session.
    if (!parsed.success) return { kind: 'unknown' };
    return {
      kind: 'tokens',
      accessToken: parsed.data.access_token,
      ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
      expiresIn: parsed.data.expires_in,
    };
  }
  const fields = z
    .object({ error: z.string().max(200).optional(), error_code: z.string().max(200).optional() })
    .safeParse(body);
  return {
    kind: 'refused',
    status: response.status,
    ...(fields.success && fields.data.error ? { error: fields.data.error } : {}),
    ...(fields.success && fields.data.error_code ? { errorCode: fields.data.error_code } : {}),
  };
}

type Refused = Extract<TokenAnswer, { kind: 'refused' }>;
/**
 * Refresh-grant `error_code`s GoTrue v2.197.0 answers for a refresh that cannot
 * succeed (connect spec 5.4). Add a code only after it is observed.
 */
export const REFRESH_DEAD_CODES: ReadonlySet<string> = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'user_banned',
  'session_expired',
]);
const rfcInvalidGrant = (answer: Refused) =>
  answer.status === 400 && answer.error === 'invalid_grant';

/** An exchange refusal: `invalid_grant` is the member's; every other answer is a setup error. */
export function exchangeFailure(
  answer: Refused,
): 'provider_unauthorized' | 'oauth_client_rejected' {
  return rfcInvalidGrant(answer) ? 'provider_unauthorized' : 'oauth_client_rejected';
}
/** A refresh refusal in an ordinary run (an import, `connect`): connect spec 5.4 and 5.8. */
export function refreshFailure(answer: Refused): 'provider_unauthorized' | 'oauth_client_rejected' {
  return rfcInvalidGrant(answer) ||
    (answer.status === 400 && !!answer.errorCode && REFRESH_DEAD_CODES.has(answer.errorCode))
    ? 'provider_unauthorized'
    : 'oauth_client_rejected';
}
/**
 * While giving a session up or checking the backlog, only `refresh_token_not_found`
 * proves GoTrue has no session for the token (connect spec 5.4, 5.7).
 */
export function refreshGone(answer: Refused): boolean {
  return answer.status === 400 && answer.errorCode === 'refresh_token_not_found';
}

/** A refresh the token endpoint refused; each caller classifies it its own way. */
export class TokenRefused extends Error {
  constructor(readonly answer: Refused) {
    super('token_refused');
  }
}
