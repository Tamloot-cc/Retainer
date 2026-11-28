import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { isExtensionOperation, maintenanceResponse } from '../http/maintenance.js';
import type { AppEnv } from '../http/response.js';

const uuid = '[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}';
const record = new RegExp(
  `^/v1/records/${uuid}(?:/(?:assertions|comments|events|facts|linked|context|timeline))?$`,
);
const memory = /^\/v1\/records\/(me|workspace)\/(context|timeline)$/;
const view = new RegExp(`^/v1/(?:views/${uuid}|objects/[a-z0-9_-]+/views)$`);
const dashboard = new RegExp(`^/v1/dashboards(?:/${uuid})?$`);
const recordQuery = /^\/v1\/objects\/[a-z0-9_-]+\/(query|aggregate)$/;
const mcp = new RegExp(`^/mcp(?:/w/${uuid})?$`);
const restReads = new Set([
  '/v1/me',
  '/v1/schema',
  '/v1/agent-briefing',
  '/v1/review',
  '/v1/schema/changes',
]);
const restPostReads = new Set(['/v1/search', '/v1/feed/query', '/v1/events/query']);
const event = new RegExp(`^/v1/events/${uuid}(?:/(?:content|claims))?$`);
const mcpMethods = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list']);
const mcpTools = new Set([
  'describe_schema',
  'query_records',
  'aggregate_records',
  'check_dashboard',
  'get_record',
  'search',
  'list_comments',
  'get_context',
  'get_timeline',
  'get_event_content',
]);

/** Only audited paths reach their usual auth, validation and services. */
export const admitRestrictedApi = createMiddleware<AppEnv>(async (c, next) => {
  const { method } = c.req;
  const path = new URL(c.req.url).pathname;
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/health' || path === '/app' || path.startsWith('/app/')) return next();
    if (
      restReads.has(path) ||
      record.test(path) ||
      memory.test(path) ||
      view.test(path) ||
      dashboard.test(path) ||
      event.test(path)
    )
      return next();
    // With no account server configured, the normal 404 selects key mode.
    if (path === '/account' || path === '/mcp/setup' || mcp.test(path)) return next();
    if (path.startsWith('/.well-known/oauth-protected-resource')) return next();
    return maintenanceResponse(true, isExtensionOperation(path) ? 'extensions' : 'reads');
  }
  if (method === 'POST') {
    if (restPostReads.has(path) || recordQuery.test(path)) return next();
    if (mcp.test(path) && (await restrictedMcpRequest(c.req.raw))) return next();
  }
  return maintenanceResponse(true, isExtensionOperation(path) ? 'extensions' : 'writes');
});

async function restrictedMcpRequest(request: Request): Promise<boolean> {
  const message: unknown = await request
    .clone()
    .json()
    .catch(() => undefined);
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
  if (typeof method !== 'string') return false;
  if (mcpMethods.has(method)) return true;
  return method === 'tools/call' && typeof params?.name === 'string' && mcpTools.has(params.name);
}

/** These credential paths require row locks even when called by a reader. */
export function admitRestrictedCredential(rateLimit: MiddlewareHandler<AppEnv>) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const caller = c.get('caller');
    if (caller.installation || caller.routine || caller.run)
      return maintenanceResponse(true, 'reads');
    return rateLimit(c, next);
  });
}
