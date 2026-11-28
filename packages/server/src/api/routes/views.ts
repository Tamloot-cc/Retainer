import type { Hono } from 'hono';
import { z } from 'zod';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { idParam, readBody } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import {
  checkView,
  createView,
  createViewSchema,
  deleteView,
  listViews,
  readView,
  updateView,
  updateViewSchema,
} from '../../views/service.js';

/** Saved views of an object's records (ARCHITECTURE.md 1.4). */
export function viewRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.get('/objects/:object/views', requireScope('read'), async (c) =>
    c.json(await listViews(sql, c.get('caller'), c.req.param('object'))),
  );

  app.post('/views/check', requireScope('read'), async (c) =>
    c.json(await checkView(sql, c.get('caller'), await readBody(c, z.unknown()))),
  );
  app.post('/objects/:object/views/check', requireScope('read'), async (c) =>
    c.json(
      await checkView(sql, c.get('caller'), await readBody(c, z.unknown()), c.req.param('object')),
    ),
  );

  app.post('/objects/:object/views', requireScope('write'), async (c) => {
    const input = await readBody(c, createViewSchema);
    return c.json(await createView(sql, c.get('caller'), c.req.param('object'), input), 201);
  });

  app.get('/views/:id', requireScope('read'), async (c) =>
    c.json(await readView(sql, c.get('caller'), idParam(c))),
  );

  app.patch('/views/:id', requireScope('write'), async (c) => {
    const id = idParam(c);
    const input = await readBody(c, updateViewSchema);
    return c.json(await updateView(sql, c.get('caller'), id, input));
  });

  app.delete('/views/:id', requireScope('write'), async (c) =>
    c.json(await deleteView(sql, c.get('caller'), idParam(c))),
  );
}
