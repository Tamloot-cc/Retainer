import { createHmac, randomBytes } from 'node:crypto';
import type { VerificationInvocation } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import { FIXTURE_WEBHOOK_ID, verifyStandardWebhook, verifyWebhook } from './webhooks.js';

const key = randomBytes(32),
  now = Date.now();
function signed(body = '{ "externalId": "source-1" }'): VerificationInvocation {
  const stamp = String(Math.floor(now / 1000)),
    id = 'delivery-1';
  return {
    protocolVersion: 1,
    kind: 'webhook',
    verificationId: 'c230119e-d9af-48b0-8585-024c03355c94',
    releaseDigest: 'a'.repeat(64),
    functionId: FIXTURE_WEBHOOK_ID,
    rawBody: Buffer.from(body).toString('base64'),
    headers: {
      'webhook-id': id,
      'webhook-timestamp': stamp,
      'webhook-signature': `v1,${createHmac('sha256', key).update(`${id}.${stamp}.${body}`).digest('base64')}`,
    },
    secret: `whsec_${key.toString('base64')}`,
    deadline: new Date(now + 5000).toISOString(),
  };
}
describe('bounded raw-byte webhook verification', () => {
  it('verifies exact bytes and returns only the authenticated delivery and source identity', async () => {
    expect(await verifyWebhook(signed())).toEqual({
      status: 'verified',
      deliveryId: 'delivery-1',
      externalId: 'source-1',
    });
    expect(verifyStandardWebhook(signed(), now)).toBe('delivery-1');
    expect(
      await verifyWebhook({
        ...signed(),
        rawBody: Buffer.from('{"externalId":"source-1"}').toString('base64'),
      }),
    ).toEqual({ status: 'rejected' });
  });
  it('rejects altered IDs, timestamps, keys, bodies and stale or future replays', async () => {
    const original = signed();
    for (const input of [
      { ...original, headers: { ...original.headers, 'webhook-id': 'another' } },
      { ...original, headers: { ...original.headers, 'webhook-timestamp': '1' } },
      { ...original, secret: `whsec_${randomBytes(32).toString('base64')}` },
      { ...original, secret: 'not-a-signing-key' },
      { ...original, rawBody: Buffer.from('{}').toString('base64') },
    ])
      expect(await verifyWebhook(input)).toEqual({ status: 'rejected' });
    expect(verifyStandardWebhook(original, now + 301000)).toBeNull();
    expect(verifyStandardWebhook(original, now - 301000)).toBeNull();
  });
  it('supports a signature rotation list and refuses unknown bundles or invalid authenticated payloads', async () => {
    const input = signed();
    input.headers['webhook-signature'] =
      `v2,unsupported v1,${Buffer.alloc(32).toString('base64')} ${input.headers['webhook-signature']}`;
    expect(verifyStandardWebhook(input, now)).toBe('delivery-1');
    expect(await verifyWebhook({ ...input, functionId: input.verificationId })).toEqual({
      status: 'rejected',
    });
    expect(await verifyWebhook(signed('{"externalId":"source-1","workspace":"forged"}'))).toEqual({
      status: 'rejected',
    });
  });
});
