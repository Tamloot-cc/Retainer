import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Sql } from '../db/client.js';
import { AppError } from '../errors.js';
import { type AppEnv, errorResponse } from './response.js';

export type RateLimit = {
  /** Requests each workspace may make per window; 0 means no limit. */
  limit: number;
  /** The window's length. A minute, except in tests. */
  windowSeconds?: number;
};

/**
 * The per-workspace rate limit (accounts spec 4.8), on top of API Gateway's
 * global throttle, so one tenant's spike gets 429s while others keep
 * working. Runs after `authenticate`, which names the workspace.
 *
 * Counted in Postgres, the one dependency every install has: one row per
 * workspace in an unlogged table, incremented in a single upsert, so
 * concurrent requests from many function instances count exactly. Windows
 * are fixed, so a client can make up to twice the limit across a boundary.
 */
export function rateLimit(sql: Sql, options: RateLimit): MiddlewareHandler<AppEnv> {
  const { limit, windowSeconds = 60 } = options;
  if (limit <= 0) return (_c, next) => next();
  return createMiddleware<AppEnv>(async (c, next) => {
    const { workspaceId } = c.get('caller');
    const { count, resetIn } = await countRequest(sql, workspaceId, windowSeconds);
    if (count > limit) {
      const retryAfter = Math.max(1, resetIn);
      c.header('Retry-After', String(retryAfter));
      return errorResponse(
        c,
        new AppError(
          429,
          'rate_limited',
          `this workspace made more than ${limit} requests in ${windowSeconds} seconds; try again in ${retryAfter} seconds`,
          { limit, windowSeconds, retryAfter },
        ),
      );
    }
    await next();
  });
}

/**
 * Counts one request in the workspace's current window and returns the
 * window's count and the seconds left in it. A request whose transaction
 * started just before a boundary that another request already crossed is
 * counted in the newer window rather than resetting it.
 */
async function countRequest(
  sql: Sql,
  workspaceId: string,
  windowSeconds: number,
): Promise<{ count: number; resetIn: number }> {
  // Pipelined in one transaction: the workspace setting, then the upsert
  // that RLS confines to it.
  const [, rows] = await sql.begin((tx) => [
    tx`select set_config('app.workspace_id', ${workspaceId}, true)`,
    tx<{ count: number; reset_in: number }[]>`
      insert into workspace_request_counts as c (workspace_id, window_start, count)
      values (
        ${workspaceId},
        date_bin(make_interval(secs => ${windowSeconds}), now(), timestamptz 'epoch'),
        1
      )
      on conflict (workspace_id) do update set
        count = case when c.window_start >= excluded.window_start then c.count + 1 else 1 end,
        window_start = greatest(c.window_start, excluded.window_start)
      returning count,
        ceil(extract(epoch from
          window_start + make_interval(secs => ${windowSeconds}) - clock_timestamp()))::int
          as reset_in`,
  ]);
  const [row] = rows as unknown as { count: number; reset_in: number }[];
  if (!row) throw new Error('the request count upsert returned no row');
  return { count: row.count, resetIn: row.reset_in };
}
