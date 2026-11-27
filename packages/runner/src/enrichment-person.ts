import type Anthropic from '@anthropic-ai/sdk';
import { normalizeDomain } from '@retainer/shared';
import type { Certainty } from './enrichment-contract.js';
import { type Found, pickPerson, resolvePick } from './enrichment-model.js';
import {
  type ExaProvider,
  linkedinProfile,
  type PersonCandidate,
  personValues,
  rolesAt,
  sameName,
} from './enrichment-provider.js';

/**
 * The people lookup (enrichment spec 7.3). A LinkedIn profile on the record
 * is read directly. Otherwise two searches run: the name with the rest of the
 * record (email, company and the other values), and the name alone. The
 * model picks among their results with the whole record in view. An
 * automatic run needs a company signal, the linked company or a work email's
 * domain, since a name alone finds namesakes; Enrich now goes without one.
 */

/**
 * Domains of personal mailboxes, which say nothing about where someone
 * works. A short list of the common providers; a domain it misses only
 * makes the search less precise, and the guards still apply.
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'aol.com',
  'fastmail.com',
  'gmail.com',
  'gmx.com',
  'gmx.de',
  'googlemail.com',
  'hey.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mac.com',
  'mail.com',
  'mail.ru',
  'me.com',
  'msn.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.com',
  'qq.com',
  'tutanota.com',
  'web.de',
  'yahoo.com',
  'yandex.ru',
  'zoho.com',
]);

/** The domain of a work email address, or null for a personal mailbox or no address. */
export function workEmailDomain(email: string | null): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  if (!email || at < 1) return null;
  const domain = normalizeDomain(email.slice(at + 1));
  return domain && !PERSONAL_EMAIL_DOMAINS.has(domain) ? domain : null;
}

export type PersonRecord = {
  name: string | null;
  /** The primary email; sent with the record, and its domain is a company signal. */
  email: string | null;
  linkedin: string | null;
  /** The linked company, as the company binding reads it. */
  company: { name: string | null; domain: string | null } | null;
  /** The record's other values as text, by field. */
  details: Record<string, string>;
};

/** Candidates of both searches, one per profile, numbered from 0 in that order. */
export function mergeCandidates(...lists: PersonCandidate[][]): PersonCandidate[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((candidate) => {
      const key = candidate.linkedin ?? candidate.url;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate, index) => ({ ...candidate, index }));
}

/**
 * Enrichment's guards on a person pick (spec 7.3): never `low`, and the name
 * must match. `medium` needs a current role at the company by name, or a
 * person who pressed Enrich now; otherwise only `high` is accepted.
 */
export function acceptPersonPick(
  pick: { candidate: PersonCandidate; certainty: Certainty },
  record: { name: string; company: string | null; manual?: boolean },
): boolean {
  if (pick.certainty === 'low' || !sameName(record.name, pick.candidate.name)) return false;
  return (
    pick.certainty === 'high' ||
    !!record.manual ||
    rolesAt(pick.candidate, record.company).length > 0
  );
}

export async function lookUpPerson(
  run: { exa: ExaProvider; model: () => Anthropic | null; signal: AbortSignal },
  record: PersonRecord,
  manual = false,
): Promise<Found> {
  const company = record.company?.name ?? null;
  if (linkedinProfile(record.linkedin)) {
    const found = record.linkedin ? await run.exa.profile(record.linkedin) : null;
    if (!found) return { status: 'no_match', code: 'no_match_linkedin' };
    return {
      status: 'match',
      values: personValues(found, company),
      confidence: 1,
      code: 'matched_linkedin',
    };
  }
  const name = record.name?.trim();
  if (!name) return { status: 'no_match', code: 'no_name' };
  const domain = record.company?.domain ?? workEmailDomain(record.email);
  if (!company && !domain && !manual) return { status: 'no_match', code: 'no_company' };
  const context = [
    company,
    record.company?.domain,
    record.email,
    ...Object.values(record.details),
  ].filter(Boolean);
  const [withRecord, byName] = await Promise.all([
    run.exa.searchPeople([name, ...context]),
    context.length ? run.exa.searchPeople([name]) : [],
  ]);
  const candidates = mergeCandidates(withRecord, byName);
  if (!candidates.length) return { status: 'no_match', code: 'no_match' };
  const direct = candidates.filter(
    (candidate) => sameName(name, candidate.name) && rolesAt(candidate, company).length,
  );
  if (direct.length === 1 && direct[0])
    return {
      status: 'match',
      values: personValues(direct[0], company),
      confidence: 1,
      code: 'matched_shortcut',
    };
  const answer = await pickPerson(
    run.model(),
    { name, email: record.email, company: record.company, details: record.details },
    candidates,
    run.signal,
  );
  return resolvePick(
    answer,
    candidates,
    (pick) => acceptPersonPick(pick, { name, company, manual }),
    (candidate) => personValues(candidate, company),
  );
}
