import { Hono } from 'hono';
import { streamHandle } from 'hono/aws-lambda';
import { importSPKI } from 'jose';
import { z } from 'zod';
import { emptyToUndefined as empty, publicOriginSchema } from '../config.js';
import { importRunPublicKey, RunTokens } from '../extension-runtime/tokens.js';
import { LOG_LEVELS, setLogLevel } from '../log.js';
import { capturePolicySchema } from '../model/capture.js';
import { createModelProxy, type RecordUsage } from '../model/proxy.js';
import { reportTrace, reportUsage } from '../model/routes.js';
import type { RecordTrace } from '../model/trace.js';

/**
 * The hosted model proxy (model calls spec 3.6): its own Lambda function,
 * outside the database VPC, answering through a function URL with response
 * streaming. It is the only function holding Retainer's Anthropic key. It
 * admits model tokens by signature alone, with no database, and reports each
 * call's usage to the `extensions` function, which writes `ai_usage`.
 */
const modelConfigSchema = z.object({
  RETAINER_MODEL_API_KEY: z.string().min(1, 'the model function needs RETAINER_MODEL_API_KEY'),
  RETAINER_MODEL_USAGE_SECRET: z.string().min(32),
  RETAINER_EXTENSION_RUN_PUBLIC_KEY: z.string().min(1),
  RETAINER_ROUTINE_MODEL_PUBLIC_KEY: z.preprocess(empty, z.string().optional()),
  RETAINER_EXTENSION_RUN_KEY_ID: z.string().default('v1'),
  RETAINER_EXTENSION_ISSUER: z.preprocess(empty, publicOriginSchema.optional()),
  /** Usage reports go to the public API origin, through the edge like any request. */
  RETAINER_PUBLIC_ORIGIN: publicOriginSchema,
  RETAINER_MODEL_UPSTREAM_ORIGIN: z.preprocess(
    empty,
    publicOriginSchema.default('https://api.anthropic.com/'),
  ),
  RETAINER_MODEL_CAPTURE_POLICY: z.preprocess(
    empty,
    z
      .string()
      .transform((value, ctx): unknown => {
        try {
          return JSON.parse(value);
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Expected a capture policy object' });
          return z.NEVER;
        }
      })
      .pipe(capturePolicySchema)
      .optional(),
  ),
  RETAINER_MODEL_CAPTURE_WORKSPACES: z.preprocess(
    empty,
    z
      .string()
      .transform((value) => value.split(','))
      .pipe(z.array(z.uuid()))
      .optional(),
  ),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
});

/**
 * The function's app. Throws without the key, so a broken deploy shows as a
 * 5xx and runs retry; `model_unavailable` can't happen on the hosted service.
 */
export async function createModelApp(
  env: Record<string, string | undefined>,
  options: { fetch?: typeof fetch; record?: RecordUsage; trace?: RecordTrace } = {},
) {
  const parsed = modelConfigSchema.safeParse(env);
  // Never include values: they hold the key.
  if (!parsed.success)
    throw new Error(
      `invalid model function configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const config = parsed.data;
  setLogLevel(config.LOG_LEVEL);
  const tokens = new RunTokens({
    issuer: config.RETAINER_EXTENSION_ISSUER ?? config.RETAINER_PUBLIC_ORIGIN,
    keyId: config.RETAINER_EXTENSION_RUN_KEY_ID,
    verificationKey: await importRunPublicKey(config.RETAINER_EXTENSION_RUN_PUBLIC_KEY),
    ...(config.RETAINER_ROUTINE_MODEL_PUBLIC_KEY
      ? {
          routineModelVerificationKey: await importSPKI(
            config.RETAINER_ROUTINE_MODEL_PUBLIC_KEY,
            'EdDSA',
          ),
        }
      : {}),
  });
  const reporting = {
    origin: config.RETAINER_PUBLIC_ORIGIN,
    secret: config.RETAINER_MODEL_USAGE_SECRET,
  };
  const proxy = createModelProxy({
    tokens,
    apiKey: config.RETAINER_MODEL_API_KEY,
    upstream: config.RETAINER_MODEL_UPSTREAM_ORIGIN,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    record: options.record ?? reportUsage(reporting),
    trace: options.trace ?? reportTrace(reporting),
    capturePolicy: config.RETAINER_MODEL_CAPTURE_POLICY,
    captureWorkspaces: new Set(
      config.RETAINER_MODEL_CAPTURE_WORKSPACES?.map((id) => id.toLowerCase()),
    ),
  });
  const app = new Hono();
  // The function URL is the proxy's base URL: the SDK appends `/v1/messages`.
  app.all('*', (c) => proxy(c.req.raw, c.req.path));
  return app;
}

declare const awslambda: unknown;
const inLambda = typeof awslambda !== 'undefined';
/** Built at initialization, so a function without its key fails to start. */
const app = inLambda ? await createModelApp(process.env) : undefined;
/** The Lambda entry point (`dist/lambda/model.handler`), streamed through the function URL. */
export const handler: ReturnType<typeof streamHandle> | undefined = app
  ? streamHandle(app)
  : undefined;
