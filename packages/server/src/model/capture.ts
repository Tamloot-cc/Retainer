import { z } from 'zod';
import type { ModelClaims } from '../extension-runtime/tokens.js';

const MAX_BYTES = 32 * 1024;
const MAX_WINDOW_MS = 24 * 60 * 60_000;
export const capturePolicySchema = z
  .strictObject({
    workspaceId: z.uuid(),
    ownerKind: z.enum(['routine', 'extension']),
    ownerId: z.uuid(),
    startsAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .refine(({ startsAt, expiresAt }) => {
    const duration = Date.parse(expiresAt) - Date.parse(startsAt);
    return duration > 0 && duration <= MAX_WINDOW_MS;
  });
export type CapturePolicy = z.infer<typeof capturePolicySchema>;
const body = z.base64().refine((value) => Buffer.byteLength(value, 'base64') <= MAX_BYTES);
export const capturedPayloadSchema = z.strictObject({
  requestBody: body,
  responseBody: body,
  requestTruncated: z.boolean(),
  responseTruncated: z.boolean(),
  responsePartial: z.boolean(),
});
export type CapturedPayload = z.infer<typeof capturedPayloadSchema>;

/** The run or job a model token belongs to, as `model_calls` stores it. */
export const ownerOf = (claims: ModelClaims) =>
  claims.kind === 'routine'
    ? { kind: 'routine' as const, id: claims.runId }
    : { kind: 'extension' as const, id: claims.jobId };

const credentialText =
  /(?:\bBearer\s+[A-Za-z0-9._~-]+|\bsk-ant-|\brt_(?:model|routine)_|\bgh[pousr]_|\bAKIA[A-Z0-9]{12})/i;

/** Credential-bearing requests are skipped completely. */
function hasCredentialFields(content: unknown): boolean {
  const pending = [content];
  while (pending.length) {
    const next = pending.pop();
    if (typeof next === 'string' && credentialText.test(next)) return true;
    if (next === null || typeof next !== 'object') continue;
    for (const [key, value] of Object.entries(next)) {
      if (
        /^(?:authorization(?:[-_]?token)?|(?:x[-_])?api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|cookie|headers|mcp_servers)$/i.test(
          key,
        )
      )
        return true;
      if (typeof value === 'string' || (value !== null && typeof value === 'object'))
        pending.push(value);
    }
  }
  return false;
}

export function captureFor(
  policy: CapturePolicy | undefined,
  claims: ModelClaims,
  started: number,
  request: Uint8Array | undefined,
  parsed: unknown,
) {
  if (!policy || !request || policy.workspaceId !== claims.workspaceId) return;
  const owner = ownerOf(claims);
  if (policy.ownerKind !== owner.kind || policy.ownerId !== owner.id) return;
  const expires = Date.parse(policy.expiresAt);
  if (started < Date.parse(policy.startsAt) || started >= expires || hasCredentialFields(parsed))
    return;

  const requestBody = Buffer.from(request.subarray(0, MAX_BYTES)).toString('base64');
  const requestTruncated = request.length > MAX_BYTES;
  const responseChunks: Buffer[] = [];
  let remaining = MAX_BYTES;
  let responseTruncated = false;
  return {
    push(chunk: Uint8Array) {
      const kept = Math.min(remaining, chunk.length);
      if (kept > 0) responseChunks.push(Buffer.from(chunk.subarray(0, kept)));
      remaining -= kept;
      responseTruncated ||= kept < chunk.length;
    },
    finish(responsePartial: boolean, finished: number): CapturedPayload | undefined {
      const response = Buffer.concat(responseChunks);
      if (finished >= expires || credentialText.test(response.toString('utf8'))) return;
      return {
        requestBody,
        requestTruncated,
        responseBody: response.toString('base64'),
        responseTruncated,
        responsePartial,
      };
    },
  };
}
