import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerificationInvocation, VerificationResult } from '@retainer/extension';
import { z } from 'zod';

export const FIXTURE_WEBHOOK_ID = 'fb7bdabc-490a-412b-8687-72f2f6f30ba9';
export const FIXTURE_VERIFIER_TIMEOUT_ID = '33bb3e43-557d-45ed-8f81-5baf6ee0f66d';
const signature = z.string().regex(/^v1,[A-Za-z0-9+/]{43}=$/);

/** Standard Webhooks v1: https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md */
export function verifyStandardWebhook(
  input: VerificationInvocation,
  now = Date.now(),
): string | null {
  const id = input.headers['webhook-id'],
    stamp = input.headers['webhook-timestamp'];
  if (
    !id ||
    id.length > 500 ||
    id.includes('.') ||
    [...id].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    !stamp ||
    !/^[0-9]{1,12}$/.test(stamp) ||
    Math.abs(now / 1000 - Number(stamp)) > 300
  )
    return null;
  if (!input.secret.startsWith('whsec_')) return null;
  const encoded = input.secret.slice(6),
    key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded) return null;
  const expected = createHmac('sha256', key)
    .update(`${id}.${stamp}.`)
    .update(Buffer.from(input.rawBody, 'base64'))
    .digest();
  for (const part of (input.headers['webhook-signature'] ?? '').split(' ')) {
    if (!signature.safeParse(part).success) continue;
    const supplied = Buffer.from(part.slice(3), 'base64');
    if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return id;
  }
  return null;
}

/** Reviewed static imports only. A verifier receives no SDK, fetch transport or CRM credential. */
export async function verifyWebhook(input: VerificationInvocation): Promise<VerificationResult> {
  // Deliberately unresponsive development fixture proves host-enforced termination.
  if (input.functionId === FIXTURE_VERIFIER_TIMEOUT_ID) return new Promise(() => {});
  if (input.functionId !== FIXTURE_WEBHOOK_ID) return { status: 'rejected' };
  const deliveryId = verifyStandardWebhook(input);
  if (!deliveryId) return { status: 'rejected' };
  try {
    const payload = z
      .strictObject({ externalId: z.string().min(1).max(500) })
      .parse(JSON.parse(Buffer.from(input.rawBody, 'base64').toString('utf8')));
    return { status: 'verified', deliveryId, externalId: payload.externalId };
  } catch {
    return { status: 'rejected' };
  }
}
