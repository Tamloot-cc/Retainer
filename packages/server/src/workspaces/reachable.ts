import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace } from '../db/tx.js';
import { readWorkspace } from '../db/workspaces.js';

export type ReachableWorkspace = {
  id: string;
  name: string;
  /** The person's role there; absent for a credential that works for nobody. */
  role?: string;
  /** Whether this connection works in it. */
  current: boolean;
};

/**
 * The workspaces the caller's connection could work in, for list_workspaces
 * (accounts spec 4.7). An app connected over OAuth works for a person, so it
 * sees every workspace that person can reach, while its consent lasts. Any
 * other credential belongs to one workspace and sees only that one.
 */
export async function reachableWorkspaces(sql: Sql, caller: Caller): Promise<ReachableWorkspace[]> {
  const check = caller.person?.check;
  if (check?.kind === 'oauth') {
    const rows = await sql<{ workspace_id: string; name: string; role: string | null }[]>`
      select workspace_id, name, role
      from retainer_token_workspaces(${check.subject}, ${check.workspace}, ${check.client})`;
    return rows.map((row) => ({
      id: row.workspace_id,
      name: row.name,
      ...(row.role ? { role: row.role } : {}),
      current: row.workspace_id === caller.workspaceId,
    }));
  }
  const workspace = await inWorkspace(sql, caller.workspaceId, (tx) =>
    readWorkspace(tx, caller.workspaceId),
  );
  return [{ id: workspace.id, name: workspace.name, current: true }];
}
