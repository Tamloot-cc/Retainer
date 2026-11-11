import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import { AppError } from '../../errors.js';
import {
  commitInputSchema,
  type Extensions,
  installInputSchema,
} from '../../extensions/service.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';

export function extensionRoutes(app: Hono<AppEnv>, extensions: Extensions) {
  app.get('/extensions/catalog', requireScope('read'), (c) =>
    c.json({ releases: extensions.catalog.list() }),
  );
  app.get('/extensions', requireScope('read'), async (c) =>
    c.json(await extensions.list(c.get('caller'))),
  );
  app.get('/extensions/:id', requireScope('read'), async (c) =>
    c.json(await extensions.get(c.get('caller'), idParam(c))),
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
  for (const [action, state] of [
    ['disable', 'disabled'],
    ['uninstall', 'uninstalled'],
  ] as const) {
    app.post(`/extensions/:id/${action}`, requireScope('admin'), async (c) =>
      c.json(await extensions.transition(c.get('caller'), idParam(c), state)),
    );
  }
  app.post('/extensions/:id/enable', requireScope('admin'), async (c) => {
    await extensions.get(c.get('caller'), idParam(c));
    throw new AppError(
      409,
      'incompatible_runtime',
      'extension execution and ingestion safety are not available; installation remains disabled',
    );
  });
}
