import type {
  AddressValue,
  EmailsValue,
  FullNameValue,
  LinksValue,
  PhonesValue,
} from '@retainer/shared';
import { type CountryCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import type { IdentifierKind } from '../db/schema.js';
import type { FieldState } from '../schema/types.js';

/**
 * Values derived from a record's field values in the same transaction that
 * writes them: identifiers (1.2), the label and the search text (5.1). One
 * function per concern, shared by writes and lookups so both normalize
 * the same way.
 */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** E.164 when the number parses; otherwise its digits, with a leading + kept. */
export function normalizePhone(raw: string, countryCode?: string): string {
  // "00" is the international dialing prefix in most countries.
  const number = raw.trim().replace(/^00(?=[1-9])/, '+');
  const parsed = parsePhoneNumberFromString(
    number,
    countryCode ? { defaultCountry: countryCode.toUpperCase() as CountryCode } : undefined,
  );
  if (parsed?.isPossible()) return parsed.number;
  const digits = number.replace(/[^\d]/g, '');
  return number.trim().startsWith('+') ? `+${digits}` : digits;
}

/** The host of a URL, lowercased and without a leading "www.". */
export function normalizeDomain(url: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

/**
 * A unique value keeps its JSON type, so number 1 and text "1" never
 * collide. Text is trimmed; case is significant.
 */
export function canonicalUniqueValue(value: unknown): string {
  return JSON.stringify(typeof value === 'string' ? value.trim() : value);
}

export type Identifier = { kind: IdentifierKind; value: string };

/**
 * The identifiers a field value contributes: every email, phone and website
 * domain, plus the canonical value of a unique field. Null contributes none.
 */
export function identifiersFor(field: FieldState, value: unknown): Identifier[] {
  if (value === null || value === undefined) return [];
  const found = new Map<string, Identifier>();
  const add = (kind: IdentifierKind, raw: string | null) => {
    if (raw) found.set(`${kind}:${raw}`, { kind, value: raw });
  };

  switch (field.type) {
    case 'emails': {
      const emails = value as EmailsValue;
      for (const email of [emails.primary, ...(emails.additional ?? [])]) {
        if (email) add('email', normalizeEmail(email));
      }
      break;
    }
    case 'phones': {
      const phones = value as PhonesValue;
      for (const phone of [phones.primary, ...(phones.additional ?? [])]) {
        if (phone) add('phone', normalizePhone(phone.number, phone.countryCode));
      }
      break;
    }
    case 'links': {
      const links = value as LinksValue;
      for (const link of [links.primary, ...(links.additional ?? [])]) {
        if (link) add('domain', normalizeDomain(link.url));
      }
      break;
    }
    default:
      if (field.isUnique) add('value', canonicalUniqueValue(value));
  }
  return [...found.values()];
}

/** Looks up a single match value the way `identifiersFor` stores it. */
export function lookupValue(field: FieldState, value: unknown): string | null {
  if (field.type === 'emails') {
    return typeof value === 'string' && value.trim() ? normalizeEmail(value) : null;
  }
  if (value === null || value === undefined) return null;
  return canonicalUniqueValue(value);
}

/** A field value as plain text, for labels and search. */
export function textOf(field: FieldState, value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (field.type) {
    case 'full_name': {
      const name = value as FullNameValue;
      return [name.first, name.last].filter(Boolean).join(' ');
    }
    case 'emails': {
      const emails = value as EmailsValue;
      return [emails.primary, ...(emails.additional ?? [])].filter(Boolean).join(' ');
    }
    case 'phones': {
      const phones = value as PhonesValue;
      return [phones.primary, ...(phones.additional ?? [])]
        .filter((p) => p !== null)
        .map((p) => p.number)
        .join(' ');
    }
    case 'links': {
      const links = value as LinksValue;
      return [links.primary, ...(links.additional ?? [])]
        .filter((l) => l !== null)
        .map((l) => [l.label, l.url].filter(Boolean).join(' '))
        .join(' ');
    }
    case 'address': {
      const a = value as AddressValue;
      return [a.street1, a.street2, a.city, a.state, a.postcode, a.country]
        .filter(Boolean)
        .join(' ');
    }
    case 'select':
      return field.settings.options?.find((o) => o.value === value)?.label ?? String(value);
    case 'multi_select':
      return (value as string[])
        .map((v) => field.settings.options?.find((o) => o.value === v)?.label ?? v)
        .join(' ');
    case 'files':
    case 'money':
    case 'json':
    case 'relation':
      return '';
    default:
      return String(value);
  }
}

/** The label of a record: its label field's value as text, for display and fuzzy lookup. */
export function labelOf(labelField: FieldState | undefined, value: unknown): string | null {
  if (!labelField) return null;
  if (labelField.type === 'emails') return (value as EmailsValue | null)?.primary ?? null;
  if (labelField.type === 'phones') return (value as PhonesValue | null)?.primary?.number ?? null;
  if (labelField.type === 'links') return (value as LinksValue | null)?.primary?.url ?? null;
  const text = textOf(labelField, value).trim();
  return text || null;
}

/**
 * The text a record's search vector is built from: the label (weighted
 * highest) and the values of searchable fields, indexed with the `simple`
 * configuration (5.1). Emails and links add their domain, so "acme" finds
 * dana@acme.com and https://www.acme.com.
 */
export function searchTextOf(
  fields: FieldState[],
  labelField: FieldState | undefined,
  data: Record<string, unknown>,
): { label: string | null; body: string } {
  const label = labelOf(labelField, labelField ? data[labelField.key] : undefined);
  const indexed = fields.filter(
    (f) => f.status === 'active' && (f.isSearchable || f === labelField),
  );
  const body = [
    ...indexed.filter((f) => f !== labelField).map((f) => textOf(f, data[f.key])),
    ...new Set(indexed.flatMap((f) => domainsOf(f, data[f.key]))),
  ]
    .filter(Boolean)
    .join(' ');
  return { label, body };
}

/**
 * The domains in an emails or links value, normalized as identifiers are.
 * Postgres indexes "dana@acme.com" and "www.acme.com" as single words, so
 * neither starts with "acme" on its own; the bare domain does. The label
 * field's domains count too.
 */
function domainsOf(field: FieldState, value: unknown): string[] {
  return identifiersFor(field, value).flatMap(({ kind, value: id }) => {
    if (kind === 'domain') return [id];
    if (kind === 'email' && id.includes('@')) return [id.slice(id.lastIndexOf('@') + 1)];
    return [];
  });
}
