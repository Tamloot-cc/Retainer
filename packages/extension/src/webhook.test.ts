import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeVerification, verificationResultSchema } from './webhook.js';

const envelope = () => ({
  protocolVersion: 1,
  kind: 'webhook',
  verificationId: randomUUID(),
  releaseDigest: 'a'.repeat(64),
  functionId: randomUUID(),
  rawBody: Buffer.from('raw\u0000bytes').toString('base64'),
  headers: { 'webhook-id': 'one' },
  secret: 'candidate-only',
  deadline: new Date().toISOString(),
});
describe('verifier protocol', () => {
  it('preserves raw bytes and cannot carry a CRM credential or choose a target workspace', () => {
    const input = envelope();
    expect(decodeVerification(JSON.stringify(input))).toEqual(input);
    for (const extra of [
      { runToken: 'forged' },
      { apiOrigin: 'https://attacker.test' },
      { workspaceId: randomUUID() },
      { module: 'remote.js' },
    ])
      expect(() => decodeVerification(JSON.stringify({ ...input, ...extra }))).toThrow(
        'invalid verification envelope',
      );
    expect(() =>
      verificationResultSchema.parse({
        status: 'verified',
        deliveryId: 'one',
        externalId: 'source',
        workspaceId: randomUUID(),
      }),
    ).toThrow();
  });
  it('bounds body, headers and secrets independently before isolated execution', () => {
    for (const patch of [
      { rawBody: Buffer.alloc(262145).toString('base64') },
      { rawBody: 'not base64' },
      { headers: { 'Invalid-Header': 'value' } },
      { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`h-${i}`, 'v'])) },
      { secret: '😀'.repeat(17000) },
    ])
      expect(() => decodeVerification(JSON.stringify({ ...envelope(), ...patch }))).toThrow();
    expect(
      decodeVerification(
        JSON.stringify({ ...envelope(), rawBody: Buffer.alloc(262144).toString('base64') }),
      ).rawBody,
    ).toHaveLength(349528);
  });
});
