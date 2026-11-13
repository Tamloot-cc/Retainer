import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
export const TAMLOOT_ORIGIN = 'https://api.tamloot.cc';
export class TamlootError extends Error {
  constructor(
    readonly code: string,
    readonly retry = false,
    readonly retryAfterSeconds = 30,
  ) {
    super(code);
  }
}
/** Invocation-local transport. Diagnostics never contain provider bodies or identities. */
export class TamlootProvider {
  // The first call waits too: sequential short jobs must not reset the pacing.
  private nextRequest = Date.now() + 1000;
  constructor(
    private readonly key: string,
    private readonly signal: AbortSignal,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Record<string, string> = {},
  ): Promise<T> {
    if (!/^\/v1\/(?:me|changes(?:\/head)?|sessions(?:\/[0-9a-f-]{36})?|tasks)$/.test(path))
      throw new TamlootError('invalid_provider_path');
    const wait = this.nextRequest - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal: this.signal });
    this.nextRequest = Date.now() + 1000;
    const url = new URL(path, TAMLOOT_ORIGIN);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(20000)]);
    let response: Response;
    try {
      response = await this.transport(url, {
        signal,
        redirect: 'error',
        headers: { authorization: `Bearer ${this.key}` },
      });
    } catch {
      throw new TamlootError('provider_unavailable', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new TamlootError('provider_unauthorized');
      if (response.status === 410 && path === '/v1/changes')
        throw new TamlootError('provider_cursor_expired');
      if ([404, 410].includes(response.status) && path.startsWith('/v1/sessions/'))
        throw new TamlootError('provider_session_deleted');
      if (response.status === 429 || response.status >= 500) {
        const raw = response.headers.get('retry-after'),
          seconds =
            raw && /^\d+(?:\.\d+)?$/.test(raw)
              ? Number(raw)
              : raw
                ? (Date.parse(raw) - Date.now()) / 1000
                : NaN;
        throw new TamlootError(
          response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable',
          true,
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(3600, Math.ceil(seconds))
            : 30 + Math.floor(Math.random() * 15),
        );
      }
      throw new TamlootError('provider_invalid_request');
    }
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
}
