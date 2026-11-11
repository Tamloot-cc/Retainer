import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const invocationSchema = z.strictObject({
  protocolVersion: z.literal(1),
  runId: z.uuid(),
  attempt: z.number().int().positive(),
  installationId: z.uuid(),
  releaseDigest: digest,
  functionId: z.uuid(),
  input: z.json(),
  apiOrigin: z.url(),
  runToken: z.string().min(1).max(8192),
  deadline: z.iso.datetime(),
});
export const executionResultSchema = z.strictObject({
  status: z.enum(['succeeded', 'retry', 'failed']),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,79}$/)
    .optional(),
  retryAfterSeconds: z.number().int().min(0).max(3600).optional(),
});
export type Invocation = z.infer<typeof invocationSchema>;
export type ExecutionResult = z.infer<typeof executionResultSchema>;
/** Invoke with a bounded serialized envelope; callers never supply executable locations. */
export function decodeInvocation(text: string): Invocation {
  if (new TextEncoder().encode(text).length > 65536) throw new Error('invocation exceeds 64 KiB');
  try {
    return invocationSchema.parse(JSON.parse(text));
  } catch {
    throw new Error('invalid invocation envelope');
  }
}
