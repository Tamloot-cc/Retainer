import { normalizeDomain } from '@retainer/shared';
import type { z } from 'zod';
import {
  type Certainty,
  EXA_ORIGIN,
  exaCompanyEntity,
  exaPeopleRequest,
  exaPersonEntity,
  exaProfileRequest,
  exaSearchRequest,
  exaSearchResponse,
  exaTeam,
} from './enrichment-contract.js';
import { retryAfterSeconds } from './outcome.js';

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

export type EnrichmentValues = Record<string, unknown>;
type ExaSearch = z.infer<typeof exaSearchResponse>;

const LINKEDIN_LINE =
  /^- LinkedIn: (?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([A-Za-z0-9_%-]{1,100})\/?$/m;
const HOMEPAGE_LINE = /^- Homepage: (\S{1,2048})$/m;
const EXCERPT_CHARACTERS = 1500;

/** Values of a company profile that only fill outputs; the pick doesn't need them. */
export type CompanyDetails = {
  industry: string | null;
  foundedYear: number | null;
  description: string | null;
  revenue: number | null;
  funding: number | null;
  lastRound: { name: string | null; date: string | null; amount: number | null } | null;
  visits: number | null;
};

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
  details: CompanyDetails;
};

const INDUSTRY_LINE = /^- Industry: (.{1,200})$/m;
const DESCRIPTION_CHARACTERS = 2000;
const THIS_YEAR = new Date().getUTCFullYear();

/** A whole number in [min, max], or null. */
function whole(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? Math.round(value)
    : null;
}
/** Trimmed text, or null when blank. */
const trimmed = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : null;
/** At most `max` characters, cut at a word boundary. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
/** Exa writes round names in sentence case ("Series a"); a series letter reads upper case. */
const roundName = (value: unknown) =>
  trimmed(value)?.replace(
    /^series ([a-z])\b/i,
    (_, letter: string) => `Series ${letter.toUpperCase()}`,
  ) ?? null;
/** A real calendar date as YYYY-MM-DD, or null. */
function calendarDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    date.getUTCFullYear() >= 1900 &&
    date.getUTCFullYear() <= THIS_YEAR + 1
    ? value
    : null;
}
/** US dollars as a money value, when its micros are an exact integer. */
function usd(value: number | null) {
  if (value === null) return undefined;
  const amountMicros = value * 1_000_000;
  return Number.isSafeInteger(amountMicros) ? { amountMicros, currency: 'USD' } : undefined;
}

/** The results that carry an entity of `schema`, built and numbered from 0 in Exa's order. */
function entityResults<E, C>(
  body: ExaSearch,
  schema: z.ZodType<E>,
  build: (result: ExaSearch['results'][number], entity: E) => C,
): (C & { index: number })[] {
  return body.results
    .flatMap((result) => {
      const entity = (result.entities ?? [])
        .map((candidate) => schema.safeParse(candidate))
        .find((parsed) => parsed.success)?.data;
      return entity ? [build(result, entity)] : [];
    })
    .map((candidate, index) => ({ index, ...candidate }));
}

/** The search results Exa returned as companies, numbered from 0 in its order. */
export function companyCandidates(body: ExaSearch): Candidate[] {
  return entityResults(body, exaCompanyEntity, (result, entity) => {
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
    const { financials, webTraffic } = entity.properties;
    const round = financials?.fundingLatestRound;
    const money = (value: unknown) => whole(value, 0, 10_000_000_000_000);
    const lastRound = round
      ? {
          name: roundName(round.name),
          date: calendarDate(round.date),
          amount: money(round.amount),
        }
      : null;
    const description = trimmed(entity.properties.description);
    return {
      url: result.url,
      name,
      homepage: HOMEPAGE_LINE.exec(profile)?.[1] ?? null,
      linkedin: slug ? `https://www.linkedin.com/company/${slug}` : null,
      headquarters: Object.keys(headquarters).length ? headquarters : null,
      workforce: whole(total, 0, 10_000_000),
      excerpt: profile.slice(0, EXCERPT_CHARACTERS),
      details: {
        industry: trimmed(INDUSTRY_LINE.exec(profile)?.[1]),
        foundedYear: whole(entity.properties.foundedYear, 1600, THIS_YEAR),
        description: description && clip(description, DESCRIPTION_CHARACTERS),
        revenue: money(financials?.revenueAnnual),
        funding: money(financials?.fundingTotal),
        lastRound:
          lastRound && (lastRound.name || lastRound.date || lastRound.amount !== null)
            ? lastRound
            : null,
        visits: whole(webTraffic?.visitsMonthly, 0, 100_000_000_000),
      },
    };
  });
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
const candidateDomain = (candidate: Candidate) =>
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
/** Lower case without accents. */
const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
/** The letters-and-digits words of folded text. */
const words = (text: string) =>
  text
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

export function normalizeCompanyName(name: string): string {
  const parts = words(
    fold(name)
      .replace(/&/g, ' and ')
      // Dotted abbreviations are one word: S.A. is SA.
      .replace(/\./g, ''),
  );
  while (parts.length > 1 && LEGAL_SUFFIXES.has(parts[parts.length - 1] ?? '')) parts.pop();
  return parts.join(' ');
}

/**
 * Enrichment's own guards on a model pick (spec 6.3): a pick on the record's
 * domain is accepted at `high` or `medium`; one on another domain only at
 * `high` and when its name matches the record's; `low` never.
 */
export function acceptPick(
  pick: { candidate: Candidate; certainty: Certainty },
  record: { domain: string | null; name: string | null },
): boolean {
  if (pick.certainty === 'low') return false;
  if (record.domain && candidateDomain(pick.candidate) === record.domain) return true;
  if (pick.certainty !== 'high' || !record.name || !pick.candidate.name) return false;
  const name = normalizeCompanyName(record.name);
  return name !== '' && name === normalizeCompanyName(pick.candidate.name);
}

/** The output values of the chosen candidate (enrichment spec 4.3, 9.2). */
export function candidateValues(candidate: Candidate): EnrichmentValues {
  const values: EnrichmentValues = {};
  const { details } = candidate;
  if (candidate.workforce !== null) values.employee_count = candidate.workforce;
  if (candidate.linkedin)
    values.linkedin_url = { primary: { url: candidate.linkedin }, additional: [] };
  if (candidate.headquarters) values.headquarters = candidate.headquarters;
  if (details.description) values.description = details.description;
  if (details.industry) values.industry = details.industry;
  if (details.foundedYear !== null) values.founded_year = details.foundedYear;
  const revenue = usd(details.revenue);
  if (revenue) values.annual_revenue = revenue;
  const funding = usd(details.funding);
  if (funding) values.total_funding = funding;
  if (details.lastRound?.name) values.last_funding_round = details.lastRound.name;
  if (details.lastRound?.date) values.last_funding_date = details.lastRound.date;
  const round = usd(details.lastRound?.amount ?? null);
  if (round) values.last_funding_amount = round;
  if (details.visits !== null) values.monthly_web_visits = details.visits;
  return values;
}

/** A role from a person's work history, as the lookup and the model see it. */
export type Role = {
  title: string | null;
  company: string | null;
  current: boolean;
  /** From the profile's experience section, for current roles only. */
  department: string | null;
  level: string | null;
};
/** One search result that carries a person entity (enrichment spec 7.3). */
export type PersonCandidate = {
  index: number;
  url: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  /** The person's LinkedIn profile, when the result is one. */
  linkedin: string | null;
  roles: Role[];
  /** The result's profile text, for the model to compare with the record. */
  profile: string;
};

const PROFILE_URL =
  /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]{1,100})\/?(?:[?#].*)?$/i;
/** The canonical form of a LinkedIn profile address, or null when `url` isn't one. */
export function linkedinProfile(url: string | null | undefined): string | null {
  const slug = url ? PROFILE_URL.exec(url.trim())?.[1] : undefined;
  return slug ? `https://www.linkedin.com/in/${slug}` : null;
}
const EXPERIENCE_HEADER = /^### (.+?) - (?:\[([^\]\n]+)\]\([^)\n]*\)|([^\n]+?)) \(Current\)\s*$/;
const DEPARTMENT_LINE = /^Department: ([^•\n]+?)\s*•\s*Level: (.+?)\s*$/m;
/** Past roles the model sees next to the current ones, most recent first. */
const PAST_ROLES = 3;

/** Department and level of each current role, from the profile's experience section. */
function currentRoleDetails(profile: string) {
  const details: { title: string; company: string; department: string; level: string }[] = [];
  for (const block of profile.split(/^(?=### )/m)) {
    const header = EXPERIENCE_HEADER.exec(block.split('\n', 1)[0] ?? '');
    const line = DEPARTMENT_LINE.exec(block);
    if (header && line?.[1] && line[2])
      details.push({
        title: header[1]?.trim() ?? '',
        company: (header[2] ?? header[3] ?? '').trim(),
        department: line[1].trim(),
        level: line[2].trim(),
      });
  }
  return details;
}

/**
 * The headline: the first line after the profile's `# Name`, unless that line
 * is where the person lives (Exa puts the location there when the profile has
 * no headline) or a count of connections.
 */
function headlineOf(profile: string, location: string | null): string | null {
  const lines = profile.split('\n').map((line) => line.trim());
  const title = lines.findIndex((line) => line.startsWith('# '));
  if (title < 0) return null;
  const line = lines.slice(title + 1).find(Boolean);
  if (!line || line.startsWith('#') || /\bconnections\b|\bfollowers\b/.test(line)) return null;
  const place = line.replace(/\s*\([A-Z]{2}\)$/, '');
  if (/\([A-Z]{2}\)$/.test(line) || (location && place === location)) return null;
  return clip(line, 500);
}

/** The search results Exa returned as people, numbered from 0 in its order. */
export function personCandidates(body: ExaSearch): PersonCandidate[] {
  return entityResults(body, exaPersonEntity, (result, entity) => {
    const profile = result.text ?? '';
    const location = trimmed(entity.properties.location);
    const details = currentRoleDetails(profile);
    const history = (entity.properties.workHistory ?? []).map((role) => ({
      title: trimmed(role.title),
      company: trimmed(role.company?.name),
      current: !!role.dates && !role.dates.to,
    }));
    const roles: Role[] = [
      ...history
        .filter((role) => role.current)
        .map((role) => {
          const company = role.company && normalizeCompanyName(role.company);
          const at = details.filter((d) => company && normalizeCompanyName(d.company) === company);
          const found = at.find((d) => d.title === role.title) ?? at[0];
          return { ...role, department: found?.department ?? null, level: found?.level ?? null };
        }),
      ...history
        .filter((role) => !role.current)
        .slice(0, PAST_ROLES)
        .map((role) => ({ ...role, department: null, level: null })),
    ];
    return {
      url: result.url,
      name: trimmed(entity.properties.name) ?? trimmed(result.title),
      headline: headlineOf(profile, location),
      location,
      linkedin: linkedinProfile(result.url),
      roles,
      profile,
    };
  });
}

/** A person's name compared by its first and last words: case, accents and punctuation dropped. */
export function normalizePersonName(name: string): string {
  const parts = words(fold(name));
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]}` : (parts[0] ?? '');
}
export function sameName(a: string | null, b: string | null): boolean {
  const key = a ? normalizePersonName(a) : '';
  return key !== '' && !!b && key === normalizePersonName(b);
}

/** The candidate's current roles at the company, by name. */
export function rolesAt(candidate: PersonCandidate, company: string | null): Role[] {
  const name = company && normalizeCompanyName(company);
  return name
    ? candidate.roles.filter(
        (role) => role.current && role.company && normalizeCompanyName(role.company) === name,
      )
    : [];
}

/**
 * The output values of the chosen person (enrichment spec 7.2): the title,
 * level and department of their current role at the record's company, or of
 * their only current role when the company is unknown or isn't listed.
 */
export function personValues(candidate: PersonCandidate, company: string | null): EnrichmentValues {
  const values: EnrichmentValues = {};
  const current = candidate.roles.filter((role) => role.current);
  const role = rolesAt(candidate, company)[0] ?? (current.length === 1 ? current[0] : undefined);
  if (role?.title) values.job_title = role.title;
  if (role?.level) values.seniority = role.level;
  if (role?.department) values.department = role.department;
  if (candidate.headline) values.headline = candidate.headline;
  if (candidate.location) values.location = candidate.location;
  if (candidate.linkedin)
    values.linkedin_url = { primary: { url: candidate.linkedin }, additional: [] };
  return values;
}

export class ExaProvider {
  constructor(
    private readonly key: string,
    private readonly signal: AbortSignal,
    private readonly transport: typeof fetch = fetch,
  ) {}

  private async request<T>(
    path: '/search' | '/contents' | '/websets/v0/teams/me',
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
        throw new ExaError(
          response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable',
          true,
          retryAfterSeconds(response.headers),
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
      const { contents: _contents, ...search } = exaSearchRequest('exa.ai');
      await this.request('/search', exaSearchResponse, { ...search, numResults: 1 });
    }
  }

  /** The company candidates for a record's domain and name. */
  async search(domain: string | null, name?: string | null): Promise<Candidate[]> {
    return companyCandidates(
      await this.request('/search', exaSearchResponse, exaSearchRequest(domain, name)),
    );
  }

  /** The person candidates for one people query, from its parts. */
  async searchPeople(parts: (string | null | undefined)[]): Promise<PersonCandidate[]> {
    return personCandidates(
      await this.request('/search', exaSearchResponse, exaPeopleRequest(parts)),
    );
  }

  /** The person on one LinkedIn profile, read directly; null when Exa has no person there. */
  async profile(url: string): Promise<PersonCandidate | null> {
    const profile = linkedinProfile(url);
    if (!profile) return null;
    const [candidate] = personCandidates(
      await this.request('/contents', exaSearchResponse, exaProfileRequest(profile)),
    );
    return candidate ? { ...candidate, linkedin: profile } : null;
  }
}
