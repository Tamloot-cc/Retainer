import type { LambdaContext, LambdaEvent } from 'hono/aws-lambda';
import { requireEdge } from './edge.js';

/** No database, auth service or application boot: usable throughout migrations. */
export const createMaintenanceHandler = (secret?: string) =>
  requireEdge(secret, async (event: LambdaEvent) => {
    const headers = event.headers ?? {};
    const navigation =
      headers['sec-fetch-mode'] === 'navigate' ||
      (headers.accept?.includes('text/html') && !headers.accept.includes('application/json'));
    const message = 'Retainer is updating. Please retry shortly, in about 5 seconds.';
    return {
      statusCode: 503,
      headers: {
        'content-type': navigation ? 'text/html; charset=utf-8' : 'application/json',
        'retry-after': '5',
        'cache-control': 'no-store',
        // This means the application was never invoked, so even a write
        // without an idempotency key can safely retry this exact response.
        'x-retainer-maintenance': 'not-executed',
      },
      body: navigation
        ? `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="5"><title>Retainer is updating</title><body><main><h1>Updating, back in a moment</h1><p>${message}</p><p>This page reloads automatically.</p></main></body></html>`
        : JSON.stringify({ error: { code: 'maintenance', message } }),
      isBase64Encoded: false,
    };
  });

export const handler = (event: LambdaEvent, context: LambdaContext) =>
  createMaintenanceHandler(process.env.RETAINER_EDGE_SECRET)(event, context);
