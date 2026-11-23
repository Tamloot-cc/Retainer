/**
 * MCP addresses (accounts spec 4.7). `/mcp` lets the person pick the
 * workspace when they connect; `/mcp/w/<workspace ID>` is the same server
 * pinned to one workspace, and an OAuth resource of its own. The server and
 * the consent page read pinned addresses the same way, here.
 */
export const PINNED_MCP_PATH = '/mcp/w/';

/**
 * A workspace ID as pinned addresses write it: lowercase only, since an
 * OAuth resource matches its identifier exactly.
 */
export const PINNED_WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The MCP address pinned to `workspaceId`, on `origin`'s origin. */
export const pinnedMcpAddress = (origin: string, workspaceId: string) =>
  `${new URL(origin).origin}${PINNED_MCP_PATH}${workspaceId}`;

/** A pinned address's workspace ID, or undefined for any other resource. */
export function pinnedWorkspaceOf(resource: string, origin: string): string | undefined {
  const prefix = `${new URL(origin).origin}${PINNED_MCP_PATH}`;
  if (!resource.startsWith(prefix)) return undefined;
  const id = resource.slice(prefix.length);
  return PINNED_WORKSPACE_ID.test(id) ? id : undefined;
}

/** The workspace the first pinned address among `resources` names, if any. */
export function pinnedWorkspaceOfResources(
  resources: readonly string[],
  origin: string,
): string | undefined {
  for (const resource of resources) {
    const workspace = pinnedWorkspaceOf(resource, origin);
    if (workspace) return workspace;
  }
  return undefined;
}
