import {
  createAgentApp,
  loadAgentRuntimeConfig,
  quietMastra,
  RuntimeApi,
  runTask,
} from '@retainer/agent/runtime';
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

const inLambda = typeof awslambda !== 'undefined';

function createApp() {
  if (!config) throw new Error('no agent runtime configuration');
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

type LambdaContext = { getRemainingTimeInMillis(): number };
type ResponseStream = { end(): void };
declare const awslambda: {
  streamifyResponse(
    handler: (event: unknown, stream: ResponseStream, context: LambdaContext) => Promise<void>,
  ): unknown;
};

/** A task job's native event, sent by the dispatcher's asynchronous invoke (spec §9.3). */
function taskEvent(event: unknown): { sessionId: string; job: string } | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const { kind, sessionId, job } = event as Record<string, unknown>;
  if (kind !== 'agent-task' || typeof sessionId !== 'string' || typeof job !== 'string')
    return undefined;
  return { sessionId, job };
}

/** Built at initialization, so a function missing its configuration fails to start. */
const config = inLambda ? (quietMastra(), loadAgentRuntimeConfig()) : undefined;
const app = config ? createApp() : undefined;
const stream = app ? streamHandle(app) : undefined;

/**
 * The Lambda entry point (`dist/lambda/agent.handler`): a chat's stream
 * through the function URL, or a task job's native event, which runs to its
 * close within this invocation.
 */
export const handler =
  inLambda && config && stream
    ? awslambda.streamifyResponse(async (event, responseStream, context) => {
        const task = taskEvent(event);
        if (!task)
          return (stream as never as (...args: unknown[]) => Promise<void>)(
            event,
            responseStream,
            context,
          );
        try {
          await runTask(
            {
              api: new RuntimeApi({
                origin: config.apiOrigin,
                runtimeSecret: config.runtimeSecret,
              }),
              mastraUrl: config.mastraUrl,
            },
            {
              ...task,
              notAfter: new Date(Date.now() + context.getRemainingTimeInMillis() - FINAL_WRITES_MS),
              build: HOSTED_WRITER_BUILD || undefined,
            },
          );
        } finally {
          responseStream.end();
        }
      })
    : undefined;
