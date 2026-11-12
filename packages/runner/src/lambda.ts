import { handle } from './handle.js';

/** Same code in both functions; the operator's function configuration fixes the role. */
export async function handler(event: unknown) {
  const mode = process.env.RETAINER_RUNNER_MODE;
  if (mode !== 'job' && mode !== 'verify') return { status: 'failed', code: 'invalid_invocation' };
  try {
    return await handle(JSON.stringify(event), mode);
  } catch {
    // Never log an event or an exception that could contain credentials or raw webhook bytes.
    return { status: 'failed', code: 'invalid_invocation' };
  }
}
