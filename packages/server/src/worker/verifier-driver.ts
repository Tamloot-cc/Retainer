import {
  decodeVerification,
  type VerificationInvocation,
  type VerificationResult,
  verificationResultSchema,
} from '@retainer/extension';
import type { Executable } from './extensions.js';

export type VerificationDriver = {
  verify(
    executable: Executable,
    invocation: VerificationInvocation,
    signal: AbortSignal,
  ): Promise<VerificationResult>;
};

/** Dedicated credential can invoke /verify only, never launch an ordinary CRM execution. */
export class LauncherVerifier implements VerificationDriver {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly token: string,
  ) {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      token.length < 32
    )
      throw new Error('invalid verifier configuration');
    this.origin = url.origin;
  }
  async verify(
    executable: Executable,
    input: VerificationInvocation,
    signal: AbortSignal,
  ): Promise<VerificationResult> {
    const invocation = decodeVerification(JSON.stringify(input));
    if (
      invocation.functionId !== executable.functionId ||
      invocation.releaseDigest !== executable.releaseDigest
    )
      throw new Error('verifier differs from pinned executable');
    const remaining = new Date(invocation.deadline).getTime() - Date.now();
    if (remaining <= 0 || remaining > 5000) throw new Error('invalid verifier deadline');
    const response = await fetch(`${this.origin}/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bundleId: executable.driverTarget, invocation }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(remaining)]),
      redirect: 'error',
    });
    if (!response.ok || !response.body) throw new Error('verifier unavailable');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 16384) throw new Error('verifier result exceeds 16 KiB');
      chunks.push(chunk);
    }
    try {
      return verificationResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    } catch {
      throw new Error('invalid verifier result');
    }
  }
}
