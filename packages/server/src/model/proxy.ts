import { randomBytes } from 'node:crypto';
import type { ModelClaims, RunTokens } from '../extension-runtime/tokens.js';
import { allowedPath, refusedBeta, refusedBody } from './allowlist.js';
import { UsageMeter, type UsageReport } from './usage.js';

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
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Anthropic's error body, so the SDK raises its usual typed errors. */
export function anthropicError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Reads at most `limit` bytes, or undefined when the body is larger. */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
    const bearer = request.headers.get('authorization');
    const token =
      request.headers.get('x-api-key') ??
      (bearer?.startsWith('Bearer ') ? bearer.slice('Bearer '.length) : '');
    let claims: ModelClaims;
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
    const beta = refusedBeta(request.headers.get('anthropic-beta'));
    if (beta) return anthropicError(beta.status, beta.type, beta.message);
    let body: Uint8Array | undefined;
    let streamed = false;
    if (request.method === 'POST') {
      body = await readLimited(request, MAX_REQUEST_BYTES);
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
      streamed = (parsed as { stream?: unknown }).stream === true;
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
    const onClientAbort = () => abort.abort();
    request.signal.addEventListener('abort', onClientAbort, { once: true });
    const timeout = setTimeout(() => abort.abort(), options.timeoutMs ?? UPSTREAM_TIMEOUT_MS);
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
      clearTimeout(timeout);
      request.signal.removeEventListener('abort', onClientAbort);
      return anthropicError(502, 'api_error', 'the model provider could not be reached');
    }
    const outgoing = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) outgoing.set(name, value);
    }
    const metered =
      request.method === 'POST' && path === '/v1/messages' && response.ok && !!response.body;
    if (!metered || !response.body) {
      // Errors, token counts and model lists pass through unchanged; a request
      // Anthropic rejects records nothing.
      const passed = response.body;
      const done = () => {
        clearTimeout(timeout);
        request.signal.removeEventListener('abort', onClientAbort);
      };
      if (!passed) {
        done();
        return new Response(null, { status: response.status, headers: outgoing });
      }
      const reader = passed.getReader();
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done: end, value } = await reader.read();
              if (end) {
                done();
                controller.close();
              } else controller.enqueue(value);
            } catch (error) {
              done();
              controller.error(error);
            }
          },
          cancel() {
            abort.abort();
            done();
          },
        }),
        { status: response.status, headers: outgoing },
      );
    }

    const id = uuidv7();
    const meter = new UsageMeter(streamed);
    const providerRequestId = response.headers.get('request-id');
    let finished: Promise<void> | undefined;
    // Records once, before the stream to the extension closes, so a hosted
    // invocation can't end with its report still pending.
    const finish = (cut: boolean) => {
      finished ??= (async () => {
        clearTimeout(timeout);
        request.signal.removeEventListener('abort', onClientAbort);
        const report = meter.report(id, providerRequestId, cut);
        if (!report) return;
        try {
          await options.record(token, claims, report);
        } catch {
          // The recorder retries and logs on its own; the response is unaffected.
        }
      })();
      return finished;
    };
    const reader = response.body.getReader();
    const onAbortRecord = () => void finish(true);
    request.signal.addEventListener('abort', onAbortRecord, { once: true });
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (error) {
            await finish(true);
            controller.error(error);
            return;
          }
          if (chunk.done) {
            meter.end();
            await finish(false);
            controller.close();
            return;
          }
          meter.push(chunk.value);
          controller.enqueue(chunk.value);
        },
        async cancel() {
          abort.abort();
          await finish(true);
        },
      }),
      { status: response.status, headers: outgoing },
    );
  };
}
