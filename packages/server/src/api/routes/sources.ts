import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import {
  prepareSourceSchema,
  reserveSourceBatchSchema,
  reserveSourceSchema,
  sourceBindingSchema,
  sourceEventSchema,
  sourceUnavailableSchema,
} from '../../sources/contract.js';
import type { Sources } from '../../sources/service.js';

export function sourceRoutes(app: Hono<AppEnv>, sources: Sources) {
  app.get('/extensions/:id/source', requireScope('read'), async (c) =>
    c.json(await sources.connection(c.get('caller'), idParam(c))),
  );
  app.post('/extensions/:id/source-items/batch', requireScope('write'), async (c) =>
    c.json(
      await sources.reserveBatch(
        c.get('caller'),
        idParam(c),
        await readBody(c, reserveSourceBatchSchema),
      ),
      201,
    ),
  );
  app.post('/extensions/:id/source-items/:item/prepare', requireScope('write'), async (c) =>
    c.json(
      await sources.prepare(
        c.get('caller'),
        idParam(c),
        z.uuid().parse(c.req.param('item')),
        await readBody(c, prepareSourceSchema),
      ),
    ),
  );
  app.post('/extensions/:id/source-items/:item/unavailable', requireScope('write'), async (c) =>
    c.json(
      await sources.unavailable(
        c.get('caller'),
        idParam(c),
        z.uuid().parse(c.req.param('item')),
        await readBody(c, sourceUnavailableSchema),
      ),
    ),
  );
  app.post('/extensions/:id/source/verify', requireScope('write'), async (c) =>
    c.json(
      await sources.verify(c.get('caller'), idParam(c), await readBody(c, sourceBindingSchema)),
    ),
  );
  app.post('/extensions/:id/source/disconnect', requireScope('admin'), async (c) =>
    c.json(await sources.disconnect(c.get('caller'), idParam(c))),
  );
  app.post('/extensions/:id/source-items', requireScope('write'), async (c) =>
    c.json(
      await sources.reserve(c.get('caller'), idParam(c), await readBody(c, reserveSourceSchema)),
      201,
    ),
  );
  app.get('/extensions/:id/source-items/:item', requireScope('read'), async (c) =>
    c.json(await sources.get(c.get('caller'), idParam(c), z.uuid().parse(c.req.param('item')))),
  );
  app.post('/extensions/:id/source-events', requireScope('write'), async (c) =>
    c.json(await sources.sync(c.get('caller'), idParam(c), await readBody(c, sourceEventSchema))),
  );
}
