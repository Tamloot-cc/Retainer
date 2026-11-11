import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createOpsHandler } from '../../src/lambda/ops.js';

test('operator health checks the configured runtime and exact release snapshot before writers restart', async () => {
  let body: unknown = {
    status: 'ok',
    protocolVersion: 1,
    runtimeVersion: 'node24',
    configurationDigest: 'a'.repeat(64),
    bundles: 2,
  };
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = loadConfig({
      DATABASE_URL: 'postgres://owner:password@localhost/unused',
      RETAINER_EXTENSION_LAUNCHER_ORIGIN: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    });
    const handler = createOpsHandler(config);
    const command = {
      command: 'extension-runtime-status',
      configurationDigest: 'a'.repeat(64),
      bundles: 2,
    };
    expect(await handler(command)).toEqual({
      command: 'extension-runtime-status',
      protocol: 1,
      compatible: true,
    });
    for (const status of [
      { ...(body as object), configurationDigest: 'b'.repeat(64) },
      { ...(body as object), bundles: 1 },
      { ...(body as object), runtimeVersion: 'node26' },
      { status: 'unavailable' },
    ]) {
      body = status;
      expect(await handler(command)).toEqual({
        command: 'extension-runtime-status',
        protocol: 1,
        compatible: false,
      });
    }
    await expect(
      createOpsHandler(loadConfig({ DATABASE_URL: 'postgres://owner:password@localhost/unused' }))(
        command,
      ),
    ).rejects.toThrow('not configured');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
