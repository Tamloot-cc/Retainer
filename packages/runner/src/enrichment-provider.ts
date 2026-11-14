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
export type ExaSearch = z.infer<typeof exaSearchResponse>;

const LINKEDIN_LINE =
  /^- LinkedIn: (?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([A-Za-z0-9_%-]{1,100})\/?$/m;
const HOMEPAGE_LINE = /^- Homepage: (\S{1,2048})$/m;
const EXCERPT_CHARACTERS = 1500;

/** One search result that carries a company entity (model calls spec 6.3, step 2). */
export type Candidate = {
  index: number;
  url: string;
  name: string | null;
  /** The profile's `Homepage:` line, when it has one. */
  homepage: string | null;
  linkedin: string | null;
  headquarters: { city?: string; postcode?: string; country?: string } | null;
  workforce: number | null;
  excerpt: string;
};

/** The search results Exa returned as companies, numbered from 0 in its order. */
export function companyCandidates(body: ExaSearch): Candidate[] {
  return body.results
    .flatMap((result) => {
      const entity = (result.entities ?? [])
        .map((candidate) => exaCompanyEntity.safeParse(candidate))
        .find((parsed) => parsed.success)?.data;
      if (!entity) return [];
      const profile = result.text ?? '';
      const slug = LINKEDIN_LINE.exec(profile)?.[1];
      const total = entity.properties.workforce?.total;
      const hq = entity.properties.headquarters;
      // `address` is not used: Exa returns a locality there, not a street.
      const headquarters = Object.fromEntries(
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
      const name = entity.properties.name?.trim() || result.title?.trim() || null;
      return [
        {
          index: 0,
          url: result.url,
          name,
          homepage: HOMEPAGE_LINE.exec(profile)?.[1] ?? null,
          linkedin: slug ? `https://www.linkedin.com/company/${slug}` : null,
          headquarters: Object.keys(headquarters).length ? headquarters : null,
          workforce:
            typeof total === 'number' && Number.isFinite(total) && total >= 0 && total <= 10_000_000
              ? Math.round(total)
              : null,
          excerpt: profile.slice(0, EXCERPT_CHARACTERS),
        },
      ];
    })
    .map((candidate, index) => ({ ...candidate, index }));
}

/** Its result is on the domain, and any `Homepage:` line in its profile agrees. */
const onDomainStrictly = (candidate: Candidate, domain: string) =>
  normalizeDomain(candidate.url) === domain &&
  (candidate.homepage === null || normalizeDomain(candidate.homepage) === domain);

/**
 * Today's rule, kept as a shortcut (spec 6.3, step 3): exactly one candidate on
 * the domain, with no `Homepage:` line naming another. No model call.
 */
export function shortcut(domain: string, candidates: Candidate[]): Candidate | undefined {
  const matches = candidates.filter((candidate) => onDomainStrictly(candidate, domain));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Where the company says its site is: the profile's `Homepage:` line, or the
 * result's URL when the profile has none.
 */
export const candidateDomain = (candidate: Candidate) =>
  normalizeDomain(candidate.homepage ?? candidate.url);

const LEGAL_SUFFIXES = new Set([
  'ab',
  'ag',
  'as',
  'bv',
  'co',
  'company',
  'corp',
  'corporation',
  'gmbh',
  'inc',
  'incorporated',
  'kg',
  'limited',
  'llc',
  'llp',
  'lp',
  'ltd',
  'nv',
  'oy',
  'plc',
  'pte',
  'pty',
  'sa',
  'sarl',
  'sas',
  'spa',
  'srl',
]);
/** A company name compared by its words: case, punctuation and legal suffixes dropped. */
export function normalizeCompanyName(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    // Dotted abbreviations are one word: S.A. is SA.
    .replace(/\./g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] ?? '')) words.pop();
  return words.join(' ');
}

export type Certainty = 'high' | 'medium' | 'low';
/**
 * Enrichment's own guards on a model pick (spec 6.3): a pick on the record's
 * domain is accepted at `high` or `medium`; one on another domain only at
 * `high` and when its name matches the record's; `low` never.
 */
export function acceptPick(
  pick: { candidate: Candidate; certainty: Certainty },
  record: { domain: string; name: string | null },
): boolean {
  if (pick.certainty === 'low') return false;
  if (candidateDomain(pick.candidate) === record.domain) return true;
  if (pick.certainty !== 'high' || !record.name || !pick.candidate.name) return false;
  const name = normalizeCompanyName(record.name);
  return name !== '' && name === normalizeCompanyName(pick.candidate.name);
}

/** The output values of the chosen candidate (enrichment spec 4.3). */
export function candidateValues(candidate: Candidate): EnrichmentValues {
  const values: EnrichmentValues = {};
  if (candidate.workforce !== null) values.employee_count = candidate.workforce;
  if (candidate.linkedin)
    values.linkedin_url = { primary: { url: candidate.linkedin }, additional: [] };
  if (candidate.headquarters) values.headquarters = candidate.headquarters;
  return values;
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
      await this.request('/search', exaSearchResponse, {
        query: 'exa.ai',
        type: 'auto',
        category: 'company',
        numResults: 1,
      });
    }
  }

  /** The company candidates for a record's domain and name. */
  async search(domain: string, name?: string | null): Promise<Candidate[]> {
    return companyCandidates(
      await this.request('/search', exaSearchResponse, exaSearchRequest(domain, name)),
    );
  }
}
