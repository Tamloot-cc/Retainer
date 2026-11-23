import { pinnedWorkspaceOf } from '@retainer/shared';
import type { Sql } from '../db/client.js';

/**
 * Connections pinned to one workspace (accounts spec 4.7). Each pinned MCP
 * address, `/mcp/w/<workspace ID>`, is an OAuth resource of its own, and
 * Better Auth checks a requested resource against its `oauth_resources` row
 * and the client's link to it before anyone signs in. Retainer creates both
 * when an authorization names the address: the authorize route for clients
 * it knows, and the client metadata document hook for one registering during
 * that request. Neither grants anything: the person still consents, for that
 * workspace only, and the token is checked against their access on every
 * request.
 */

export type PinnedRequest = { workspaceId: string; resource: string; clientId: string };

/** The pinned address an authorization asks for, if it asks for exactly that one. */
export function pinnedRequest(
  resources: readonly string[],
  clientId: string | undefined,
  publicOrigin: string,
): PinnedRequest | null {
  const [resource] = resources;
  if (resources.length !== 1 || !resource || !clientId) return null;
  const workspaceId = pinnedWorkspaceOf(resource, publicOrigin);
  return workspaceId ? { workspaceId, resource, clientId } : null;
}

/**
 * Makes the pinned address a resource while its workspace exists, and links
 * the client to it if the client is registered. Idempotent.
 */
export async function linkPinnedResource(sql: Sql, request: PinnedRequest): Promise<void> {
  await sql`
    insert into oauth_resources (identifier, name, created_at, updated_at)
    select ${request.resource}, 'Retainer', now(), now()
    from workspaces where id = ${request.workspaceId} and deletion_scheduled_at is null
    on conflict (identifier) do nothing`;
  // A separate statement, so it sees the resource the one above created.
  await sql`
    insert into oauth_client_resources (client_id, resource_id, created_at)
    select c.client_id, r.identifier, now()
    from oauth_clients c, oauth_resources r
    where c.client_id = ${request.clientId} and c.disabled is not true
      and r.identifier = ${request.resource}
    on conflict (client_id, resource_id) do nothing`;
}
