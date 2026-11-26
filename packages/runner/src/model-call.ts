import Anthropic from '@anthropic-ai/sdk';
import { type Invocation, RetryLater } from '@retainer/extension';
import { modelClient } from '@retainer/extension/model';
import type { z } from 'zod';
import { retryAfterSeconds } from './outcome.js';

/**
 * One structured model call through the model proxy (model calls spec 3, 6.5),
 * shared by the bundles that call a model. Each bundle owns its prompts and
 * output shapes; the proxy only checks and forwards them.
 */

/** Why a model call gave no usable answer; each is a run code suffix (spec 6.5). */
export type ModelFailure = 'unavailable' | 'refused' | 'output';
export type ModelAnswer<T> = { status: 'ok'; value: T } | { status: ModelFailure };

/** Anthropic runs a refused request again on another model in the same call (spec 6.5). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * The run's client, or null when the run has no model (the function didn't
 * declare it or the grant lacks it). `transport` lets tests route the calls.
 */
export function runModel(invocation: Invocation, transport: typeof fetch): Anthropic | null {
  if (!invocation.model) return null;
  return modelClient(invocation).withOptions({ fetch: transport });
}

/** The proxy or Anthropic refused the request as invalid: a bundle bug, never retried. */
export class ModelRequestFailed extends Error {
  constructor() {
    super('model_request_failed');
  }
}

/**
 * One structured call. The proxy's `model_unavailable`, a refusal after any
 * fallback, and output cut off at `max_tokens` or failing its schema are
 * answers; a 429 or 5xx after the SDK's own retries, or a lost connection,
 * throws RetryLater; any other refusal by the proxy or Anthropic throws
 * ModelRequestFailed.
 */
export async function askModel<T>(
  client: Anthropic | null,
  request: {
    model: string;
    system: string;
    user: string;
    schema: Record<string, unknown>;
    maxTokens: number;
  },
  parse: z.ZodType<T>,
  signal: AbortSignal,
): Promise<ModelAnswer<T>> {
  if (!client) return { status: 'unavailable' };
  let message: Anthropic.Beta.BetaMessage;
  try {
    message = await client.beta.messages.create(
      {
        model: request.model,
        max_tokens: request.maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: request.schema },
        },
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      },
      { signal },
    );
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionError)
      throw new RetryLater({ code: 'model_unavailable' });
    if (!(error instanceof Anthropic.APIError) || error.status === undefined) throw error;
    const body = error.error as { error?: { type?: unknown } } | undefined;
    if (error.status === 503 && body?.error?.type === 'model_unavailable')
      return { status: 'unavailable' };
    if (error.status === 429 || error.status >= 500)
      throw new RetryLater({
        code: error.status === 429 ? 'model_rate_limited' : 'model_unavailable',
        retryAfterSeconds: retryAfterSeconds(error.headers),
      });
    throw new ModelRequestFailed();
  }
  if (message.stop_reason === 'refusal') return { status: 'refused' };
  if (message.stop_reason !== 'end_turn') return { status: 'output' };
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  try {
    return { status: 'ok', value: parse.parse(JSON.parse(text.join(''))) };
  } catch {
    return { status: 'output' };
  }
}
