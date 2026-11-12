import { randomUUID } from 'node:crypto';
import type { Invocation, VerificationInvocation } from '@retainer/extension';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import type { Executable } from './extensions.js';
import {
  assertLambdaTarget,
  LambdaDriver,
  type LambdaInvoke,
  LambdaVerifier,
} from './lambda-driver.js';

const aws = vi.hoisted(() => ({ loaded: false, send: vi.fn() }));
vi.mock('@aws-sdk/client-lambda', () => {
  aws.loaded = true;
  return {
    LambdaClient: class {
      send = aws.send;
    },
    InvokeCommand: class {
      constructor(public input: unknown) {}
    },
  };
});
const prefix = 'arn:aws:lambda:eu-central-1:123456789012:function:retainer-ext-';
const verifierPrefix = prefix.replace('-ext-', '-extv-');
const executable: Executable = {
  registrationId: randomUUID(),
  releaseDigest: 'a'.repeat(64),
  functionId: randomUUID(),
  packageDigest: 'b'.repeat(64),
  handlerDigest: 'c'.repeat(64),
  runtimeVersion: 'node24',
  driverTarget: `${prefix}bundle:12`,
};
const invocation: Invocation = {
  protocolVersion: 1,
  runId: randomUUID(),
  attempt: 1,
  installationId: randomUUID(),
  releaseDigest: executable.releaseDigest,
  functionId: executable.functionId,
  input: {},
  apiOrigin: 'https://retainer.test',
  runToken: 'rt_run_test',
  deadline: new Date(Date.now() + 10000).toISOString(),
};
const signal = new AbortController().signal;
const payload = (value: unknown) => ({
  StatusCode: 200,
  Payload: Buffer.from(JSON.stringify(value)),
});
describe('operator-selected Lambda drivers', () => {
  it('does not load AWS on import or on the default launcher configuration', () => {
    expect(
      loadConfig({ DATABASE_URL: 'postgres://localhost/test' }).RETAINER_EXTENSION_DRIVER,
    ).toBe('launcher');
    expect(aws.loaded).toBe(false);
  });
  it('requires immutable numeric version ARNs within the exact role prefix', () => {
    expect(() => assertLambdaTarget(executable.driverTarget, prefix)).not.toThrow();
    for (const target of [
      `${prefix}bundle`,
      `${prefix}bundle:$LATEST`,
      `${prefix}bundle:live`,
      `${prefix}bundle:0`,
      'bundle:12',
      `${verifierPrefix}bundle:12`,
      executable.driverTarget.replace('123456789012', '987654321012'),
      executable.driverTarget.replace('eu-central-1', 'us-east-1'),
    ])
      expect(() => assertLambdaTarget(target, prefix)).toThrow('qualified version');
    expect(() => assertLambdaTarget(executable.driverTarget, 'retainer-ext-')).toThrow();
  });
  it('sends the protocol itself, preserves abort, and returns handler outcomes', async () => {
    const transport = vi.fn<LambdaInvoke>(async () =>
      payload({ status: 'retry', code: 'provider_busy' }),
    );
    expect(
      await new LambdaDriver(prefix, transport).invoke(executable, invocation, signal),
    ).toEqual({ status: 'retry', code: 'provider_busy' });
    const call = transport.mock.calls[0];
    if (!call) throw new Error('missing invocation');
    const [target, bytes, passedSignal] = call;
    expect(target).toBe(executable.driverTarget);
    expect(JSON.parse(Buffer.from(bytes).toString())).toEqual(invocation);
    expect(passedSignal).toBe(signal);
    expect(aws.loaded).toBe(false);
  });
  it('throws platform errors, invalid protocol payloads and oversize results', async () => {
    for (const result of [
      { ...payload({ status: 'succeeded' }), FunctionError: 'Unhandled' },
      { StatusCode: 429 },
      { StatusCode: 503 },
      { StatusCode: 200 },
      payload({ status: 'succeeded', secret: 'must not escape' }),
      { StatusCode: 200, Payload: Buffer.from('not json') },
      { StatusCode: 200, Payload: Buffer.alloc(65537) },
    ])
      await expect(
        new LambdaDriver(prefix, async () => result).invoke(executable, invocation, signal),
      ).rejects.toThrow();
    for (const name of [
      'TooManyRequestsException',
      'ServiceException',
      'ECONNRESET',
      'AbortError',
    ]) {
      const error = Object.assign(new Error('platform failure'), { name });
      await expect(
        new LambdaDriver(prefix, async () => {
          throw error;
        }).invoke(executable, invocation, signal),
      ).rejects.toBe(error);
    }
  });
  it('pins verifier identity, caps results, bounds deadlines and refuses the job namespace', async () => {
    const verifier = { ...executable, driverTarget: `${verifierPrefix}bundle:12` };
    const input: VerificationInvocation = {
      protocolVersion: 1,
      kind: 'webhook',
      verificationId: randomUUID(),
      releaseDigest: executable.releaseDigest,
      functionId: executable.functionId,
      rawBody: '',
      headers: {},
      secret: 'secret',
      deadline: new Date(Date.now() + 4000).toISOString(),
    };
    const transport = vi.fn<LambdaInvoke>(async () => payload({ status: 'rejected' }));
    const driver = new LambdaVerifier(verifierPrefix, transport);
    expect(await driver.verify(verifier, input, signal)).toEqual({ status: 'rejected' });
    for (const change of [
      { functionId: randomUUID() },
      { releaseDigest: 'b'.repeat(64) },
      { deadline: new Date(Date.now() - 1).toISOString() },
      { deadline: new Date(Date.now() + 6000).toISOString() },
    ])
      await expect(driver.verify(verifier, { ...input, ...change }, signal)).rejects.toThrow();
    await expect(driver.verify(executable, input, signal)).rejects.toThrow('qualified version');
    await expect(
      new LambdaVerifier(verifierPrefix, async () => ({
        StatusCode: 200,
        Payload: Buffer.alloc(16385),
      })).verify(verifier, input, signal),
    ).rejects.toThrow('size limit');
    const abort = new AbortController();
    await driver.verify(verifier, input, abort.signal);
    abort.abort();
    expect(transport.mock.calls.at(-1)?.[2].aborted).toBe(true);
  });
  it('loads per-role prefixes independently and rejects overlap or invalid concurrency', () => {
    const env = {
      DATABASE_URL: 'postgres://localhost/test',
      RETAINER_EXTENSION_DRIVER: 'lambda',
      RETAINER_EXTENSION_LAMBDA_PREFIX: prefix,
      RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX: verifierPrefix,
    };
    expect(loadConfig(env).RETAINER_EXECUTOR_CONCURRENCY).toBe(8);
    for (const job of ['', prefix])
      for (const verifier of ['', verifierPrefix])
        expect(() =>
          loadConfig({
            ...env,
            RETAINER_EXTENSION_LAMBDA_PREFIX: job,
            RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX: verifier,
          }),
        ).not.toThrow();
    for (const Driver of [LambdaDriver, LambdaVerifier]) {
      for (const missing of [undefined, '', 'invalid-sensitive-configuration']) {
        expect(() => new Driver(missing)).toThrow(/^invalid extension runtime configuration$/);
      }
    }
    for (const verifier of [prefix, `${prefix}verify-`])
      expect(() =>
        loadConfig({ ...env, RETAINER_EXTENSION_VERIFIER_LAMBDA_PREFIX: verifier }),
      ).toThrow();
    for (const concurrency of ['0', '33', '1.5'])
      expect(() => loadConfig({ ...env, RETAINER_EXECUTOR_CONCURRENCY: concurrency })).toThrow();
  });
  it('lazily uses RequestResponse and the default AWS credential chain', async () => {
    aws.send.mockResolvedValue(payload({ status: 'succeeded' }));
    await new LambdaDriver(prefix).invoke(executable, invocation, signal);
    expect(aws.loaded).toBe(true);
    expect(aws.send.mock.calls[0]?.[0].input).toEqual({
      FunctionName: executable.driverTarget,
      Payload: Buffer.from(JSON.stringify(invocation)),
      InvocationType: 'RequestResponse',
    });
    expect(aws.send.mock.calls[0]?.[1]).toEqual({ abortSignal: signal });
  });
});
