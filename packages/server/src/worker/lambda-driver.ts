import {
  decodeVerification,
  executionResultSchema,
  type Invocation,
  type VerificationInvocation,
  verificationResultSchema,
} from '@retainer/extension';
import type { RoutineInvocation } from '@retainer/shared';
import type { Sql } from '../db/client.js';
import { HOSTED_WRITER_BUILD } from '../db/writer-build.js';
import { acquireWriterLease, settleWriterLease } from '../db/writer-lease.js';
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
    const lambda = new LambdaClient({
      // The job lease and idempotency keys govern application retries.
      // A transport retry could start a second remote invocation.
      maxAttempts: 1,
    });
    return (FunctionName, Payload, abortSignal) =>
      lambda.send(new InvokeCommand({ FunctionName, Payload, InvocationType: 'RequestResponse' }), {
        abortSignal,
      });
  });
  return (await client)(target, payload, signal);
};

const prefixPattern = /^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}$/;

/** Every Lambda catalog entry must identify an immutable numeric function version. */
export function assertLambdaVersionTarget(target: string) {
  if (!/^arn:aws:lambda:[a-z0-9-]+:\d{12}:function:[A-Za-z0-9_-]{1,64}:[1-9]\d*$/.test(target))
    throw new Error('Lambda target must be a qualified version ARN');
}

/** Only immutable numeric function versions from the role's operator-owned namespace. */
export function assertLambdaTarget(target: string, prefix: string) {
  assertLambdaVersionTarget(target);
  if (!prefixPattern.test(prefix) || !target.slice(0, target.lastIndexOf(':')).startsWith(prefix))
    throw new Error('Lambda target must be a qualified version ARN within the configured prefix');
}

export class LambdaDriver implements ExecutionDriver {
  private readonly prefix: string;
  constructor(
    prefix: string | undefined,
    private readonly invokeFunction: LambdaInvoke = invokeLambda,
    private readonly leaseSql?: Sql,
  ) {
    if (!prefix || !prefixPattern.test(prefix))
      throw new Error('invalid extension runtime configuration');
    this.prefix = prefix;
  }
  protected async request(
    target: string,
    input: unknown,
    signal: AbortSignal,
    cap: number,
    effect?: string,
  ) {
    assertLambdaTarget(target, this.prefix);
    // An aborted socket does not stop a request Lambda accepted. Leave the
    // durable hold for reconciliation when the result is uncertain.
    const sql = HOSTED_WRITER_BUILD && effect ? this.leaseSql : undefined;
    const lease =
      sql &&
      (await acquireWriterLease(sql, 320_000, {
        effect,
      }));
    if (signal.aborted) {
      await settleWriterLease(sql, lease);
      signal.throwIfAborted();
    }
    const result = await this.invokeFunction(
      target,
      Buffer.from(JSON.stringify(input)),
      signal,
    ).catch(async (error) => {
      // These are definite AWS refusals. Other failures may be a lost response
      // after execution and require reconciliation before migration.
      if (
        sql &&
        ['TooManyRequestsException', 'ResourceNotFoundException', 'AccessDeniedException'].includes(
          (error as { name?: string })?.name ?? '',
        )
      )
        await settleWriterLease(sql, lease);
      throw error;
    });
    // A normal Lambda return settles the invocation before we validate its
    // protocol response. A function crash can leave an outside result unknown.
    if (sql && result.StatusCode === 200 && !result.FunctionError)
      await settleWriterLease(sql, lease);
    if (result.StatusCode !== 200 || result.FunctionError || !result.Payload)
      throw new Error('Lambda execution unavailable');
    if (result.Payload.byteLength > cap) throw new Error('Lambda result exceeds size limit');
    return JSON.parse(Buffer.from(result.Payload).toString('utf8')) as unknown;
  }
  /** An extension run, or a routine run of the routine runner bundle (routines spec §3.3). */
  async invoke(
    executable: Executable,
    invocation: Invocation | RoutineInvocation,
    signal: AbortSignal,
  ) {
    return executionResultSchema.parse(
      await this.request(
        executable.driverTarget,
        invocation,
        signal,
        65536,
        'installationId' in invocation
          ? `extension-run:${invocation.runId}`
          : `routine-run:${invocation.runId}`,
      ),
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
        `verifier:${invocation.verificationId}`,
      ),
    );
  }
}
