import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { stream as honoStream } from 'hono/streaming';
import { type AgentSessions, MAX_STREAM_BODY_BYTES } from '../../agent-sessions/service.js';
import { bearerToken } from '../../auth/middleware.js';
import { AppError } from '../../errors.js';
import { type AppEnv, errorResponse, toAppError } from '../../http/response.js';

/**
 * Bodies the runtime routes read, refused with 413 before they are buffered
 * or parsed: the routes sit outside `/v1`'s authentication, so the check
 * comes before any credential is looked at. A tool call carries the model's
 * input for one Retainer or extension tool; the rest carry a few fields.
 */
const TOOL_BODY_BYTES = 6 * 1024 * 1024;
const RUNTIME_BODY_BYTES = 64 * 1024;
const limitBody = (maxSize: number) =>
  bodyLimit({ maxSize, onError: (c) => c.json({ code: 'payload_too_large' }, 413) });

/** The runtime routes answer errors as `{ code, message }` (agent spec §6.1). */
function runtimeError(c: Context, error: unknown) {
  const appError = toAppError(error);
  return c.json(
    { code: appError.code, message: appError.message },
    appError.status as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
  );
}

const param = (c: Context, name: string) => c.req.param(name) ?? '';

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError(400, 'invalid_request', 'send a JSON body');
  }
}

/**
 * The routes the agent runtime calls for each turn (agent spec §6.1), outside
 * `/v1`'s authentication: a claim takes the runtime credential and the
 * client's stream token, everything else a turn token. These are the only
 * routes a turn token reaches; every other route refuses it.
 */
export function agentRuntimeRoutes(app: Hono<AppEnv>, agent: AgentSessions) {
  const base = '/v1/agent/runtime/sessions/:id';
  const run =
    (fn: (c: Context, token: string | undefined) => Promise<Response>) => async (c: Context) => {
      try {
        return await fn(c, bearerToken(c.req.header('authorization')));
      } catch (error) {
        return runtimeError(c, error);
      }
    };
  const turnToken = (token: string | undefined) => {
    if (!token) throw new AppError(401, 'unauthorized', 'send the turn token');
    return token;
  };
  const small = limitBody(RUNTIME_BODY_BYTES);
  app.post(
    `${base}/claim`,
    small,
    run(async (c, token) => c.json(await agent.claim(token, param(c, 'id'), await jsonBody(c)))),
  );
  app.post(
    `${base}/tools/:name`,
    limitBody(TOOL_BODY_BYTES),
    run(async (c, token) =>
      c.json(
        await agent.tool(turnToken(token), param(c, 'id'), param(c, 'name'), await jsonBody(c)),
      ),
    ),
  );
  app.post(
    `${base}/report`,
    small,
    run(async (c, token) =>
      c.json(await agent.report(turnToken(token), param(c, 'id'), await jsonBody(c))),
    ),
  );
  app.get(
    `${base}/turn`,
    run(async (c, token) => c.json(await agent.turn(turnToken(token), param(c, 'id')))),
  );
  app.post(
    `${base}/close`,
    small,
    run(async (c, token) =>
      c.json(await agent.close(turnToken(token), param(c, 'id'), await jsonBody(c))),
    ),
  );
}

/**
 * Self-hosted: the server forwards a chat's stream to the agent container
 * (agent spec §13), so the web app keeps one origin. Unbuffered; the stream
 * token travels as is and the container checks it at its claim. When the
 * client leaves, the upstream response is still read to its end, so the turn
 * runs to its end and is saved.
 */
/** A UI message stream error event, for a stream the agent stopped sending mid-turn. */
const LOST_UPSTREAM = `data: ${JSON.stringify({
  type: 'error',
  errorText: 'connection to the agent was lost',
})}\n\n`;

export function agentStreamForward(app: Hono<AppEnv>, upstream: string | undefined) {
  // Refused before it is buffered: this route is outside `/v1`'s authentication.
  app.post('/v1/agent/chats/:id/stream', limitBody(MAX_STREAM_BODY_BYTES), async (c) => {
    if (!upstream)
      return errorResponse(
        c,
        new AppError(503, 'agent_unavailable', 'the workspace agent is not set up on this server'),
      );
    const id = param(c, 'id');
    const target = new URL(
      `chats/${encodeURIComponent(id)}/stream`,
      `${upstream.replace(/\/$/, '')}/`,
    );
    const headers = new Headers();
    for (const name of ['authorization', 'content-type', 'accept']) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers,
        body: await c.req.arrayBuffer(),
      });
    } catch {
      return errorResponse(c, new AppError(503, 'agent_unavailable', 'the agent is not reachable'));
    }
    const body = response.body;
    const out = new Headers();
    for (const name of ['content-type', 'cache-control', 'x-vercel-ai-ui-message-stream'])
      if (response.headers.get(name)) out.set(name, response.headers.get(name) as string);
    out.set('x-accel-buffering', 'no');
    if (!body) return new Response(null, { status: response.status, headers: out });
    c.status(response.status as 200);
    for (const [name, value] of out) c.header(name, value);
    const reader = body.getReader();
    return honoStream(c, async (sink) => {
      let clientGone = false;
      sink.onAbort(() => {
        clientGone = true;
      });
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          // The agent's connection dropped mid-turn (a crash, a redeploy): end the
          // client's stream with an error event it can show, instead of failing here.
          if (!clientGone) await sink.write(LOST_UPSTREAM).catch(() => {});
          break;
        }
        if (chunk.done) break;
        if (!clientGone)
          await sink.write(chunk.value).catch(() => {
            clientGone = true;
          });
      }
    });
  });
}

/** A person's chats (agent spec §6.1): their session or the CLI login. */
export function agentChatRoutes(
  app: Hono<AppEnv>,
  agent: AgentSessions | undefined,
  publicOrigin: string | undefined,
) {
  const need = () => {
    if (!agent)
      throw new AppError(
        503,
        'agent_unavailable',
        'the workspace agent is not set up on this server',
      );
    return agent;
  };
  app.post('/agent/chats', async (c) => c.json(await need().createChat(c.get('caller')), 201));
  app.get('/agent/chats', async (c) => c.json(await need().listChats(c.get('caller'))));
  app.get('/agent/chats/:id', async (c) =>
    c.json(await need().getChat(c.get('caller'), param(c, 'id'))),
  );
  app.post('/agent/chats/:id/token', async (c) =>
    c.json(
      await need().streamToken(
        c.get('caller'),
        param(c, 'id'),
        publicOrigin ?? new URL(c.req.url).origin,
      ),
    ),
  );
  app.post('/agent/chats/:id/cancel', async (c) =>
    c.json(await need().cancel(c.get('caller'), param(c, 'id'))),
  );
  app.delete('/agent/chats/:id', async (c) => {
    await need().deleteChat(c.get('caller'), param(c, 'id'));
    return c.body(null, 204);
  });
}
