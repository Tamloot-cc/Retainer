import type { Hono } from 'hono';
import { requireScope } from '../../auth/middleware.js';
import type { Sql } from '../../db/client.js';
import { readBody, recordParam, zodError } from '../../http/request.js';
import type { AppEnv } from '../../http/response.js';
import { contextInputSchema } from '../../retrieval/context.js';
import { searchInputSchema } from '../../retrieval/search.js';
import { contextFor, searchFor, timelineFor } from '../../retrieval/service.js';
import { timelineInputSchema } from '../../retrieval/timeline.js';

/** Query parameters that take a list, as comma-separated values. */
const LIST_PARAMS = new Set(['types', 'fields', 'eventTypes']);

/** Keyword search, context packs and timelines (6.1), on the same services as the MCP tools. */
export function retrievalRoutes(app: Hono<AppEnv>, sql: Sql) {
  app.post('/search', requireScope('read'), async (c) => {
    const input = await readBody(c, searchInputSchema);
    return c.json(await searchFor(sql, c.get('caller'), input));
  });

  // `workspace` and `me` name workspace and personal memory (personal memory 4.4).
  app.get('/records/:id/context', requireScope('read'), async (c) => {
    const id = recordParam(c);
    const raw = c.req.query('tokenBudget');
    const parsed = contextInputSchema.safeParse(
      raw === undefined ? {} : { tokenBudget: Number(raw) },
    );
    if (!parsed.success) throw zodError(parsed.error);
    return c.json(await contextFor(sql, c.get('caller'), id, parsed.data));
  });

  app.get('/records/:id/timeline', requireScope('read'), async (c) => {
    const id = recordParam(c);
    const query: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(c.req.query())) {
      query[key] = LIST_PARAMS.has(key)
        ? value
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : key === 'limit'
          ? Number(value)
          : value;
    }
    const parsed = timelineInputSchema.safeParse(query);
    if (!parsed.success) throw zodError(parsed.error);
    return c.json(await timelineFor(sql, c.get('caller'), id, parsed.data));
  });
}
