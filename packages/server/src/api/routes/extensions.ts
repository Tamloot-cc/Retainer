import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import { AppError } from '../../errors.js';
import {
  commitInputSchema,
  type Extensions,
  installInputSchema,
} from '../../extensions/service.js';
import { idParam, limitParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';

export function extensionRoutes(app: Hono<AppEnv>, extensions: Extensions) {
  app.post('/extensions/secrets', requireScope('admin'), async (c) =>
    c.json(
      await extensions.stageSecret(
        c.get('caller'),
        await readBody(
          c,
          z.strictObject({
            registrationId: z.uuid(),
            version: z.string(),
            installationId: z.uuid().optional(),
            name: z.string().min(1).max(100),
            value: z.string().min(1).max(65536),
          }),
        ),
      ),
      201,
    ),
  );
  app.get('/extensions/catalog', requireScope('read'), (c) =>
    c.json({ releases: extensions.catalog.list() }),
  );
  app.get('/extensions', requireScope('read'), async (c) =>
    c.json(await extensions.list(c.get('caller'))),
  );
  app.get('/extensions/:id', requireScope('read'), async (c) =>
    c.json(await extensions.get(c.get('caller'), idParam(c))),
  );
  app.get('/extensions/:id/runs', requireScope('read'), async (c) =>
    c.json(
      await extensions.runs(
        c.get('caller'),
        idParam(c),
        limitParam(c, 50, 100),
        c.req.query('cursor'),
      ),
    ),
  );
  app.post('/extensions/preview', requireScope('schema:write'), async (c) =>
    c.json(await extensions.preview(c.get('caller'), await readBody(c, installInputSchema))),
  );
  app.post('/extensions', requireScope('admin'), async (c) =>
    c.json(
      await extensions.install(
        c.get('caller'),
        await readBody(c, commitInputSchema),
        c.req.header('Idempotency-Key') ?? '',
      ),
      201,
    ),
  );
  app.post('/extensions/:id/upgrade', requireScope('admin'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, commitInputSchema);
    if (input.installationId && input.installationId !== id)
      throw new AppError(404, 'not_found', 'extension installation not found');
    return c.json(
      await extensions.install(
        c.get('caller'),
        { ...input, installationId: id },
        c.req.header('Idempotency-Key') ?? '',
      ),
    );
  });
  app.post('/extensions/:id/reconnect', requireScope('admin'), async (c) => {
    const id = idParam(c),
      input = await readBody(c, commitInputSchema);
    if (!input.reconnect || input.installationId !== id)
      throw new AppError(
        400,
        'invalid_request',
        'review a reconnect plan for this installation first',
      );
    return c.json(
      await extensions.install(c.get('caller'), input, c.req.header('Idempotency-Key') ?? ''),
    );
  });
  app.patch('/extensions/:id/settings', requireScope('admin'), async (c) =>
    c.json(
      await extensions.updateSettings(
        c.get('caller'),
        idParam(c),
        await readBody(
          c,
          z.strictObject({
            expectedRevision: z.number().int().positive(),
            settings: installInputSchema.shape.settings,
          }),
        ),
      ),
    ),
  );
  for (const [action, state] of [
    ['disable', 'disabled'],
    ['uninstall', 'uninstalled'],
  ] as const) {
    app.post(`/extensions/:id/${action}`, requireScope('admin'), async (c) =>
      c.json(await extensions.transition(c.get('caller'), idParam(c), state)),
    );
  }
  app.post('/extensions/:id/enable', requireScope('admin'), async (c) =>
    c.json(await extensions.enable(c.get('caller'), idParam(c))),
  );
}
