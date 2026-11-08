import { describe, expect, it } from 'vitest';
import { COMPOSITE_FIELD_TYPES, FIELD_TYPES, type FieldType } from './field-types.js';
import { FIELD_VALUE_FORMATS, FieldValueError, validateFieldValue } from './values.js';

const f = (type: Parameters<typeof validateFieldValue>[0]['type'], settings = {}) => ({
  type,
  settings,
  isNullable: true,
});
describe('public field-aware validation', () => {
  it('enforces field settings and nullability, not just composite shape', () => {
    expect(() => validateFieldValue({ ...f('text'), isNullable: false }, null)).toThrow(
      'cannot be null',
    );
    expect(validateFieldValue(f('text'), null)).toBeNull();
    expect(() =>
      validateFieldValue(f('select', { options: [{ value: 'a', label: 'A' }] }), 'b'),
    ).toThrow('options');
    expect(() =>
      validateFieldValue(f('emails', { maxValues: 1 }), {
        primary: 'a@test.com',
        additional: ['b@test.com'],
      }),
    ).toThrow('at most 1');
    expect(() =>
      validateFieldValue(f('links'), { primary: { url: 'javascript://alert(1)' }, additional: [] }),
    ).toThrow();
    expect(() =>
      validateFieldValue(f('phones'), { primary: { number: 'abc' }, additional: [] }),
    ).toThrow('phone number');
    expect(() => validateFieldValue(f('full_name'), { first: '', last: '' })).toThrow('name needs');
    expect(() => validateFieldValue(f('date'), '2025-02-29')).toThrow('real calendar date');
  });

  it('keeps dates within the years Postgres can cast (0001–9999)', () => {
    expect(() => validateFieldValue(f('date'), '0000-01-01')).toThrow('year from 1 to 9999');
    expect(validateFieldValue(f('date'), '0001-01-01')).toBe('0001-01-01');
    expect(validateFieldValue(f('date'), '9999-12-31')).toBe('9999-12-31');
    expect(() => validateFieldValue(f('date_time'), '0000-06-01T00:00:00Z')).toThrow('year');
    expect(() => validateFieldValue(f('date_time'), '+010000-01-01T00:00:00Z')).toThrow('year');
    expect(validateFieldValue(f('date_time'), '9999-12-31T23:59:59Z')).toBe(
      '9999-12-31T23:59:59.000Z',
    );
  });
  it('normalizes the same way as server writes', () => {
    expect(
      validateFieldValue(f('emails'), { primary: 'Dana@ACME.com', additional: ['dana@acme.com'] }),
    ).toEqual({ primary: 'dana@acme.com', additional: [] });
    expect(validateFieldValue(f('money'), { amountMicros: 100, currency: 'usd' })).toEqual({
      amountMicros: 100,
      currency: 'USD',
    });
    expect(validateFieldValue(f('date_time'), '2026-11-02T10:00:00+02:00')).toBe(
      '2026-11-02T08:00:00.000Z',
    );
  });

  it('takes a set of record IDs for a many_to_many relation', () => {
    const set = f('relation', { relationCardinality: 'many_to_many' });
    const a = 'B0000000-0000-4000-8000-000000000002';
    const b = 'a0000000-0000-4000-8000-000000000001';
    expect(validateFieldValue(set, [a, b, a.toLowerCase()])).toEqual([b, a.toLowerCase()]);
    expect(validateFieldValue(set, [])).toEqual([]);
    expect(() => validateFieldValue(set, null)).toThrow('[] clears it');
    expect(() => validateFieldValue(set, b)).toThrow('array');
    expect(() => validateFieldValue(set, ['nope'])).toThrow('ID');
    expect(() => validateFieldValue({ ...set, isNullable: false }, [])).toThrow('at least one');
    expect(() =>
      validateFieldValue(f('relation', { relationCardinality: 'many_to_many', isInverse: true }), [
        b,
      ]),
    ).toThrow('read-only');
  });
});

describe('value formats (accounts spec 9.3)', () => {
  const id = 'a0000000-0000-4000-8000-000000000001';
  // Values written the way FIELD_VALUE_FORMATS describes them, one per form.
  const EXAMPLES: Record<FieldType, [settings: object, value: unknown][]> = {
    text: [[{}, 'Dana']],
    number: [[{}, 3.5]],
    boolean: [[{}, true]],
    date: [[{}, '2026-11-02']],
    date_time: [[{}, '2026-11-02T09:30:00Z']],
    select: [[{ options: [{ value: 'won', label: 'Won' }] }, 'won']],
    multi_select: [[{ options: [{ value: 'vip', label: 'VIP' }] }, ['vip']]],
    money: [[{}, { amountMicros: 12_500_000, currency: 'USD' }]],
    emails: [
      [{}, { primary: 'dana@acme.com', additional: ['dana@home.com'] }],
      [{}, 'dana@acme.com'],
    ],
    phones: [
      [{}, { primary: { number: '+972 50 123 4567', countryCode: 'IL' }, additional: [] }],
      [{}, '+972 50 123 4567'],
    ],
    links: [
      [{}, { primary: { url: 'https://acme.com', label: 'Site' }, additional: [] }],
      [{}, 'https://acme.com'],
    ],
    full_name: [
      [{}, { first: 'Dana', last: 'Levi' }],
      [{}, 'Dana Levi'],
    ],
    address: [
      [
        {},
        {
          street1: '1 Rothschild Blvd',
          street2: 'Floor 3',
          city: 'Tel Aviv',
          state: 'Tel Aviv District',
          postcode: '6688101',
          country: 'IL',
          lat: 32.06,
          lng: 34.77,
        },
      ],
    ],
    relation: [
      [{}, id],
      [{ relationCardinality: 'many_to_many' }, [id]],
    ],
    json: [[{}, { any: ['thing'] }]],
  };

  it('documents a format for every field type', () => {
    for (const type of FIELD_TYPES) expect(FIELD_VALUE_FORMATS[type], type).toBeTruthy();
    expect(Object.keys(FIELD_VALUE_FORMATS).sort()).toEqual([...FIELD_TYPES].sort());
  });

  it('accepts a value written as each format says, and names its keys', () => {
    for (const type of FIELD_TYPES) {
      for (const [settings, value] of EXAMPLES[type]) {
        expect(() => validateFieldValue(f(type, settings), value), type).not.toThrow();
        // Every key the example uses, at any depth, appears in the format.
        const keys = JSON.stringify(value).match(/"(\w+)":/g) ?? [];
        for (const key of keys) expect(FIELD_VALUE_FORMATS[type], type).toContain(key.slice(1, -2));
      }
    }
    expect(FIELD_VALUE_FORMATS.full_name).toContain('{ first, last }');
    expect(FIELD_VALUE_FORMATS.emails).toContain('{ primary, additional: [...] }');
    expect(FIELD_VALUE_FORMATS.phones).toContain('{ number, countryCode? }');
    expect(FIELD_VALUE_FORMATS.links).toContain('{ url, label? }');
    expect(FIELD_VALUE_FORMATS.money).toContain('{ amountMicros, currency }');
  });

  const failure = (type: FieldType, value: unknown) => {
    try {
      validateFieldValue(f(type), value);
    } catch (error) {
      if (error instanceof FieldValueError) return error;
      throw error;
    }
    throw new Error(`${type} accepted ${JSON.stringify(value)}`);
  };

  it('names the expected format when a composite value has the wrong shape', () => {
    // The shapes an agent guessed in the live test, and others like them.
    const wrong: Record<(typeof COMPOSITE_FIELD_TYPES)[number], unknown> = {
      full_name: { firstName: 'Dana', lastName: 'Levi' },
      emails: { primaryEmail: 'dana@acme.com', additionalEmails: [] },
      phones: { primary: { phone: '+972501234567' } },
      links: { primary: { href: 'https://acme.com' } },
      address: { line1: '1 Rothschild Blvd' },
      money: { amount: 12.5, currency: 'USD' },
    };
    for (const type of COMPOSITE_FIELD_TYPES) {
      const error = failure(type, wrong[type]);
      expect(error.expected, type).toBe(FIELD_VALUE_FORMATS[type]);
    }
    expect(failure('full_name', { firstName: 'Dana' }).message).toContain('firstName');
    expect(failure('emails', { primaryEmail: 'dana@acme.com' }).message).toContain('primaryEmail');
  });

  it('leaves the format off simple types, whose message already says what it expects', () => {
    const error = failure('date', '02/11/2026');
    expect(error.message).toContain('YYYY-MM-DD');
    expect(error.expected).toBeUndefined();
  });
});
