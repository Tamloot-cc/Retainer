import { randomBytes } from 'node:crypto';
import { bearerToken } from '../auth/middleware.js';
import type { ModelClaims, RunTokens, VerifiedModelToken } from '../extension-runtime/tokens.js';
import { readCapped } from '../http/request.js';
import { log } from '../log.js';
import {
  allowedPath,
  MODEL_ID,
  refusedBeta,
  refusedBody,
  refusedRoutineBody,
} from './allowlist.js';
import { type CapturePolicy, captureFor } from './capture.js';
import type { ModelTrace, RecordTrace } from './trace.js';
import { providerErrorCode, UsageMeter, type UsageReport } from './usage.js';

/**
 * The model proxy (model calls spec 3.2). Extension code calls it with the
 * official Anthropic SDK and its run's model token as the key. It checks the
 * token and the request, swaps in Retainer's key, forwards the request,
 * streams the response back and records usage. It never logs a request or
 * response body.
 *
 * The same handler serves the hosted `model` function (lambda/model.ts) and
 * the self-hosted route in the server process.
 */

/** A request body may be at most 6 MB, the Lambda function URL's limit (spec 3.4.1). */
export const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
/** Covers the longest handler deadline (300 s) plus a margin. */
export const UPSTREAM_TIMEOUT_MS = 330_000;
/** Request headers forwarded besides the key; nothing else reaches Anthropic. */
const FORWARDED_REQUEST_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type'];
/** Response headers passed back: the body's type and what the SDK reads. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'request-id', 'retry-after'];
/** How much of a provider error body is read for its error type. */
const MAX_ERROR_BYTES = 8192;

/** A UUIDv7, like every primary key: the usage row's ID, made before the row exists. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type RecordUsage = (
  token: string,
  claims: ModelClaims,
  report: UsageReport,
) => Promise<void>;

export type ModelProxyOptions = {
  /** Verifies model tokens with the run public key; no database. */
  tokens: Pick<RunTokens, 'verifyModel'>;
  /** RETAINER_MODEL_API_KEY; without it every request is `503 model_unavailable`. */
  apiKey: string | undefined;
  /** Anthropic's API origin, or a fake in tests. */
  upstream: string;
  record: RecordUsage;
  trace?: RecordTrace | undefined;
  capturePolicy?: CapturePolicy | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Anthropic's error body, so the SDK raises its usual typed errors. */
export function anthropicError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export function createModelProxy(options: ModelProxyOptions) {
  const fetcher = options.fetch ?? fetch;
  const upstream = new URL(options.upstream);
  /**
   * `path` is the request's path under the proxy's base URL, such as
   * `/v1/messages`; the base URL itself differs between hosted and self-hosted.
   */
  return async function proxy(request: Request, path: string): Promise<Response> {
    if (!options.apiKey)
      return anthropicError(
        503,
        'model_unavailable',
        'model calls are not configured on this server',
      );
    // The SDK sends its key as `x-api-key` or, in newer versions, as a
    // bearer token; either carries the model token. Neither is forwarded.
    const token =
      request.headers.get('x-api-key') ?? bearerToken(request.headers.get('authorization')) ?? '';
    let claims: VerifiedModelToken;
    try {
      claims = await options.tokens.verifyModel(token);
    } catch {
      return anthropicError(
        401,
        'authentication_error',
        'model token is missing, invalid or expired',
      );
    }
    const url = new URL(request.url);
    const route = allowedPath(request.method, path, url.searchParams);
    if ('status' in route) return anthropicError(route.status, route.type, route.message);
    if (claims.kind === 'routine' && path !== '/v1/messages')
      return anthropicError(
        404,
        'not_found_error',
        `${request.method} ${path} is not available with a routine's model token`,
      );
    const beta = refusedBeta(request.headers.get('anthropic-beta'));
    if (beta) return anthropicError(beta.status, beta.type, beta.message);
    let body: Uint8Array | undefined;
    let streamed = false;
    let requestedModel: string | null = null;
    let captureCandidate: unknown;
    if (request.method === 'POST') {
      const declared = Number(request.headers.get('content-length'));
      body =
        Number.isFinite(declared) && declared > MAX_REQUEST_BYTES
          ? undefined
          : await readCapped(request.body, MAX_REQUEST_BYTES);
      if (!body)
        return anthropicError(413, 'request_too_large', 'the request body is larger than 6 MB');
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return anthropicError(400, 'invalid_request_error', 'the request body must be JSON');
      }
      const refused = refusedBody(parsed);
      if (refused) return anthropicError(refused.status, refused.type, refused.message);
      const narrowed = claims.kind === 'routine' ? refusedRoutineBody(parsed, claims) : undefined;
      if (narrowed) return anthropicError(narrowed.status, narrowed.type, narrowed.message);
      const message = parsed as { stream?: unknown; model?: unknown };
      streamed = message.stream === true;
      if (options.capturePolicy && path === '/v1/messages') captureCandidate = parsed;
      if (typeof message.model === 'string' && MODEL_ID.test(message.model))
        requestedModel = message.model;
    }

    const headers = new Headers({ 'x-api-key': options.apiKey });
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const target = new URL(path, upstream);
    target.search = url.search;
    // Aborted when the extension goes away, so generation stops being billed.
    const abort = new AbortController();
    // Never past the token's expiry, which is at or before the run's deadline:
    // after it the run is over and nothing is waiting for the answer.
    const timeout = setTimeout(
      () => abort.abort(),
      Math.max(
        0,
        Math.min(options.timeoutMs ?? UPSTREAM_TIMEOUT_MS, claims.expiresAt * 1000 - Date.now()),
      ),
    );
    const metered = request.method === 'POST' && path === '/v1/messages';
    if (request.signal.aborted) {
      clearTimeout(timeout);
      return anthropicError(502, 'api_error', 'the model request was cancelled');
    }
    const started = Date.now();
    const monotonicStart = performance.now();
    const call: Extract<ModelTrace, { outcome: 'started' }> = {
      id: uuidv7(started),
      type: 'model_call',
      outcome: 'started',
      requestedModel,
      startedAt: new Date(started).toISOString(),
    };
    // Both recorders retry and log what they lose; the response is unaffected.
    const trace = async (report: ModelTrace) => {
      try {
        await options.trace?.(token, claims, report);
      } catch {}
    };
    const startReport = metered ? trace(call) : undefined;
    const capture = metered
      ? captureFor(options.capturePolicy, claims, started, body, captureCandidate)
      : undefined;
    let meter: UsageMeter | undefined;
    let providerRequestId: string | null = null;
    let httpStatus: number | null = null;
    let providerError: string | undefined;
    let finished: Promise<void> | undefined;
    const finish = (
      outcome: Exclude<ModelTrace['outcome'], 'started'>,
      code: string | null = null,
      partialBody = false,
    ) => {
      finished ??= (async () => {
        clearTimeout(timeout);
        request.signal.removeEventListener('abort', onClientAbort);
        if (!metered) return;
        const usage = meter?.report(
          call.id,
          providerRequestId,
          outcome !== 'completed',
          call.startedAt,
        );
        const finishedAt = Date.now();
        const payload = capture?.finish(partialBody, finishedAt);
        await Promise.all([
          startReport,
          trace({
            ...call,
            outcome,
            code,
            finishedAt: new Date(finishedAt).toISOString(),
            ...(payload ? { payload } : {}),
            durationMs: Math.round(performance.now() - monotonicStart),
            returnedModel: usage?.model ?? null,
            providerRequestId,
            httpStatus,
          }),
          usage ? options.record(token, claims, usage).catch(() => {}) : undefined,
        ]);
      })();
      return finished;
    };
    /** The body stopped early: a provider error keeps its status as the code. */
    const interrupted = (code: string) =>
      finish(providerError ? 'provider_error' : 'stream_interrupted', providerError ?? code, true);
    const onClientAbort = () => {
      abort.abort();
      void (httpStatus === null
        ? finish('transport_error', 'client_disconnected', true)
        : interrupted('client_disconnected'));
    };
    request.signal.addEventListener('abort', onClientAbort, { once: true });
    let response: Response;
    try {
      response = await fetcher(target, {
        method: request.method,
        headers,
        ...(body ? { body } : {}),
        signal: abort.signal,
        redirect: 'error',
      });
    } catch {
      await finish(
        'transport_error',
        abort.signal.aborted ? 'request_aborted' : 'fetch_failed',
        true,
      );
      return anthropicError(502, 'api_error', 'the model provider could not be reached');
    }
    httpStatus = response.status;
    providerRequestId = response.headers.get('request-id')?.slice(0, 200) ?? null;
    providerError = response.ok ? undefined : `http_${response.status}`;
    // Set here, not by the mount: a handler returning this Response drops
    // headers set on Hono's context.
    const outgoing = new Headers({ 'cache-control': 'no-store' });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) outgoing.set(name, value);
    }
    if (!response.body) {
      if (providerError) await finish('provider_error', providerError);
      // A stream that never started has no `message_stop` either.
      else if (streamed) await finish('stream_interrupted', 'stream_incomplete', true);
      else await finish('completed');
      return new Response(null, { status: response.status, headers: outgoing });
    }
    if (metered && response.ok) meter = new UsageMeter(streamed);
    const reader = response.body.getReader();
    const errorChunks: Uint8Array[] = [];
    let errorBytes = 0;
    const errorCode = () => {
      if (!providerError || errorBytes > MAX_ERROR_BYTES) return providerError;
      try {
        return (
          providerErrorCode(JSON.parse(Buffer.concat(errorChunks).toString('utf8'))) ??
          providerError
        );
      } catch {
        return providerError;
      }
    };
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (error) {
            await interrupted('body_read_failed');
            controller.error(error);
            return;
          }
          if (chunk.done) {
            meter?.end();
            if (providerError || meter?.providerError)
              await finish('provider_error', meter?.providerError ?? errorCode());
            else if (streamed && !meter?.messageComplete)
              await finish('stream_interrupted', 'stream_incomplete', true);
            else await finish('completed');
            controller.close();
            return;
          }
          capture?.push(chunk.value);
          if (providerError && errorBytes <= MAX_ERROR_BYTES) {
            errorBytes += chunk.value.byteLength;
            if (errorBytes <= MAX_ERROR_BYTES) errorChunks.push(chunk.value);
          }
          meter?.push(chunk.value);
          controller.enqueue(chunk.value);
        },
        async cancel() {
          abort.abort();
          await interrupted('client_disconnected');
        },
      }),
      { status: response.status, headers: outgoing },
    );
  };
}
