import { z } from 'zod';
import type { FieldType } from './field-types.js';
import {
  addressValueSchema,
  compositeValueSchemas,
  type EmailsValue,
  type FullNameValue,
  filesValueSchema,
  fullNameValueSchema,
  type LinksValue,
  moneyValueSchema,
  type PhonesValue,
} from './field-types.js';
import { type FieldSettings, isCollectionRelation, isInverseRelation } from './schema.js';
export type ValueField = { type: FieldType; settings: FieldSettings; isNullable?: boolean };

export type ValueError = {
  field: string;
  message: string;
  allowed?: unknown[];
  /** A composite field's value format (FIELD_VALUE_FORMATS), so an agent can rewrite it. */
  expected?: string;
};

/** A value that does not fit its field. Collected so one response lists them all. */
export class FieldValueError extends Error {
  constructor(
    message: string,
    readonly allowed?: unknown[],
  ) {
    super(message);
  }
}

const MAX_TEXT = 100_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Years a date or date-time may fall in. Postgres has no year 0 and parses
 * no expanded years (+010000), so values outside this range would fail
 * every cast that sorts or filters them.
 */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;
const inYearRange = (date: Date) =>
  date.getUTCFullYear() >= MIN_YEAR && date.getUTCFullYear() <= MAX_YEAR;
const YEAR_RANGE_MESSAGE = `expected a year from ${MIN_YEAR} to ${MAX_YEAR}`;

/**
 * An ISO 8601 date-time with a UTC offset, in the years Postgres can cast,
 * for every API input that becomes a `timestamptz` (`occurredAt`, timeline
 * bounds, `expectedUpdatedAt`).
 */
export const isoDateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => inYearRange(new Date(value)), { message: YEAR_RANGE_MESSAGE });

function fail(message: string, allowed?: unknown[]): never {
  throw new FieldValueError(message, allowed);
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    )
    .join('; ');
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(zodMessage(parsed.error));
  return parsed.data;
}

const emailSchema = z.email();
const urlSchema = z.url({ protocol: /^https?$/ });

/** One phone in a `phones` value, as written. */
const phoneInputSchema = z.strictObject({
  number: z.string().trim().min(3).max(40),
  countryCode: z.string().length(2).toUpperCase().optional(),
});

/** One link in a `links` value, as written. */
const linkInputSchema = z.strictObject({
  url: z.string().min(1),
  label: z.string().max(200).optional(),
});

/** An object schema's keys as an agent writes them: `{ url, label? }`. */
function keysOf(schema: z.ZodObject): string {
  const keys = Object.entries(schema.shape).map(([key, value]) =>
    (value as z.ZodType).def.type === 'optional' ? `${key}?` : key,
  );
  return `{ ${keys.join(', ')} }`;
}

const MULTI = '{ primary, additional: [...] }';

/**
 * How to write each field type's value, for agents: describe_schema lists
 * the formats its fields use, and valueError repeats an invalid composite
 * value's format. Object keys come from the schemas normalizeFieldValue parses
 * with, so the two cannot drift; values.test.ts checks an example of each.
 */
export const FIELD_VALUE_FORMATS = {
  text: 'a string',
  number: 'a number',
  boolean: 'true or false',
  date: '"YYYY-MM-DD"',
  date_time: 'ISO 8601 with a time zone, e.g. "2026-11-02T09:30:00Z"',
  select: "one of the field's option values",
  multi_select: "an array of the field's option values",
  money: `${keysOf(moneyValueSchema)}: amountMicros is an integer in millionths (12.50 is 12500000), currency an ISO 4217 code such as "USD"`,
  emails: `${MULTI} of address strings, or one address as a string`,
  phones: `${MULTI} of ${keysOf(phoneInputSchema)} (countryCode e.g. "IL"), or one number as a string`,
  links: `${MULTI} of ${keysOf(linkInputSchema)}, or one URL as a string`,
  full_name: `${keysOf(fullNameValueSchema)}, or "First Last" as one string`,
  address: keysOf(addressValueSchema),
  relation: "the related record's ID; a many_to_many relation takes an array of IDs ([] clears it)",
  json: 'any JSON value',
  files: 'an array of at most 20 ready immutable file IDs; upload and finalize files first',
} as const satisfies Record<FieldType, string>;

/**
 * A field's invalid value as a response lists it: what was wrong, the
 * allowed values, and for a composite field the format it expected.
 */
export function valueError(field: string, type: FieldType, error: FieldValueError): ValueError {
  return {
    field,
    message: error.message,
    ...(error.allowed ? { allowed: error.allowed } : {}),
    ...(type in compositeValueSchemas ? { expected: FIELD_VALUE_FORMATS[type] } : {}),
  };
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return parseWith(urlSchema, withScheme);
}

/** Composite multi-value fields accept a bare value as shorthand for `{ primary }`. */
function multiValue<T>(
  value: unknown,
  item: (raw: unknown) => T,
  key: (item: T) => string,
  maxValues: number | undefined,
): { primary: T | null; additional: T[] } {
  const shape =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { primary?: unknown; additional?: unknown })
      : { primary: value, additional: [] };
  const extra = shape.additional ?? [];
  if (!Array.isArray(extra)) fail('additional must be an array');
  const unknownKeys = Object.keys(shape).filter((k) => k !== 'primary' && k !== 'additional');
  if (unknownKeys.length > 0) fail(`unexpected keys: ${unknownKeys.join(', ')}`);

  const all = [shape.primary, ...extra].filter((v) => v !== null && v !== undefined).map(item);
  const seen = new Set<string>();
  const unique = all.filter((v) => {
    const k = key(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (maxValues !== undefined && unique.length > maxValues) {
    fail(`at most ${maxValues} values are allowed`);
  }
  // With no primary, the first remaining value becomes the primary.
  const [primary = null, ...additional] = unique;
  return { primary, additional };
}

/**
 * Validates one value for one field and returns its stored form. Throws
 * FieldValueError with a message an agent can act on.
 */
export function normalizeFieldValue(field: ValueField, value: unknown): unknown {
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') fail('expected a string');
      if (value.length > MAX_TEXT) fail(`text is limited to ${MAX_TEXT} characters`);
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected a finite number');
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') fail('expected true or false');
      return value;
    case 'date': {
      if (typeof value !== 'string' || !DATE_PATTERN.test(value))
        fail('expected a date as YYYY-MM-DD');
      const date = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        fail('expected a real calendar date as YYYY-MM-DD');
      }
      if (!inYearRange(date)) fail(YEAR_RANGE_MESSAGE);
      return value;
    }
    case 'date_time': {
      if (typeof value !== 'string') fail('expected an ISO 8601 date-time');
      if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
        fail('include a time zone, e.g. 2026-11-02T09:30:00Z or +02:00');
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) fail('expected an ISO 8601 date-time');
      if (!inYearRange(date)) fail(YEAR_RANGE_MESSAGE);
      return date.toISOString();
    }
    case 'select': {
      const allowed = field.settings.options?.map((o) => o.value) ?? [];
      if (typeof value !== 'string' || !allowed.includes(value)) {
        fail('expected one of the options', allowed);
      }
      return value;
    }
    case 'multi_select': {
      const allowed = field.settings.options?.map((o) => o.value) ?? [];
      if (!Array.isArray(value)) fail('expected an array of options', allowed);
      const invalid = value.filter((v) => typeof v !== 'string' || !allowed.includes(v));
      if (invalid.length > 0) fail(`unknown options: ${invalid.join(', ')}`, allowed);
      return [...new Set(value as string[])];
    }
    case 'money': {
      const money = parseWith(moneyValueSchema, value);
      return { amountMicros: money.amountMicros, currency: money.currency.toUpperCase() };
    }
    case 'emails':
      return multiValue<string>(
        value,
        (raw) => {
          if (typeof raw !== 'string') fail('expected email addresses as strings');
          return parseWith(emailSchema, raw.trim().toLowerCase());
        },
        (email) => email,
        field.settings.maxValues,
      ) satisfies EmailsValue;
    case 'phones':
      return multiValue(
        value,
        (raw) => {
          const phone = typeof raw === 'string' ? { number: raw } : raw;
          const parsed = parseWith(phoneInputSchema, phone);
          if (!/^[+\d][\d\s().-]*$/.test(parsed.number))
            fail(`"${parsed.number}" is not a phone number`);
          return parsed;
        },
        (phone) => phone.number.replace(/[^\d+]/g, ''),
        field.settings.maxValues,
      ) satisfies PhonesValue;
    case 'links':
      return multiValue(
        value,
        (raw) => {
          const link = typeof raw === 'string' ? { url: raw } : raw;
          const parsed = parseWith(linkInputSchema, link);
          return { ...parsed, url: normalizeUrl(parsed.url) };
        },
        (link) => link.url.toLowerCase(),
        field.settings.maxValues,
      ) satisfies LinksValue;
    case 'full_name': {
      if (typeof value === 'string') {
        const [first = '', ...rest] = value.trim().split(/\s+/);
        return { first, last: rest.join(' ') } satisfies FullNameValue;
      }
      const name = parseWith(fullNameValueSchema.strict(), value);
      if (!name.first && !name.last) fail('a name needs a first or last part');
      return name;
    }
    case 'address':
      return parseWith(addressValueSchema.strict(), value);
    case 'relation': {
      if (isInverseRelation(field)) {
        fail('this is the read-only side of a relation; write the other side instead');
      }
      if (!isCollectionRelation(field)) {
        return parseWith(z.uuid({ message: 'expected the ID of the related record' }), value);
      }
      // A set: duplicates dropped, ordered by ID, since membership is unordered.
      if (!Array.isArray(value)) fail('expected an array of related record IDs ([] clears it)');
      const ids = value.map((id) =>
        parseWith(z.uuid({ message: 'expected the ID of a related record' }), id),
      );
      return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
    }
    case 'files':
      return [...new Set(parseWith(filesValueSchema, value).map((id) => id.toLowerCase()))];
    case 'json':
      if (value === undefined) fail('expected a JSON value');
      return JSON.parse(JSON.stringify(value));
  }
}

/** Validates an editor value, including clearing a nullable field. */
export function validateFieldValue(field: ValueField, value: unknown): unknown {
  const collection = isCollectionRelation(field);
  if (value === null) {
    if (collection) throw new FieldValueError('takes an array of record IDs; [] clears it');
    if (!field.isNullable) throw new FieldValueError('is required and cannot be null');
    return null;
  }
  const normalized = normalizeFieldValue(field, value);
  if (
    (collection || field.type === 'files') &&
    !field.isNullable &&
    (normalized as unknown[]).length === 0
  ) {
    throw new FieldValueError(
      field.type === 'files'
        ? 'is required: give at least one file'
        : 'is required: give at least one record',
    );
  }
  return normalized;
}

const recordIdSchema = z.uuid();
/**
 * Whether a value is a record ID as the API validates one (`z.uuid()`, RFC
 * 9562), so a client can drop a malformed ID before a request would fail.
 */
export const isRecordId = (value: unknown): value is string =>
  recordIdSchema.safeParse(value).success;
