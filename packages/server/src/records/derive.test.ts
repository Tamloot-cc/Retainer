import { describe, expect, it } from 'vitest';
import type { FieldState } from '../schema/types.js';
import {
  canonicalUniqueValue,
  duplicateUrlKey,
  identifiersFor,
  labelOf,
  lookupValue,
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
  searchTextOf,
} from './derive.js';

const field = (overrides: Partial<FieldState>): FieldState => ({
  universalId: 'u',
  key: 'k',
  name: 'k',
  label: 'K',
  description: null,
  type: 'text',
  settings: {},
  isNullable: true,
  isUnique: false,
  isFilterable: true,
  isSearchable: false,
  isProtected: false,
  coreRole: null,
  owner: 'system',
  status: 'active',
  ...overrides,
});

describe('normalization (shared by writes and lookups)', () => {
  it('lowercases and trims emails', () => {
    expect(normalizeEmail('  Dana@Acme.COM ')).toBe('dana@acme.com');
  });

  it('formats phones as E.164', () => {
    expect(normalizePhone('050-123-4567', 'IL')).toBe('+972501234567');
    expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
    expect(normalizePhone('0044 20 7946 0958')).toBe('+442079460958');
  });

  it('keeps digits when a phone cannot be parsed', () => {
    expect(normalizePhone('12-34')).toBe('1234');
    expect(normalizePhone('+99 12')).toBe('+9912');
  });

  it('reduces links to their host', () => {
    expect(normalizeDomain('https://www.Acme.com/about')).toBe('acme.com');
    expect(normalizeDomain('acme.co.il')).toBe('acme.co.il');
    expect(normalizeDomain('not a url')).toBeNull();
  });

  it('keeps the JSON type of unique values, so 1 and "1" differ', () => {
    expect(canonicalUniqueValue(1)).toBe('1');
    expect(canonicalUniqueValue('1')).toBe('"1"');
    expect(canonicalUniqueValue(' A-17 ')).toBe('"A-17"');
  });
});

describe('identifiersFor', () => {
  it('lists every email once, as claims of a unique field', () => {
    const emails = field({ type: 'emails', isUnique: true });
    expect(
      identifiersFor(emails, { primary: 'Dana@acme.com', additional: ['dana@acme.com', 'd@x.io'] }),
    ).toEqual([
      { kind: 'email', value: 'dana@acme.com' },
      { kind: 'email', value: 'd@x.io' },
    ]);
  });

  it('lists phones and domains, and nothing for null', () => {
    expect(
      identifiersFor(field({ type: 'phones' }), {
        primary: { number: '050-123-4567', countryCode: 'IL' },
        additional: [],
      }),
    ).toEqual([{ kind: 'phone', value: '+972501234567' }]);
    expect(
      identifiersFor(field({ type: 'links' }), {
        primary: { url: 'https://www.acme.com' },
        additional: [],
      }),
    ).toEqual([{ kind: 'domain', value: 'acme.com' }]);
    expect(identifiersFor(field({ type: 'emails' }), null)).toEqual([]);
  });

  it('claims the canonical value of other unique fields only', () => {
    expect(identifiersFor(field({ type: 'number', isUnique: true }), 7)).toEqual([
      { kind: 'value', value: '7' },
    ]);
    expect(identifiersFor(field({ type: 'text' }), 'anything')).toEqual([]);
  });

  it('looks up a match value the way it was stored', () => {
    expect(lookupValue(field({ type: 'emails' }), ' DANA@acme.com')).toBe('dana@acme.com');
    expect(lookupValue(field({ type: 'text', isUnique: true }), 'A-17')).toBe('"A-17"');
  });
});

describe('label and search text', () => {
  it('labels a full name and a select by its option label', () => {
    expect(labelOf(field({ type: 'full_name' }), { first: 'Dana', last: 'Levi' })).toBe(
      'Dana Levi',
    );
    const status = field({
      type: 'select',
      settings: { options: [{ value: 'in_progress', label: 'In progress' }] },
    });
    expect(labelOf(status, 'in_progress')).toBe('In progress');
    expect(labelOf(field({ type: 'text' }), '   ')).toBeNull();
  });

  it('indexes searchable fields apart from the label', () => {
    const name = field({ key: 'name', type: 'full_name', isSearchable: true });
    const title = field({ key: 'jobTitle', isSearchable: true });
    const secret = field({ key: 'notes', isSearchable: false });
    expect(
      searchTextOf([name, title, secret], name, {
        name: { first: 'דנה', last: 'לוי' },
        jobTitle: 'CTO',
        notes: 'private',
      }),
    ).toEqual({ label: 'דנה לוי', body: 'CTO' });
  });

  it('adds the domain of each email and link once, after the field text', () => {
    const name = field({ key: 'name', type: 'full_name', isSearchable: true });
    const emails = field({ key: 'emails', type: 'emails', isSearchable: true });
    const links = field({ key: 'links', type: 'links', isSearchable: true });
    expect(
      searchTextOf([name, emails, links], name, {
        name: { first: 'Dana', last: 'Levi' },
        emails: { primary: 'dana@Acme.com', additional: ['d@acme.com', 'dana@globex.io'] },
        links: {
          primary: { url: 'https://www.acme.com/pricing', label: 'Pricing' },
          additional: [{ url: 'not a url', label: null }],
        },
      }).body,
    ).toBe(
      'dana@Acme.com d@acme.com dana@globex.io Pricing https://www.acme.com/pricing ' +
        'not a url acme.com globex.io',
    );
  });
});

describe('duplicate URL evidence (separate from lookup)', () => {
  it.each([
    ['http://WWW.Acme.example', 'https://acme.example/'],
    ['acme.example/?utm_source=mail&gclid=123', 'https://acme.example'],
    ['//WWW.LinkedIn.com/company/fijoya/', 'https://linkedin.com/company/fijoya'],
    ['linkedin.com/company/fijoya?trk=public_profile', 'linkedin.com/company/fijoya'],
    ['directory.example/profile?q=x&utm_source=y&', 'directory.example/profile?q=x'],
    ['directory.example/profile?&q=x&&utm_source=y&&', 'directory.example/profile?q=x'],
    [
      'directory.example/profile?q=hello%20world&utm_source=x',
      'directory.example/profile?q=hello%20world',
    ],
    ['directory.example/profile?gclid=x&q=~hello', 'directory.example/profile?q=~hello'],
    [
      'directory.example/profile?utm_source=x&q=%7Ehello&fbclid=y',
      'directory.example/profile?q=%7Ehello',
    ],

    ['http://linkedin.com/company/fijoya?utm_campaign=x&fbclid=abc', 'linkedin.com/company/fijoya'],
  ])('matches equivalent forms: %s', (a, b) => {
    expect(duplicateUrlKey(a)).not.toBeNull();
    expect(duplicateUrlKey(a)).toBe(duplicateUrlKey(b));
  });

  it.each([
    ['linkedin.com/company/fijoya', 'linkedin.com/company/wiz'],
    ['directory.example/profile?id=1', 'directory.example/profile?id=2'],
    ['directory.example/?id=1', 'directory.example/?id=2'],
    ['directory.example/a', 'directory.example/b'],
    ['directory.example/A', 'directory.example/a'],
    ['directory.example/a', 'directory.example/a/'],
    ['directory.example/?ref=a', 'directory.example/?ref=b'],
    ['directory.example/profile?trk=1', 'directory.example/profile?trk=2'],
    ['directory.example/#/a', 'directory.example/#/b'],
    ['directory.example:8443/a', 'directory.example/a'],
    ['acme.example', 'acme.example/about'],
  ])('preserves distinct identities: %s', (a, b) => {
    expect(duplicateUrlKey(a)).not.toBe(duplicateUrlKey(b));
  });

  it.each([
    'https://linkedin.com/',
    'http://www.facebook.com?utm_source=mail',
    'https://github.com',
    'https://docs.google.com/?ref=nav',
    'ftp://acme.example',
    'https://user:pass@acme.example',
    'not a url',
    '',
  ])('rejects shared homepages or unusable URLs: %s', (url) => {
    expect(duplicateUrlKey(url)).toBeNull();
  });

  it('does not narrow stored identifiers or search normalization', () => {
    const links = field({ type: 'links' });
    for (const url of ['linkedin.com/company/fijoya', 'linkedin.com/company/wiz']) {
      expect(identifiersFor(links, { primary: { url }, additional: [] })).toEqual([
        { kind: 'domain', value: 'linkedin.com' },
      ]);
    }
  });
});
