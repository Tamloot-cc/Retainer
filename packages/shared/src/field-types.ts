import { z } from 'zod';

/**
 * Every field has one of these types. The type decides how the value is
 * validated and how it is stored in `records.data`.
 */
export const FIELD_TYPES = [
  'text',
  'number',
  'boolean',
  'date',
  'date_time',
  'select',
  'multi_select',
  'money',
  'emails',
  'phones',
  'links',
  'full_name',
  'address',
  'relation',
  'json',
  'files',
] as const;

/** Immutable ready file IDs only; bytes and display metadata use the authorized file API. */
export const filesValueSchema = z.array(z.uuid()).max(20);
export type FilesValue = z.infer<typeof filesValueSchema>;

export type FieldType = (typeof FIELD_TYPES)[number];

// Composite shapes: one logical field, several values. Defined once so every
// object stores them the same way.

export const moneyValueSchema = z.object({
  /** Amount in millionths of the currency unit, to avoid float rounding. */
  amountMicros: z.number().int(),
  /** ISO 4217 code, e.g. "USD". */
  currency: z.string().length(3),
});

export const emailsValueSchema = z.object({
  primary: z.email().nullable(),
  additional: z.array(z.email()).default([]),
});

const phoneSchema = z.object({
  number: z.string().min(1),
  /** ISO 3166-1 alpha-2, e.g. "IL". */
  countryCode: z.string().length(2).optional(),
});

export const phonesValueSchema = z.object({
  primary: phoneSchema.nullable(),
  additional: z.array(phoneSchema).default([]),
});

const linkSchema = z.object({
  url: z.url(),
  label: z.string().optional(),
});

export const linksValueSchema = z.object({
  primary: linkSchema.nullable(),
  additional: z.array(linkSchema).default([]),
});

export const fullNameValueSchema = z.object({
  first: z.string().default(''),
  last: z.string().default(''),
});

export const addressValueSchema = z.object({
  street1: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
  country: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

export type MoneyValue = z.infer<typeof moneyValueSchema>;
export type EmailsValue = z.infer<typeof emailsValueSchema>;
export type PhonesValue = z.infer<typeof phonesValueSchema>;
export type LinksValue = z.infer<typeof linksValueSchema>;
export type FullNameValue = z.infer<typeof fullNameValueSchema>;
export type AddressValue = z.infer<typeof addressValueSchema>;

/**
 * Field types holding a list of values (a primary plus `additional`): they
 * take `maxValues`, and a merge combines both records' lists.
 */
export const MULTI_VALUE_TYPES: ReadonlySet<FieldType> = new Set(['emails', 'phones', 'links']);

/** Field types whose value is an object with several parts. */
export const COMPOSITE_FIELD_TYPES = [
  'money',
  'emails',
  'phones',
  'links',
  'full_name',
  'address',
] as const satisfies readonly FieldType[];

export type CompositeFieldType = (typeof COMPOSITE_FIELD_TYPES)[number];

export const compositeValueSchemas = {
  money: moneyValueSchema,
  emails: emailsValueSchema,
  phones: phonesValueSchema,
  links: linksValueSchema,
  full_name: fullNameValueSchema,
  address: addressValueSchema,
} satisfies Record<CompositeFieldType, z.ZodType>;
