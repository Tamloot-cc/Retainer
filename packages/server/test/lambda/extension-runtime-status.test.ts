import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { extensionFixture } from '../helpers/extensions.js';

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

const aws = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = aws.send;
  },
  InvokeCommand: class {
    constructor(public input: { FunctionName: string; Payload: Uint8Array }) {}
  },
}));

test('Lambda status checks every distinct packaged target and its release and role; payload cannot choose targets', async () => {
  const prefix = 'arn:aws:lambda:eu-central-1:123456789012:function:retainer-ext-';
  const verifierPrefix = prefix.replace('-ext-', '-extv-');
  const manifest = extensionFixture({
    functions: [0, 1, 2].map((i) => ({
      universalId: crypto.randomUUID(),
      name: `function-${i}`,
      description: 'Runtime proof',
      handlerDigest: 'b'.repeat(64),
      timeoutSeconds: 5,
      trigger: i === 2 ? { kind: 'route' as const, route: 'verify' } : { kind: 'job' as const },
      inputSchema: { type: 'object' as const, additionalProperties: false },
    })),
  });
  const release = new ExtensionCatalog([
    { manifest, actorCeiling: 'integration', runtimeEnabled: true },
  ]).list()[0];
  if (!release) throw new Error('missing fixture');
  const entries = manifest.functions.map((fn, i) => ({
    registrationId: manifest.universalId,
    releaseDigest: release.digest,
    functionId: fn.universalId,
    handlerDigest: fn.handlerDigest,
    packageDigest: manifest.packageDigest,
    runtimeVersion: 'node24',
    driverTarget: `${i === 2 ? verifierPrefix : prefix}bundle:1`,
  }));
  const config = loadConfig({
    DATABASE_URL: 'postgres://owner:password@localhost/unused',
    RETAINER_EXTENSION_DRIVER: 'lambda',
    RETAINER_EXTENSION_LAMBDA_PREFIX: prefix,
    RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX: verifierPrefix,
    RETAINER_EXTENSION_CATALOG: JSON.stringify([
      { manifest, actorCeiling: 'integration', runtimeEnabled: true },
    ]),
    RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(entries),
  });
  const command = { command: 'extension-runtime-status', targets: ['attacker-controlled'] };
  const result = { command: 'extension-runtime-status', protocol: 1, compatible: true };
  const respond = (patch: object = {}) =>
    aws.send.mockImplementation(async (command) => {
      expect(JSON.parse(Buffer.from(command.input.Payload).toString())).toEqual({ kind: 'health' });
      return {
        StatusCode: 200,
        Payload: Buffer.from(
          JSON.stringify({
            protocolVersion: 1,
            runtimeVersion: 'node24',
            releaseDigest: release.digest,
            mode: command.input.FunctionName.startsWith(verifierPrefix) ? 'verify' : 'job',
            ...patch,
          }),
        ),
      };
    });
  aws.send.mockClear();
  respond();
  expect(await createOpsHandler(config)(command)).toEqual(result);
  expect(aws.send).toHaveBeenCalledTimes(2);
  expect(aws.send.mock.calls.map(([command]) => command.input.FunctionName).sort()).toEqual(
    [...new Set(entries.map((entry) => entry.driverTarget))].sort(),
  );
  for (const mode of ['job', 'verify'] as const) {
    const prefixKey =
      mode === 'job'
        ? 'RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX'
        : 'RETAINER_EXTENSION_LAMBDA_PREFIX';
    const roleEntries = entries.filter((entry) =>
      entry.driverTarget.startsWith(mode === 'job' ? prefix : verifierPrefix),
    );
    respond();
    expect(
      await createOpsHandler({
        ...config,
        [prefixKey]: undefined,
        RETAINER_EXTENSION_EXECUTABLES: JSON.stringify(roleEntries),
      })(command),
    ).toEqual(result);
    expect(await createOpsHandler({ ...config, [prefixKey]: undefined })(command)).toEqual({
      ...result,
      compatible: false,
    });
  }
  for (const patch of [
    { releaseDigest: 'f'.repeat(64) },
    { mode: 'both' },
    { runtimeVersion: 'node26' },
    { protocolVersion: 2 },
  ]) {
    respond(patch);
    expect(await createOpsHandler(config)(command)).toEqual({ ...result, compatible: false });
  }
  aws.send.mockRejectedValue(new Error('unavailable'));
  expect(await createOpsHandler(config)(command)).toEqual({ ...result, compatible: false });
  expect(
    await createOpsHandler({ ...config, RETAINER_EXTENSION_EXECUTABLES: '[]' })(command),
  ).toEqual({ ...result, compatible: false });
});
