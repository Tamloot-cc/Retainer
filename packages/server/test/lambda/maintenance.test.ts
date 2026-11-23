import { expect, it } from 'vitest';
import { createMaintenanceHandler } from '../../src/lambda/maintenance.js';
import { context, httpEvent } from '../helpers/lambda.js';

it('gives API and MCP callers a retryable error without booting the app', async () => {
  for (const path of ['/v1/records', '/mcp', '/account']) {
    const response = await createMaintenanceHandler()(httpEvent('POST', path), context);
    expect(response.statusCode).toBe(503);
    expect(response.headers).toMatchObject({
      'retry-after': '5',
      'cache-control': 'no-store',
      'x-retainer-maintenance': 'not-executed',
    });
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'maintenance' } });
  }
});
it('serves self-refreshing HTML for browser navigation and enforces the edge secret', async () => {
  const handler = createMaintenanceHandler('secret');
  expect((await handler(httpEvent('GET', '/app'), context)).statusCode).toBe(403);
  const response = await handler(
    httpEvent('GET', '/app', {
      headers: { 'x-retainer-edge-secret': 'secret', accept: 'text/html' },
    }),
    context,
  );
  expect(response.statusCode).toBe(503);
  expect(response.body).toContain('http-equiv="refresh"');
  expect(response.body).toContain('Retainer is updating');
  expect(response.body).toContain('a few minutes');
  expect(response.body).not.toContain('5 seconds');
});

it.each([
  ['GET', '/v1/extensions/links'],
  ['POST', '/extensions/hooks/test-registration/receive'],
  ['POST', '/extensions/hooks/installations/test-binding/receive'],
])('identifies paused extension traffic for %s %s', async (method, path) => {
  const result = await createMaintenanceHandler()(httpEvent(method, path), context);
  expect(result.statusCode).toBe(503);
  expect(result.headers).toMatchObject({
    'x-retainer-maintenance': 'not-executed',
    'x-retainer-paused-operation': 'extensions',
  });
});
