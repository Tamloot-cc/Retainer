import { isoDateTimeSchema } from '@retainer/shared';
import { z } from 'zod';

export const sourceBindingSchema = z.strictObject({
  accountId: z.string().min(1).max(500).optional(),
  sharing: z.literal('workspace'),
});
export const reserveSourceSchema = z.strictObject({
  sourceAccountId: z.uuid(),
  externalId: z.string().min(1).max(500),
});
export const prepareSourceSchema = z.strictObject({
  participants: z
    .array(
      z
        .email()
        .max(320)
        .transform((s) => s.toLowerCase()),
    )
    .max(200),
});
export const sourceUnavailableSchema = z
  .strictObject({
    status: z.enum(['unavailable', 'deleted']),
    evidence: z.enum(['provider_event', 'definitive_lookup']).optional(),
  })
  .refine((input) => input.status !== 'deleted' || input.evidence !== undefined, {
    message: 'deletion requires verified provider evidence',
  });
export const sourceEventSchema = z.strictObject({
  sourceItemId: z.uuid(),
  providerRevision: z.string().min(1).max(500).optional(),
  expectedRevisionId: z.uuid().nullable(),
  contentDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  event: z.strictObject({
    type: z.uuid(),
    occurredAt: isoDateTimeSchema,
    title: z.string().max(500),
    summary: z.string().max(20000).optional(),
    fields: z.record(z.string(), z.unknown()).default({}),
    participants: z
      .array(
        z.strictObject({
          email: z
            .email()
            .max(320)
            .transform((s) => s.toLowerCase()),
          name: z.string().max(200).optional(),
          /** Trusted provider evidence, accepted only from a release-pinned ingestion function. */
          contacted: z.boolean().default(false),
        }),
      )
      .max(200)
      .default([]),
    about: z.array(z.uuid()).max(200).default([]),
  }),
});
export type SourceEventInput = z.infer<typeof sourceEventSchema>;
export type SourceResult = {
  sourceItemId: string;
  revisionId: string;
  eventId: string;
  created: boolean;
  unchanged: boolean;
  stale?: boolean;
  previousEventId?: string;
  contentDigest: string;
  invalidated: {
    retractedAssertions: number;
    recomputedRecordIds: string[];
    hiddenFactIds: string[];
  };
};
