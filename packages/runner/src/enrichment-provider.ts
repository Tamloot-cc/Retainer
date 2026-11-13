import { normalizeDomain } from '@retainer/shared';
import type { z } from 'zod';
import {
  type EnrichmentOutput,
  EXA_ORIGIN,
  exaCompanyEntity,
  exaSearchRequest,
  exaSearchResponse,
  exaTeam,
} from './enrichment-contract.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 15000;

/** Codes only: never a provider body, a key or the domain looked up. */
export class ExaError extends Error {
  constructor(
    readonly code: string,
    readonly retry = false,
    readonly retryAfterSeconds = 30,
  ) {
    super(code);
  }
}

export type EnrichmentValues = Partial<Record<EnrichmentOutput, unknown>>;
export type LookupResult = { status: 'no_match' } | { status: 'match'; values: EnrichmentValues };

const LINKEDIN_LINE =
  /^- LinkedIn: (?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([A-Za-z0-9_%-]{1,100})\/?$/m;
const HOMEPAGE_LINE = /^- Homepage: (\S{1,2048})$/m;

/**
 * Exa's company search by domain (spec 4.3). Search is not a keyed lookup, so a
 * result counts only when its homepage normalizes to the looked-up domain, it
 * carries a company entity, and any `Homepage:` line in its profile agrees.
 */
export function companyFromSearch(
  domain: string,
  body: z.infer<typeof exaSearchResponse>,
): LookupResult {
  const result = body.results[0];
  if (!result || normalizeDomain(result.url) !== domain) return { status: 'no_match' };
  const entity = (result.entities ?? [])
    .map((candidate) => exaCompanyEntity.safeParse(candidate))
    .find((parsed) => parsed.success)?.data;
  if (!entity) return { status: 'no_match' };
  const profile = result.text ?? '';
  const homepage = HOMEPAGE_LINE.exec(profile)?.[1];
  if (homepage !== undefined && normalizeDomain(homepage) !== domain) return { status: 'no_match' };
  const values: EnrichmentValues = {};
  const total = entity.properties.workforce?.total;
  if (typeof total === 'number' && Number.isFinite(total)) {
    const count = Math.round(total);
    if (count >= 0 && count <= 10_000_000) values.employee_count = count;
  }
  const slug = LINKEDIN_LINE.exec(profile)?.[1];
  if (slug)
    values.linkedin_url = {
      primary: { url: `https://www.linkedin.com/company/${slug}` },
      additional: [],
    };
  const hq = entity.properties.headquarters;
  // `address` is not used: Exa returns a locality there, not a street.
  const address = Object.fromEntries(
    (
      [
        ['city', hq?.city],
        ['postcode', hq?.postalCode],
        ['country', hq?.country],
      ] as const
    ).flatMap(([key, value]) =>
      typeof value === 'string' && value.trim() ? [[key, value.trim()]] : [],
    ),
  );
  if (Object.keys(address).length) values.headquarters = address;
  return { status: 'match', values };
}

export class ExaProvider {
  constructor(
    private readonly key: string,
    private readonly signal: AbortSignal,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private async request<T>(
    path: '/search' | '/websets/v0/teams/me',
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    let response: Response;
    try {
      response = await this.transport(new URL(path, EXA_ORIGIN), {
        method: body ? 'POST' : 'GET',
        signal,
        redirect: 'error',
        headers: {
          'x-api-key': this.key,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ExaError('provider_unavailable', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new ExaError('provider_unauthorized');
      if (response.status === 402) throw new ExaError('provider_payment_required');
      if (response.status === 404) throw new ExaError('provider_not_found');
      if (response.status === 429 || response.status >= 500) {
        const seconds = Number(response.headers.get('retry-after'));
        throw new ExaError(
          response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable',
          true,
          Number.isFinite(seconds) && seconds > 0 ? Math.min(3600, Math.ceil(seconds)) : 30,
        );
      }
      throw new ExaError('provider_invalid_request');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ExaError('provider_invalid_response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > MAX_RESPONSE_BYTES) throw new ExaError('provider_invalid_response');
        chunks.push(part.value);
      }
      return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof ExaError) throw error;
      throw new ExaError(
        signal.aborted ? 'provider_unavailable' : 'provider_invalid_response',
        signal.aborted,
      );
    }
  }

  /**
   * Checks the key with Exa's free team-info call. That call is part of
   * Websets, which only Pro teams can use: a key without it gets 401 there but
   * works for search, so a missing path or a refusal falls back to one search
   * for exa.ai. An invalid key is refused by that search too.
   */
  async check(): Promise<void> {
    try {
      await this.request('/websets/v0/teams/me', exaTeam);
    } catch (error) {
      if (
        !(error instanceof ExaError) ||
        (error.code !== 'provider_not_found' && error.code !== 'provider_unauthorized')
      )
        throw error;
      await this.request('/search', exaSearchResponse, exaSearchRequest('exa.ai'));
    }
  }

  async lookup(domain: string): Promise<LookupResult> {
    return companyFromSearch(
      domain,
      await this.request('/search', exaSearchResponse, exaSearchRequest(domain)),
    );
  }
}
