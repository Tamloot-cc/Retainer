#!/usr/bin/env node
// Builds separately; this proves the selected immutable Node 24 bundle with no network or credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(
  readFileSync(new URL('../artifacts/extensions/granola/metadata.json', import.meta.url), 'utf8'),
);
const target = process.env.RETAINER_GRANOLA_TEST_IMAGE ?? 'retainer:extension-granola';
const [inspected] = JSON.parse(
  execFileSync('docker', ['image', 'inspect', target], { encoding: 'utf8', cwd: root }),
);
assert.equal(inspected.Config.User, '65532:65532');
for (const [name, value] of Object.entries({
  protocol: '1',
  runtime: 'node24',
  release: metadata.releaseDigest,
  bundle: 'granola',
}))
  assert.equal(inspected.Config.Labels[`retainer.extension.${name}`], value);
const key = randomBytes(32),
  eventId = randomUUID();
function envelope(payloadId = eventId) {
  const stamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    event_id: payloadId,
    event_type: 'note.edited',
    note_id: 'not_123456789AbCdE',
    occurred_at: new Date().toISOString(),
    data: { changed_fields: ['summary'] },
  });
  return {
    protocolVersion: 1,
    kind: 'webhook',
    verificationId: randomUUID(),
    functionId: metadata.verifierFunctionIds[0],
    releaseDigest: metadata.releaseDigest,
    deadline: new Date(Date.now() + 5000).toISOString(),
    secret: `whsec_${key.toString('base64')}`,
    rawBody: Buffer.from(body).toString('base64'),
    headers: {
      'webhook-id': eventId,
      'webhook-timestamp': stamp,
      'webhook-signature': `v1,${createHmac('sha256', key).update(`${eventId}.${stamp}.${body}`).digest('base64')}`,
    },
  };
}
function invoke(input) {
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--read-only',
        '--memory',
        '128m',
        '--cpus',
        '0.5',
        '--pids-limit',
        '32',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        target,
      ],
      { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, cwd: root },
    ),
  );
}
assert.deepEqual(invoke(envelope()), {
  status: 'verified',
  deliveryId: eventId,
  externalId: 'not_123456789abcde',
});
assert.deepEqual(invoke({ ...envelope(), rawBody: Buffer.from('{}').toString('base64') }), {
  status: 'rejected',
});
assert.deepEqual(invoke(envelope(randomUUID())), { status: 'rejected' });
assert.deepEqual(invoke({ ...envelope(), releaseDigest: '0'.repeat(64) }), {
  status: 'failed',
  code: 'incompatible_runtime',
});
console.log(
  'PASS: immutable Node 24 Granola verifier; no network, non-root, raw-byte/id/release fencing.',
);
