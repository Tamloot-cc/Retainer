import Anthropic from '@anthropic-ai/sdk';
import type { Invocation } from './protocol.js';

/**
 * An Anthropic client for a run's model calls (model calls spec 3.2). It talks
 * to Retainer's model proxy with the run's model token, never to Anthropic with
 * a key: the proxy swaps in Retainer's key and records usage. Bundles never
 * write the proxy's URL, so what sits behind it can change without a release.
 *
 * Its timeout is the time left until the run's deadline (the SDK's default is
 * ten minutes, far past any run); retries stay at the SDK's default of two.
 * Throws when the invocation has no `model`: the function didn't declare
 * `uses: ['model']`, or the installation's grant doesn't include it.
 */
export function modelClient(
  invocation: Pick<Invocation, 'model' | 'deadline'>,
  now: () => number = Date.now,
): Anthropic {
  const model = invocation.model;
  if (!model)
    throw new Error(
      "model calls are unavailable: the function must declare uses: ['model'] and the installation's grant must include it",
    );
  return new Anthropic({
    baseURL: model.origin,
    apiKey: model.token,
    // The SDK would otherwise read ANTHROPIC_AUTH_TOKEN and send it as well.
    authToken: null,
    timeout: Math.max(1, Date.parse(invocation.deadline) - now()),
  });
}
