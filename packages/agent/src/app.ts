import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { RuntimeApi, RuntimeApiError } from './api-client.js';
import { MAX_MESSAGE_CHARS, streamBodyLimit } from './limits.js';
import { errorFields, logEvent } from './logger.js';
import { runTask } from './task.js';
import { runTurn, titleFrom } from './turn.js';

export type AgentAppOptions = {
  /** Retainer's API, for the runtime routes. */
  apiOrigin: string;
  runtimeSecret: string;
  /** The `retainer_mastra` role's connection (D8). */
  mastraUrl: string;
  /** Web app origins allowed to stream from a browser, when nothing in front adds CORS (self-hosted). */
  allowedOrigins?: string[];
  /** The latest deadline this invocation allows: its remaining time less 30 s (spec §6.3). */
  notAfter?: (context: unknown) => Date | undefined;
  /** The agent function's commit, hosted only: the claim takes the writer lease for it (§10.2). */
  build?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
};

type Body = { message: { parts: [{ type: 'text'; text: string }] } };

/**
 * The request body, checked strictly (spec §6.1): one message with one text
 * part, and nothing else. History, message IDs, run IDs, resume data,
 * triggers and options are refused: history comes from Mastra's store and
 * the runtime assigns the message's ID.
 */
export function parseStreamBody(value: unknown): Body | undefined {
  const exactKeys = (object: unknown, keys: string[]) =>
    !!object &&
    typeof object === 'object' &&
    !Array.isArray(object) &&
    Object.keys(object).length === keys.length &&
    keys.every((key) => Object.hasOwn(object, key));
  if (!exactKeys(value, ['message'])) return undefined;
  const message = (value as { message: unknown }).message;
  if (!exactKeys(message, ['parts'])) return undefined;
  const parts = (message as { parts: unknown }).parts;
  if (!Array.isArray(parts) || parts.length !== 1) return undefined;
  const [part] = parts;
  if (!exactKeys(part, ['type', 'text'])) return undefined;
  const { type, text } = part as { type: unknown; text: unknown };
  if (type !== 'text' || typeof text !== 'string') return undefined;
  if (text.trim().length === 0 || text.length > MAX_MESSAGE_CHARS) return undefined;
  return value as Body;
}

function sameSecret(a: string, b: string) {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return a.length > 0 && timingSafeEqual(left, right);
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agent runtime's HTTP app: `POST /chats/:id/stream` with a stream token
 * (spec §6.1), answering with the AI SDK UI message stream over SSE. The
 * same app runs in the hosted `agent` function and the `agent` container.
 */
export function createAgentApp(options: AgentAppOptions) {
  const api = new RuntimeApi({
    origin: options.apiOrigin,
    runtimeSecret: options.runtimeSecret,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const app = new Hono();
  if (options.allowedOrigins?.length) {
    app.use(
      '/chats/*',
      cors({
        origin: options.allowedOrigins,
        allowMethods: ['POST'],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: 600,
      }),
    );
  }
  const error = (status: number, code: string) =>
    new Response(JSON.stringify({ code }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  app.get('/health', () => new Response('ok'));

  /**
   * A task job (spec §9.3, self-hosted): the dispatcher's delivery, with the
   * runtime credential. Answered at once; the task runs in the background
   * and ends with its close. Hosted, the function's native event runs it.
   */
  app.post('/tasks/:id/run', async (c) => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return error(404, 'not_found');
    const header = c.req.header('authorization') ?? '';
    const credential = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!sameSecret(credential, options.runtimeSecret)) return error(401, 'unauthorized');
    let job: unknown;
    try {
      job = ((await c.req.json()) as { job?: unknown }).job;
    } catch {
      job = undefined;
    }
    if (typeof job !== 'string' || job.length === 0 || job.length > 500)
      return error(400, 'invalid_request');
    void runTask(
      {
        api,
        mastraUrl: options.mastraUrl,
        ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
      },
      { sessionId, job, build: options.build },
    ).catch((e) => logEvent('error', 'task_failed', { sessionId, ...errorFields(e) }));
    return new Response(null, { status: 202 });
  });

  app.post('/chats/:id/stream', streamBodyLimit(), async (c) => {
    const sessionId = c.req.param('id');
    if (!SESSION_ID.test(sessionId)) return error(404, 'not_found');
    const header = c.req.header('authorization') ?? '';
    const streamToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!streamToken) return error(401, 'unauthorized');
    let body: Body | undefined;
    try {
      body = parseStreamBody(await c.req.json());
    } catch {
      body = undefined;
    }
    if (!body) return error(400, 'invalid_request');
    const text = body.message.parts[0].text;
    const title = titleFrom(text);
    const notAfter = options.notAfter?.(c.env);
    let claim: Awaited<ReturnType<RuntimeApi['claim']>>;
    try {
      claim = await api.claim(sessionId, {
        streamToken,
        title,
        ...(notAfter ? { notAfter: notAfter.toISOString() } : {}),
        ...(options.build ? { build: options.build } : {}),
      });
    } catch (e) {
      if (e instanceof RuntimeApiError && e.status < 500) return error(e.status, e.code);
      if (e instanceof RuntimeApiError && e.code === 'maintenance')
        return error(503, 'maintenance');
      logEvent('warn', 'claim_failed', { sessionId, ...errorFields(e) });
      return error(503, 'agent_unavailable');
    }
    let running: Awaited<ReturnType<typeof runTurn>>;
    try {
      running = await runTurn(
        {
          api,
          mastraUrl: options.mastraUrl,
          ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
        },
        { claim, text, title },
      );
    } catch {
      return error(503, 'agent_unavailable');
    }
    // The turn runs to its end whatever the client does (spec §6.5).
    running.done.catch(() => {});
    return new Response(running.stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-vercel-ai-ui-message-stream': 'v1',
        'x-accel-buffering': 'no',
      },
    });
  });

  return app;
}
