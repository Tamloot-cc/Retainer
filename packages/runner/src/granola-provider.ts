import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import { granolaNote, granolaNoteId, granolaTranscriptPage } from './granola-contract.js';

export const GRANOLA_ORIGIN = 'https://public-api.granola.ai';
export const GRANOLA_TRANSCRIPT_BYTES = 25 * 1024 * 1024;
/** Never include provider response bodies, URLs with queries, credentials or note IDs in diagnostics. */
export class GranolaError extends Error {
  constructor(
    readonly code: string,
    readonly retry = false,
    readonly retryAfterSeconds = 30,
  ) {
    super(code);
  }
}
export class GranolaProvider {
  private nextRequest = 0;
  constructor(
    private readonly key: string,
    private readonly signal: AbortSignal,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      query?: Record<string, string>;
      body?: unknown;
      allowMissing?: boolean;
      empty?: boolean;
    } = {},
  ): Promise<T> {
    if (
      !/^\/v1\/(?:notes(?:\/not_[a-z0-9]{14}(?:\/transcript)?)?|webhook-endpoints(?:\/whe_[A-Za-z0-9]{14})?)$/.test(
        path,
      )
    )
      throw new GranolaError('invalid_provider_path');
    const wait = this.nextRequest - Date.now();
    if (wait > 0) await delay(wait, undefined, { signal: this.signal });
    this.nextRequest = Date.now() + 250;
    const url = new URL(path, GRANOLA_ORIGIN);
    for (const [name, value] of Object.entries(options.query ?? {}))
      url.searchParams.set(name, value);
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(20000)]);
    let response: Response;
    try {
      response = await this.transport(url, {
        method: options.method ?? 'GET',
        signal,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.key}`,
          ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw new GranolaError('provider_unavailable', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new GranolaError('provider_unauthorized');
      if (response.status === 404 && options.allowMissing) return undefined as T;
      if (response.status === 413) throw new GranolaError('provider_transcript_too_large');
      if (response.status === 400) throw new GranolaError('provider_invalid_request');
      if (response.status === 404) throw new GranolaError('provider_note_unavailable', true);
      const seconds = Number(response.headers.get('retry-after'));
      throw new GranolaError(
        response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable',
        true,
        Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : 30,
      );
    }
    if (options.empty) {
      await response.body?.cancel();
      return undefined as T;
    }
    const max = GRANOLA_TRANSCRIPT_BYTES + 1024 * 1024;
    const reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    if (!reader) throw new GranolaError('provider_invalid_response');
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > max) throw new GranolaError('provider_content_too_large');
        chunks.push(part.value);
      }
      return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof GranolaError) throw error;
      throw new GranolaError(
        signal.aborted ? 'provider_unavailable' : 'provider_invalid_response',
        signal.aborted,
      );
    }
  }
  async note(id: string) {
    const canonical = granolaNoteId.parse(id);
    let note: z.infer<typeof granolaNote>;
    try {
      note = await this.request(`/v1/notes/${canonical}`, granolaNote, {
        query: { include: 'transcript' },
      });
    } catch (error) {
      if (!(error instanceof GranolaError) || error.code !== 'provider_transcript_too_large')
        throw error;
      note = await this.request(`/v1/notes/${canonical}`, granolaNote);
      const transcript: z.infer<typeof granolaTranscriptPage>['transcript'] = [],
        seen = new Set<string>();
      let cursor: string | undefined,
        bytes = 2;
      for (let page = 0; ; page++) {
        if (page >= 10000) throw new GranolaError('provider_pagination_stalled');
        const result = await this.request(
          `/v1/notes/${canonical}/transcript`,
          granolaTranscriptPage,
          { query: { page_size: '100', ...(cursor ? { cursor } : {}) } },
        );
        bytes += Buffer.byteLength(JSON.stringify(result.transcript));
        if (bytes > GRANOLA_TRANSCRIPT_BYTES) throw new GranolaError('provider_content_too_large');
        transcript.push(...result.transcript);
        if (!result.hasMore) break;
        if (!result.cursor || seen.has(result.cursor))
          throw new GranolaError('provider_pagination_stalled');
        seen.add(result.cursor);
        cursor = result.cursor;
      }
      const latest = await this.request(`/v1/notes/${canonical}`, granolaNote);
      if (
        latest.id !== note.id ||
        latest.updated_at !== note.updated_at ||
        latest.deleted_at !== note.deleted_at
      )
        throw new GranolaError('provider_revision_changed', true);
      note.transcript = transcript;
    }
    if (note.id !== canonical) throw new GranolaError('provider_identity_mismatch');
    if (
      note.transcript &&
      Buffer.byteLength(JSON.stringify(note.transcript)) > GRANOLA_TRANSCRIPT_BYTES
    )
      throw new GranolaError('provider_content_too_large');
    return note;
  }
}
