import { readFile } from 'node:fs/promises';
import {
  decodeInvocation,
  decodeVerification,
  type ExecutionResult,
  type VerificationResult,
} from '@retainer/extension';
import { settle } from './outcome.js';
import { execute } from './registry.js';
import { verifyWebhook } from './webhooks.js';

export type RunnerMode = 'job' | 'verify' | 'both';
export type HealthResult = {
  protocolVersion: 1;
  runtimeVersion: 'node24';
  releaseDigest: string;
  mode: RunnerMode;
};

async function bundledRelease(): Promise<string | undefined> {
  if (process.env.RETAINER_BUNDLED_RELEASE_DIGEST)
    return process.env.RETAINER_BUNDLED_RELEASE_DIGEST;
  try {
    const release: unknown = JSON.parse(
      await readFile(new URL('../release.json', import.meta.url), 'utf8'),
    );
    const digest = (release as { releaseDigest?: unknown })?.releaseDigest;
    return typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) ? digest : undefined;
  } catch {
    return undefined;
  }
}

/** All credentials, clients, timers and abort state belong to this invocation only. */
export async function handle(
  text: string,
  mode: RunnerMode,
): Promise<ExecutionResult | VerificationResult | HealthResult> {
  try {
    if (process.versions.node.split('.')[0] !== '24')
      return { status: 'failed', code: 'incompatible_runtime' };
    if (Buffer.byteLength(text) > 524288) return { status: 'failed', code: 'invalid_invocation' };
    const event: unknown = JSON.parse(text);
    const releaseDigest = await bundledRelease();
    if (event && typeof event === 'object' && 'kind' in event && event.kind === 'health') {
      if (!releaseDigest) return { status: 'failed', code: 'incompatible_runtime' };
      return { protocolVersion: 1, runtimeVersion: 'node24', releaseDigest, mode };
    }
    const verifying = (event as { kind?: string })?.kind === 'webhook';
    if ((verifying && mode === 'job') || (!verifying && mode === 'verify'))
      return { status: 'failed', code: 'invalid_invocation' };
    const invocation = verifying ? decodeVerification(text) : decodeInvocation(text);
    if (!releaseDigest || invocation.releaseDigest !== releaseDigest)
      return { status: 'failed', code: 'incompatible_runtime' };
    const duration = new Date(invocation.deadline).getTime() - Date.now();
    if (duration <= 0 || duration > (verifying ? 5000 : 300000))
      return { status: 'failed', code: 'invalid_deadline' };
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), duration);
    try {
      if (!('kind' in invocation))
        return await settle(() => execute(invocation, controller.signal), controller.signal);
      try {
        return await verifyWebhook(invocation);
      } catch {
        // Not a verification result: the launcher reports the verifier as failed.
        return {
          status: 'retry',
          code: controller.signal.aborted ? 'execution_timeout' : 'handler_failed',
        };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { status: 'failed', code: 'invalid_invocation' };
  }
}
