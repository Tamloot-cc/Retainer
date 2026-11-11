import type { Hono } from 'hono';
import { AppError } from '../../errors.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import {
  bindWebhookInput,
  type HookTarget,
  prepareWebhookInput,
  type Webhooks,
} from '../../webhooks/service.js';

/** Mounted outside authentication; only candidate verification can authorize a delivery. */
export function webhookIngress(app: Hono<AppEnv>, webhooks?: Webhooks) {
  const receive = async (target: HookTarget, request: Request) => {
    if (!webhooks)
      throw new AppError(503, 'webhook_unavailable', 'webhook ingress is not configured');
    return webhooks.receive(target, request);
  };
  app.post('/extensions/hooks/installations/:binding/:route', async (c) => {
    const result = await receive(
      { bindingId: c.req.param('binding'), route: c.req.param('route') },
      c.req.raw,
    );
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return result.kind === 'challenge' ? c.text(result.body) : c.json({ accepted: true }, 202);
  });
  app.post('/extensions/hooks/:registration/:route', async (c) => {
    const result = await receive(
      { registrationId: c.req.param('registration'), route: c.req.param('route') },
      c.req.raw,
    );
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return result.kind === 'challenge' ? c.text(result.body) : c.json({ accepted: true }, 202);
  });
}
export function webhookRuntime(app: Hono<AppEnv>, webhooks?: Webhooks) {
  app.post('/extensions/:id/runtime/webhooks/retire', async (c) => {
    if (!webhooks)
      throw new AppError(503, 'webhook_unavailable', 'webhook ingress is not configured');
    return c.json(
      await webhooks.retire(c.get('caller'), idParam(c), await readBody(c, prepareWebhookInput)),
    );
  });
  app.post('/extensions/:id/runtime/webhooks/prepare', async (c) => {
    if (!webhooks)
      throw new AppError(503, 'webhook_unavailable', 'webhook ingress is not configured');
    return c.json(
      await webhooks.prepare(c.get('caller'), idParam(c), await readBody(c, prepareWebhookInput)),
      201,
    );
  });
  app.post('/extensions/:id/runtime/webhooks', async (c) => {
    if (!webhooks)
      throw new AppError(503, 'webhook_unavailable', 'webhook ingress is not configured');
    return c.json(
      await webhooks.bind(c.get('caller'), idParam(c), await readBody(c, bindWebhookInput)),
      201,
    );
  });
  app.get('/extensions/:id/runtime/webhooks', async (c) => {
    if (!webhooks)
      throw new AppError(503, 'webhook_unavailable', 'webhook ingress is not configured');
    return c.json(await webhooks.list(c.get('caller'), idParam(c)));
  });
}
