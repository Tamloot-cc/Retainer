import { z } from 'zod';

export const MAX_WEBHOOK_BYTES = 262144;
export const verificationInvocationSchema = z.strictObject({
  protocolVersion: z.literal(1),
  kind: z.literal('webhook'),
  verificationId: z.uuid(),
  releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  functionId: z.uuid(),
  /** Exact request bytes, never parsed/re-serialized before signature verification. */
  rawBody: z
    .string()
    .max(349528)
    .refine((value) => {
      try {
        const bytes = atob(value);
        return bytes.length <= MAX_WEBHOOK_BYTES && btoa(bytes) === value;
      } catch {
        return false;
      }
    }),
  headers: z
    .record(z.string().regex(/^[a-z0-9-]{1,100}$/), z.string().max(8192))
    .refine(
      (value) =>
        Object.keys(value).length <= 32 &&
        new TextEncoder().encode(JSON.stringify(value)).length <= 32768,
    ),
  secret: z
    .string()
    .min(1)
    .max(65536)
    .refine((value) => new TextEncoder().encode(value).length <= 65536),
  deadline: z.iso.datetime(),
});
export const verificationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('verified'),
    deliveryId: z.string().min(1).max(500),
    externalId: z.string().min(1).max(500),
  }),
  z.strictObject({ status: z.literal('rejected') }),
  z.strictObject({
    status: z.literal('challenge'),
    body: z.string().max(8192),
    contentType: z.literal('text/plain'),
  }),
]);
export type VerificationInvocation = z.infer<typeof verificationInvocationSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;

/** No workspace, installation, CRM token, executable target or network capability is accepted. */
export function decodeVerification(text: string): VerificationInvocation {
  if (new TextEncoder().encode(text).length > 524288)
    throw new Error('verification exceeds 512 KiB');
  try {
    return verificationInvocationSchema.parse(JSON.parse(text));
  } catch {
    throw new Error('invalid verification envelope');
  }
}
