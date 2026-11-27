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
 * is read directly. Otherwise the person is searched by name and company: the
 * linked company's name and website, or the domain of a work email. Only
 * those are sent to Exa, never an email address. Without a company the
 * person is not looked up at all, since a name alone finds namesakes.
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
  /** The primary email; only its domain is used. */
  email: string | null;
  linkedin: string | null;
  /** The linked company, as the company binding reads it. */
  company: { name: string | null; domain: string | null } | null;
};

/**
 * Enrichment's guards on a person pick (spec 7.3): never `low`, the name must
 * match, and a current role at the company by name allows `medium`; without
 * one, only `high` is accepted.
 */
export function acceptPersonPick(
  pick: { candidate: PersonCandidate; certainty: Certainty },
  record: { name: string; company: string | null },
): boolean {
  if (pick.certainty === 'low' || !sameName(record.name, pick.candidate.name)) return false;
  return pick.certainty === 'high' || rolesAt(pick.candidate, record.company).length > 0;
}

export async function lookUpPerson(
  run: { exa: ExaProvider; model: () => Anthropic | null; signal: AbortSignal },
  record: PersonRecord,
  allowNameOnly = false,
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
  const nameOnly = !company && !domain;
  if (nameOnly && !allowNameOnly) return { status: 'no_match', code: 'no_company' };
  const signal = { name: company, domain };
  const candidates = await run.exa.searchPeople(name, signal);
  if (
    !candidates.length ||
    (nameOnly && candidates.filter((candidate) => sameName(name, candidate.name)).length !== 1)
  )
    return { status: 'no_match', code: 'no_match' };
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
  const answer = await pickPerson(run.model(), { name, company: signal }, candidates, run.signal);
  return resolvePick(
    answer,
    candidates,
    (pick) => acceptPersonPick(pick, { name, company }),
    (candidate) => personValues(candidate, company),
  );
}
