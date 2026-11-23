import { expect } from 'vitest';

type App = { request: (path: string, init: RequestInit) => Response | Promise<Response> };
type Route = readonly [method: string, path: string, body?: unknown];
const sample = '01900000-0000-7000-8000-000000000000';

/** The account routes and review decisions in CLI spec §9.1. */
export async function expectOtherCredentialDenied(
  accounts: App,
  api: App,
  token: string,
  workspace: string,
) {
  const w = `/account/workspaces/${workspace}`;
  const o = `/account/organizations/${sample}`;
  const routes: Route[] = [
    ['GET', '/account'],
    ['GET', o],
    ['GET', `${o}/invitations`],
    ['GET', `${w}/members`],
    ['GET', `${w}/keys`],
    ['GET', `${w}/connections`],
    ['GET', '/account/connections'],
    ['POST', '/account/cli/approvals', { workspaceId: workspace }],
    ['GET', `/account/cli/approvals/${sample}`],
    ['POST', `/account/cli/approvals/${sample}/end`],
    ['POST', `/account/cli/approvals/${sample}/decide`, { allow: true }],
    ['DELETE', '/account/cli/login'],
    ['POST', '/account/workspaces', { name: 'Test', organizationId: sample }],
    ['PATCH', w, { name: 'Test' }],
    ['DELETE', w, { name: 'Test' }],
    ['PUT', `${w}/members/${sample}`, { role: 'viewer' }],
    ['DELETE', `${w}/members/${sample}`],
    ['PATCH', `${o}/members/${sample}`, { role: 'member' }],
    ['DELETE', `${o}/members/${sample}`],
    ['POST', `${o}/invitations`, { email: 'route@example.test', role: 'owner' }],
    ['DELETE', `${o}/invitations/${sample}`],
    ['POST', `${w}/keys`, { name: 'Test', access: 'read' }],
    ['DELETE', `${w}/keys/${sample}`],
    ['DELETE', `${w}/connections/${sample}`],
    ['DELETE', `/account/connections/${sample}`],
    ['POST', `/v1/assertions/${sample}/accept`],
    ['POST', `/v1/assertions/${sample}/reject`],
    ['POST', `/v1/review/merges/${sample}/merge`, { keep: sample }],
    ['POST', `/v1/review/merges/${sample}/dismiss`],
    ['POST', `/v1/schema/changes/${sample}/approve`],
    ['POST', `/v1/schema/changes/${sample}/reject`],
    ['POST', `/v1/routines/${sample}/versions/${sample}/reject`],
    ['POST', `/v1/routines/${sample}/pause`],
    ['POST', `/v1/routines/${sample}/resume`],
    ['POST', `/v1/extensions/${sample}/disable`],
    ['POST', `/v1/extensions/${sample}/uninstall`],
  ];
  for (const [method, route, body] of routes) {
    const app = route.startsWith('/account') ? accounts : api;
    const response = await app.request(route, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const message = `${method} ${route}`;
    if (route.startsWith('/account')) expect(response.status, message).toBe(403);
    else expect([401, 403, 404], message).toContain(response.status);
  }
}
