import { pinnedWorkspaceOf } from '../auth/oauth-token.js';
import type { Sql } from '../db/client.js';

/**
 * Connections pinned to one workspace (accounts spec 4.7). Each pinned MCP
 * address, `/mcp/w/<workspace ID>`, is an OAuth resource of its own, and
 * Better Auth checks a requested resource against its `oauth_resources` row
 * and the client's link to it before anyone signs in. Retainer creates both
 * on the first authorization that names the address. Neither grants
 * anything: the person still consents, for that workspace only, and the
 * token is checked against their access on every request.
 */

export type PinnedRequest = { workspaceId: string; resource: string; clientId: string };

/** The pinned address an OAuth query asks for, if it asks for exactly one. */
export function pinnedRequest(query: URLSearchParams, publicOrigin: string): PinnedRequest | null {
  const resources = query.getAll('resource');
  const clients = query.getAll('client_id');
  if (resources.length !== 1 || clients.length !== 1 || !resources[0] || !clients[0]) return null;
  const workspaceId = pinnedWorkspaceOf(resources[0], publicOrigin);
  return workspaceId ? { workspaceId, resource: resources[0], clientId: clients[0] } : null;
}

/** The workspace a pinned OAuth query names, or undefined for the base address. */
export function pinnedWorkspaceOfQuery(query: string, publicOrigin: string): string | undefined {
  const workspaces = new URLSearchParams(query)
    .getAll('resource')
    .map((resource) => pinnedWorkspaceOf(resource, publicOrigin));
  return workspaces.find((workspace) => workspace !== undefined);
}

/**
 * Makes the pinned address a resource while its workspace exists, and links
 * the client to it. Returns false when the client is not registered yet: a
 * client met for the first time registers from its metadata document during
 * the authorization itself. Idempotent.
 */
export async function linkPinnedResource(sql: Sql, request: PinnedRequest): Promise<boolean> {
  await sql`
    insert into oauth_resources (identifier, name, created_at, updated_at)
    select ${request.resource}, 'Retainer', now(), now()
    from workspaces where id = ${request.workspaceId} and deletion_scheduled_at is null
    on conflict (identifier) do nothing`;
  const linked = await sql`
    insert into oauth_client_resources (client_id, resource_id, created_at)
    select c.client_id, r.identifier, now()
    from oauth_clients c, oauth_resources r
    where c.client_id = ${request.clientId} and c.disabled is not true
      and r.identifier = ${request.resource}
    on conflict (client_id, resource_id) do update set client_id = excluded.client_id
    returning 1`;
  return linked.length > 0;
}
