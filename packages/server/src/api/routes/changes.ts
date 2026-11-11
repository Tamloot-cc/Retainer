import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import { Changes } from '../../changes/service.js';
import type { Sql } from '../../db/client.js';
import { limitParam } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
export function changeRoutes(app: Hono<AppEnv>, sql: Sql) {
  const changes = new Changes(sql);
  app.get('/changes/:position', requireScope('read'), async (c) =>
    c.json(await changes.at(c.get('caller'), c.req.param('position'))),
  );
  app.get('/changes', requireScope('read'), async (c) =>
    c.json(
      await changes.list(c.get('caller'), {
        limit: limitParam(c, 100, 1000),
        ...(c.req.query('after') !== undefined ? { after: c.req.query('after') as string } : {}),
      }),
    ),
  );
}
