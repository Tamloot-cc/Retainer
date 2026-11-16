import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
export const TAMLOOT_ORIGIN = 'https://api.tamloot.cc';
/** `Retry-After` in seconds or as an HTTP date, in whole seconds up to an hour; none without one. */
export function retryAfter(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : undefined;
}
export class TamlootError extends Error {
  constructor(
    readonly code: string,
    readonly retry = false,
    readonly retryAfterSeconds = 30,
  ) {
    super(code);
  }
}
/**
 * Where a request's bearer comes from (connect spec 5.6). A key is the bearer. An
 * OAuth session refreshes when close to expiry, and once after a `401`.
 */
export type TamlootCredential = {
  bearer(): Promise<string>;
  /** OAuth only: refresh once after a `401`, store the result, and return the new bearer. */
  refreshed?: () => Promise<string>;
};
export type TamlootProviderOptions = {
  /** The API origin; an OAuth client may name one (connect spec 4.1). */
  origin?: string;
  /** Minimum spacing between requests; tests set 0. */
  pacingMs?: number;
  timeoutMs?: number;
};
const ALLOWED_GET = /^\/v1\/(?:me|changes(?:\/head)?|sessions(?:\/[0-9a-f-]{36})?|tasks)$/;
/** Invocation-local transport. Diagnostics never contain provider bodies or identities. */
export class TamlootProvider {
  // The first call waits too: sequential short jobs must not reset the pacing.
  private nextRequest: number;
  private readonly credential: TamlootCredential;
  private readonly origin: string;
  private readonly pacingMs: number;
  private readonly timeoutMs: number;
  constructor(
    credential: string | TamlootCredential,
    private readonly signal: AbortSignal,
    private readonly transport: typeof fetch = fetch,
    options: TamlootProviderOptions = {},
  ) {
    this.credential =
      typeof credential === 'string' ? { bearer: async () => credential } : credential;
    this.origin = options.origin ?? TAMLOOT_ORIGIN;
    this.pacingMs = options.pacingMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.nextRequest = Date.now() + this.pacingMs;
  }
  /** `DELETE /v1/access`: gives up the session the credential names (connect spec 5.7). */
  async release(credential: TamlootCredential): Promise<void> {
    const { response } = await this.send('DELETE', '/v1/access', {}, credential);
    await response.body?.cancel().catch(() => {});
  }
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
    credential: TamlootCredential = this.credential,
  ): Promise<T> {
    const { response, signal } = await this.send('GET', path, query, credential);
    const reader = response.body?.getReader();
    if (!reader) throw new TamlootError('provider_invalid_response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new TamlootError('provider_content_too_large');
        chunks.push(part.value);
      }
      return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof TamlootError) throw error;
      throw new TamlootError(
        signal.aborted ? 'provider_unavailable' : 'provider_invalid_response',
        signal.aborted,
      );
    } finally {
      reader.releaseLock();
    }
  }
  private async send(
    method: 'GET' | 'DELETE',
    path: string,
    query: Record<string, string>,
    credential: TamlootCredential,
  ): Promise<{ response: Response; signal: AbortSignal }> {
    // DELETE /v1/access is the only request that is not a GET.
    if (method === 'DELETE' ? path !== '/v1/access' : !ALLOWED_GET.test(path))
      throw new TamlootError('invalid_provider_path');
    const oauth = !!credential.refreshed;
    let bearer = await credential.bearer();
    for (let attempt = 0; ; attempt++) {
      const wait = this.nextRequest - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal: this.signal });
      this.nextRequest = Date.now() + this.pacingMs;
      const url = new URL(path, this.origin);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]);
      let response: Response;
      try {
        response = await this.transport(url, {
          method,
          signal,
          redirect: 'error',
          headers: { authorization: `Bearer ${bearer}` },
        });
      } catch {
        throw new TamlootError('provider_unavailable', true);
      }
      if (response.ok) return { response, signal };
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 && attempt === 0 && credential.refreshed) {
        // Tamloot's contract: refresh once on 401 and repeat the request.
        bearer = await credential.refreshed();
        continue;
      }
      if (response.status === 401) throw new TamlootError('provider_unauthorized');
      // An OAuth 403 is a bug or a setup error, never the member's to fix (connect spec 5.8).
      if (response.status === 403)
        throw new TamlootError(oauth ? 'provider_forbidden' : 'provider_unauthorized');
      if (response.status === 410 && path === '/v1/changes')
        throw new TamlootError('provider_cursor_expired');
      if ([404, 410].includes(response.status) && path.startsWith('/v1/sessions/'))
        throw new TamlootError('provider_session_deleted');
      if (response.status === 429 || response.status >= 500) {
        throw new TamlootError(
          response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable',
          true,
          retryAfter(response.headers) ?? 30 + Math.floor(Math.random() * 15),
        );
      }
      throw new TamlootError('provider_invalid_request');
    }
  }
}
