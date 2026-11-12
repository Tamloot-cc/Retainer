import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { VerificationInvocation } from '@retainer/extension';
import { describe, expect, it } from 'vitest';
import type { Executable } from './extensions.js';
import { LauncherVerifier } from './verifier-driver.js';

const executable: Executable = {
  registrationId: randomUUID(),
  releaseDigest: 'a'.repeat(64),
  functionId: randomUUID(),
  handlerDigest: 'b'.repeat(64),
  packageDigest: 'c'.repeat(64),
  runtimeVersion: 'node24',
  driverTarget: 'reviewed-fixture',
};
const invocation = (): VerificationInvocation => ({
  protocolVersion: 1,
  kind: 'webhook',
  verificationId: randomUUID(),
  releaseDigest: executable.releaseDigest,
  functionId: executable.functionId,
  rawBody: '',
  headers: {},
  secret: 'candidate-secret',
  deadline: new Date(Date.now() + 5000).toISOString(),
});
describe('dedicated verifier transport', () => {
  it('uses only the verifier credential and enforces deadline, output bounds and closed result shape', async () => {
    const seen: { path: string; token: string; body: unknown }[] = [];
    let outcome = JSON.stringify({
        status: 'verified',
        deliveryId: 'delivery',
        externalId: 'source',
      }),
      hang = false;
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      seen.push({
        path: req.url ?? '',
        token: req.headers.authorization ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      if (hang) return;
      res.end(outcome);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test listener missing');
    const driver = new LauncherVerifier(`http://127.0.0.1:${address.port}`, 'v'.repeat(32));
    try {
      const input = invocation();
      expect(await driver.verify(executable, input, new AbortController().signal)).toEqual({
        status: 'verified',
        deliveryId: 'delivery',
        externalId: 'source',
      });
      expect(seen[0]).toEqual({
        path: '/verify',
        token: `Bearer ${'v'.repeat(32)}`,
        body: { bundleId: executable.driverTarget, invocation: input },
      });
      outcome = JSON.stringify({
        status: 'verified',
        deliveryId: 'delivery',
        externalId: 'source',
        workspaceId: randomUUID(),
      });
      await expect(
        driver.verify(executable, invocation(), new AbortController().signal),
      ).rejects.toThrow('invalid verifier result');
      outcome = 'x'.repeat(16385);
      await expect(
        driver.verify(executable, invocation(), new AbortController().signal),
      ).rejects.toThrow('16 KiB');
      hang = true;
      await expect(
        driver.verify(
          executable,
          { ...invocation(), deadline: new Date(Date.now() + 100).toISOString() },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      await expect(
        driver.verify(
          executable,
          { ...invocation(), deadline: new Date(Date.now() + 6000).toISOString() },
          new AbortController().signal,
        ),
      ).rejects.toThrow('deadline');
      expect(seen).toHaveLength(4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
