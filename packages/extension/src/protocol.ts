export const SYSTEM_LIFECYCLE_FUNCTION_ID = 'b150f9ad-0629-44d0-a103-67fa9b93426b';

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
  /**
   * Present only when the function declares `uses: ['model']` and the
   * installation's grant includes it: the model proxy's base URL and a token
   * that opens model calls and nothing else (model calls spec 3.2).
   */
  model: z.strictObject({ origin: z.url(), token: z.string().min(1).max(8192) }).optional(),
});
export const executionResultSchema = z.strictObject({
  status: z.enum(['succeeded', 'retry', 'failed']),
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,79}$/)
    .optional(),
  retryAfterSeconds: z.number().int().min(0).max(3600).optional(),
});
/**
 * The server-defined input of an `install` or `connect` lifecycle function: the release
 * version installed before this setup (an upgrade, re-enable or settings
 * re-setup), or null on a first install. Lifecycle input is not the
 * function's `inputSchema`; `uninstall` and `disconnect` input is `{}`. Jobs queued before
 * this field existed carry `{}`.
 */
export const lifecycleInputSchema = z.strictObject({
  previousVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .nullable()
    .optional(),
});
export type LifecycleInput = z.infer<typeof lifecycleInputSchema>;
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

export const RETRY_LATER_ERROR_NAME = 'RetryLater';
/**
 * Throw from a handler to ask for another attempt after a transient failure (network, 429,
 * 5xx). Any other exception fails the run for good; returning `{status: 'retry'}` also retries.
 * Matched by name, so copies of this package bundled separately still count.
 */
export class RetryLater extends Error {
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  constructor(options: { code?: string; retryAfterSeconds?: number; message?: string } = {}) {
    super(options.message ?? options.code ?? 'retry later');
    this.name = RETRY_LATER_ERROR_NAME;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
export const isRetryLater = (error: unknown): error is RetryLater =>
  error instanceof Error && error.name === RETRY_LATER_ERROR_NAME;
/** The protocol result for a RetryLater; an invalid code or hint is replaced, never forwarded. */
export function retryLaterResult(error: RetryLater): ExecutionResult {
  const code = executionResultSchema.shape.code.safeParse(error.code);
  const after = error.retryAfterSeconds;
  return {
    status: 'retry',
    code: code.success && code.data ? code.data : 'retry_later',
    ...(typeof after === 'number' && Number.isFinite(after)
      ? { retryAfterSeconds: Math.min(3600, Math.max(0, Math.ceil(after))) }
      : {}),
  };
}
