import { eraseAgentContent, sweepAgentOrphans } from '../agent-runtime/erasure.js';
import { timeOutTurns } from '../agent-runtime/turns.js';
import type { Sql } from '../db/client.js';
import { inWorkspace } from '../db/tx.js';

/** A task's stored content is kept 7 days after it was last active (agent spec §5.4). */
const TASK_RETENTION = '7 days';
/** The orphan sweep is daily (§5.4); a process runs it at most this often. */
const ORPHAN_SWEEP_MS = 24 * 60 * 60_000;
let lastOrphanSweep = 0;

/**
 * The agent's upkeep (agent spec §5.4, §6.3), in the maintenance tick beside
 * routine retention: turns whose runtime vanished are closed as `timed_out`,
 * expired stream tokens go, a task's content is erased 7 days on, and once a
 * day Mastra rows that belong to no session or turn are swept. `sql` is the
 * runtime role; `discovery` the executor role, which finds due workspaces.
 */
export async function maintainAgents(sql: Sql, discovery: Sql, deadline: number) {
  const due = await discovery<{ workspace_id: string }[]>`
    select * from retainer_agent_maintenance_due(100)`;
  for (const { workspace_id: workspace } of due) {
    if (Date.now() >= deadline) return;
    await inWorkspace(sql, workspace, async (tx) => {
      await timeOutTurns(tx);
      await tx`delete from agent_stream_tokens where expires_at <= clock_timestamp()`;
      const expired = await tx<{ id: string }[]>`
        select s.id from agent_sessions s
        where s.kind = 'task' and s.last_active_at <= now() - ${TASK_RETENTION}::interval
          and not exists (select 1 from agent_turns t where t.session_id = s.id and t.status = 'running')
        limit 100`;
      const ids = expired.map((row) => row.id);
      if (ids.length > 0) {
        await eraseAgentContent(tx, workspace, ids);
        await tx`delete from agent_sessions where id = any(${tx.array(ids)}::uuid[])`;
      }
    });
  }
  if (Date.now() - lastOrphanSweep >= ORPHAN_SWEEP_MS && Date.now() < deadline) {
    lastOrphanSweep = Date.now();
    await sweepAgentOrphans(sql);
  }
}
