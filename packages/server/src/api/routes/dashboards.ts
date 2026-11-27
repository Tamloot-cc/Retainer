import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import {
  createDashboard,
  createDashboardSchema,
  dashboardChatFilter,
  deleteDashboard,
  listDashboards,
  readDashboard,
  updateDashboard,
  updateDashboardSchema,
} from '../../dashboards/service.js';
import type { Sql } from '../../db/client.js';
import { idParam, readBody, zodError } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';

export function dashboardRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.get('/dashboards', requireScope('read'), async (c) => {
    const chat = dashboardChatFilter.safeParse(c.req.query('chatId'));
    if (!chat.success) throw zodError(chat.error);
    return c.json(await listDashboards(sql, c.get('caller'), chat.data));
  });
  app.post('/dashboards', requireScope('write'), async (c) =>
    c.json(
      await createDashboard(
        sql,
        c.get('caller'),
        await readBody(c, createDashboardSchema, 150_000),
      ),
      201,
    ),
  );
  app.get('/dashboards/:id', requireScope('read'), async (c) =>
    c.json(await readDashboard(sql, c.get('caller'), idParam(c))),
  );
  app.patch('/dashboards/:id', requireScope('write'), async (c) =>
    c.json(
      await updateDashboard(
        sql,
        c.get('caller'),
        idParam(c),
        await readBody(c, updateDashboardSchema, 150_000),
      ),
    ),
  );
  app.delete('/dashboards/:id', requireScope('write'), async (c) => {
    await deleteDashboard(sql, c.get('caller'), idParam(c));
    return c.body(null, 204);
  });
}
