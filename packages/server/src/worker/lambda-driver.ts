import {
  decodeVerification,
  executionResultSchema,
  type Invocation,
  type VerificationInvocation,
  verificationResultSchema,
} from '@retainer/extension';
import type { Executable, ExecutionDriver } from './extensions.js';
import type { VerificationDriver } from './verifier-driver.js';

/** Small transport seam: tests replace AWS, never persistence. No credentials in configuration. */
export type LambdaInvoke = (
  target: string,
  payload: Uint8Array,
  signal: AbortSignal,
) => Promise<{ StatusCode?: number; FunctionError?: string; Payload?: Uint8Array }>;

// Even importing this module on Compose does not load the AWS SDK.
let client: Promise<LambdaInvoke> | undefined;
const invokeLambda: LambdaInvoke = async (target, payload, signal) => {
  client ??= import('@aws-sdk/client-lambda').then(({ LambdaClient, InvokeCommand }) => {
    const lambda = new LambdaClient({});
    return (FunctionName, Payload, abortSignal) =>
      lambda.send(new InvokeCommand({ FunctionName, Payload, InvocationType: 'RequestResponse' }), {
        abortSignal,
      });
  });
  return (await client)(target, payload, signal);
};

/** Only immutable numeric function versions from the role's operator-owned namespace. */
export function assertLambdaTarget(target: string, prefix: string) {
  if (
    !/^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}$/.test(prefix) ||
    !/^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}:[1-9]\d*$/.test(target) ||
    !target.slice(0, target.lastIndexOf(':')).startsWith(prefix)
  )
    throw new Error('Lambda target must be a qualified version ARN within the configured prefix');
}

export class LambdaDriver implements ExecutionDriver {
  constructor(
    private readonly prefix: string,
    private readonly invokeFunction: LambdaInvoke = invokeLambda,
  ) {}
  protected async request(target: string, input: unknown, signal: AbortSignal, cap: number) {
    assertLambdaTarget(target, this.prefix);
    const result = await this.invokeFunction(target, Buffer.from(JSON.stringify(input)), signal);
    // Function errors are platform failures, never a successful handler protocol result.
    if (result.StatusCode !== 200 || result.FunctionError || !result.Payload)
      throw new Error('Lambda execution unavailable');
    if (result.Payload.byteLength > cap) throw new Error('Lambda result exceeds size limit');
    return JSON.parse(Buffer.from(result.Payload).toString('utf8')) as unknown;
  }
  async invoke(executable: Executable, invocation: Invocation, signal: AbortSignal) {
    return executionResultSchema.parse(
      await this.request(executable.driverTarget, invocation, signal, 65536),
    );
  }
  async health(target: string, signal: AbortSignal) {
    return this.request(target, { kind: 'health' }, signal, 16384);
  }
}

export class LambdaVerifier extends LambdaDriver implements VerificationDriver {
  async verify(executable: Executable, input: VerificationInvocation, signal: AbortSignal) {
    const invocation = decodeVerification(JSON.stringify(input));
    if (
      invocation.functionId !== executable.functionId ||
      invocation.releaseDigest !== executable.releaseDigest
    )
      throw new Error('verifier differs from pinned executable');
    const remaining = new Date(invocation.deadline).getTime() - Date.now();
    if (remaining <= 0 || remaining > 5000) throw new Error('invalid verifier deadline');
    return verificationResultSchema.parse(
      await this.request(
        executable.driverTarget,
        invocation,
        AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
        16384,
      ),
    );
  }
}
