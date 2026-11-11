import { executionResultSchema, type Invocation } from '@retainer/extension';
import type { Executable, ExecutionDriver } from './extensions.js';

/** Talks only to a trusted configured launcher; target selection stays outside invocation JSON. */
export class LauncherDriver implements ExecutionDriver {
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
      throw new Error('invalid launcher configuration');
    this.origin = url.origin;
  }
  async invoke(executable: Executable, invocation: Invocation, signal: AbortSignal) {
    const response = await fetch(`${this.origin}/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bundleId: executable.driverTarget, invocation }),
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('launcher unavailable');
    if (!response.body) throw new Error('launcher returned no result');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 65536) throw new Error('launcher result exceeds 64 KiB');
      chunks.push(chunk);
    }
    try {
      return executionResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    } catch {
      throw new Error('invalid launcher result');
    }
  }
}
