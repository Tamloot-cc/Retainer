import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import { bearerToken } from '../auth/middleware.js';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import { MODEL_PROXY_PATH, type ModelClaims, type RunTokens } from '../extension-runtime/tokens.js';
import { type AppEnv, errorResponse } from '../http/response.js';
import { log } from '../log.js';
import type { RecordUsage } from './proxy.js';
import { recordUsage, type UsageReport, usageReportSchema } from './usage.js';

export { MODEL_PROXY_PATH };
/** Where the hosted `model` function reports usage to the `extensions` function. */
export const USAGE_REPORT_PATH = '/v1/extensions/internal/ai-usage';
/** A report may follow a response that outlasted its token by this much. */
export const USAGE_TOKEN_GRACE_SECONDS = 15 * 60;

/**
 * Mounts the proxy under `prefix`. Register it before the `/v1` caller chain:
 * a model token is no workspace credential, and the proxy checks it itself.
 */
export function modelProxyRoute(
  app: Hono<AppEnv>,
  proxy: (request: Request, path: string) => Promise<Response>,
  prefix = MODEL_PROXY_PATH,
) {
  app.all(`${prefix}/*`, (c) => proxy(c.req.raw, c.req.path.slice(prefix.length)));
}

/** What a lost report logs: its ID and counts, never content or the token. */
const logLost = (report: UsageReport) =>
  log.error(
    `Model usage report ${report.id} failed: model ${report.model}, input ${report.inputTokens}, output ${report.outputTokens}, cache read ${report.cacheReadTokens}, cache write ${report.cacheWriteTokens}, partial ${report.partial}.`,
  );
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The self-hosted proxy writes `ai_usage` directly: three tries with backoff,
 * since the insert ignores a repeated ID, then it logs like `reportUsage`.
 */
export const recordDirectly =
  (sql: Sql, backoffMs = 250): RecordUsage =>
  async (_token, claims, report) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await recordUsage(sql, claims, report);
        return;
      } catch {
        if (attempt < 3) await pause(backoffMs * 4 ** (attempt - 1));
      }
    }
    logLost(report);
  };

const sameSecret = (sent: string, secret: string) => {
  const a = Buffer.from(sent);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The hosted `model` function's usage report (spec 3.6). It needs both the
 * secret, which shows the proxy sent it, and the model token the request
 * carried, whose claims say whose use it was: neither is enough alone. Mounted
 * outside the `/v1` caller chain, like webhook ingress.
 */
export function usageReportRoute(
  app: Hono<AppEnv>,
  deps: { sql: Sql; tokens: Pick<RunTokens, 'verifyModel'>; secret: string },
) {
  app.post(USAGE_REPORT_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!sameSecret(bearerToken(c.req.header('authorization')) ?? '', deps.secret))
      return errorResponse(c, new AppError(401, 'unauthorized', 'usage report is not authorized'));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return errorResponse(c, new AppError(400, 'invalid_request', 'usage report must be JSON'));
    }
    const parsed = usageReportSchema.extend({ token: z.string().min(1).max(8192) }).safeParse(body);
    if (!parsed.success)
      return errorResponse(c, new AppError(400, 'invalid_request', 'invalid usage report'));
    const { token, ...report } = parsed.data;
    let claims: ModelClaims;
    try {
      claims = await deps.tokens.verifyModel(token, USAGE_TOKEN_GRACE_SECONDS);
    } catch {
      return errorResponse(
        c,
        new AppError(401, 'unauthorized', 'usage report needs a valid model token'),
      );
    }
    await recordUsage(deps.sql, claims, report);
    return c.json({ recorded: true });
  });
}

/**
 * The hosted `model` function's recorder: posts each report to the public API
 * origin, so it passes the edge like any other request. Three tries with
 * backoff before the invocation ends; after that it logs the ID and counts (no
 * content), and that call goes uncounted.
 */
export function reportUsage(options: {
  origin: string;
  secret: string;
  fetch?: typeof fetch;
  backoffMs?: number;
}): RecordUsage {
  const fetcher = options.fetch ?? fetch;
  const url = new URL(USAGE_REPORT_PATH, options.origin);
  const backoff = options.backoffMs ?? 250;
  return async (token: string, _claims, report: UsageReport) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ...report, token }),
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        await response.body?.cancel().catch(() => {});
        if (response.ok) return;
        // A refused report won't succeed on a retry.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
      } catch {
        // Network failure: retried.
      }
      if (attempt < 3) await pause(backoff * 4 ** (attempt - 1));
    }
    logLost(report);
  };
}
