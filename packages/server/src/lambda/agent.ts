import { createAgentApp, loadAgentRuntimeConfig, quietMastra } from '@retainer/agent/runtime';
import { streamHandle } from 'hono/aws-lambda';
import { HOSTED_WRITER_BUILD } from '../db/writer-build.js';

/**
 * The hosted agent runtime (docs/specs/agent.md §13, D6, D8): its own
 * function, streaming the chat through its function URL. It holds the
 * `retainer_mastra` role's connection, the Anthropic key and the runtime
 * credential, and reaches Retainer's data only through the API.
 */

/** A claim's deadline leaves the invocation 30 s for its final writes (spec §6.3). */
const FINAL_WRITES_MS = 30_000;

type LambdaEnv = { lambdaContext?: { getRemainingTimeInMillis?: () => number } };

declare const awslambda: unknown;
const inLambda = typeof awslambda !== 'undefined';

function createApp() {
  quietMastra();
  const config = loadAgentRuntimeConfig();
  return createAgentApp({
    apiOrigin: config.apiOrigin,
    runtimeSecret: config.runtimeSecret,
    mastraUrl: config.mastraUrl,
    allowedOrigins: config.allowedOrigins,
    ...(HOSTED_WRITER_BUILD ? { build: HOSTED_WRITER_BUILD } : {}),
    notAfter: (env) => {
      const remaining = (env as LambdaEnv | undefined)?.lambdaContext?.getRemainingTimeInMillis?.();
      return remaining === undefined
        ? undefined
        : new Date(Date.now() + remaining - FINAL_WRITES_MS);
    },
  });
}

/** Built at initialization, so a function missing its configuration fails to start. */
const app = inLambda ? createApp() : undefined;
/** The Lambda entry point (`dist/lambda/agent.handler`), streamed through the function URL. */
export const handler: ReturnType<typeof streamHandle> | undefined = app
  ? streamHandle(app)
  : undefined;
