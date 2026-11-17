/** Public client IDs. The server binds each one to a workspace when it provisions it. */
export const hostedClientId = (workspaceId: string, client: 'codex' | 'claude') =>
  `retainer-${client}-${workspaceId}`;
