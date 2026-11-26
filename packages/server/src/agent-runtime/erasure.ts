import type { Sql } from '../db/client.js';
import type { Tx } from '../db/tx.js';

/**
 * The one erasure of stored agent content (agent spec §5.4): chat delete,
 * the 7-day task retention and the hard workspace purge all run it. It
 * deletes the sessions' rows from every table in the `mastra` schema by
 * their real keys (threads, messages, resources, observational memory,
 * workflow snapshots, runs, run entries, run owners and run fences), through
 * `retainer_erase_agent_content`: a `security definer` function, the one
 * place Retainer's own code writes Mastra's tables. It imports no Mastra.
 *
 * Run it while the session rows still exist: they map threads and runs to
 * the workspace. `sessions` null erases the whole workspace (the purge).
 * The transaction must be scoped to the workspace (`app.workspace_id`).
 */
export async function eraseAgentContent(
  tx: Tx,
  workspaceId: string,
  sessions: readonly string[] | null,
): Promise<number> {
  const [row] = await tx<{ erased: number }[]>`
    select retainer_erase_agent_content(${workspaceId}::uuid,
      ${sessions === null ? null : [...sessions]}::uuid[]) as erased`;
  return row?.erased ?? 0;
}

/**
 * Deletes Mastra rows whose thread is no longer a session, or whose run is
 * no longer on `agent_turns` (§5.4): a step a deleted chat's turn saved after
 * the erasure. Runs from the daily sweep.
 */
export async function sweepAgentOrphans(sql: Sql | Tx): Promise<number> {
  const [row] = await sql<{ swept: number }[]>`select retainer_sweep_agent_orphans() as swept`;
  return row?.swept ?? 0;
}
