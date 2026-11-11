import { retainedFloor } from '../db/change-cursor.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockPrivacyShared, lockSchemaShared } from '../db/tx.js';
import { lockExtension, lockQueue } from '../extension-runtime/locks.js';
import type { ExtensionQueue } from '../extension-runtime/queue.js';

/** Durable cursors are in Postgres; the rotation hint merely keeps a full queue from starving peers. */
export class ChangeMaintenance {
  private stopped = false;
  private after: string | null = null;
  private pruneAfter = 0;
  stop() {
    this.stopped = true;
  }
  constructor(
    private readonly sql: Sql,
    private readonly discovery: Sql,
    private readonly queue?: ExtensionQueue,
  ) {}
  async tick(options: { budgetMs?: number } = {}) {
    const budget = options.budgetMs ?? 240000;
    if (!Number.isInteger(budget) || budget < 1 || budget > 240000)
      throw new Error('invalid change maintenance budget');
    const deadline = Date.now() + budget;
    let queued = 0,
      blocked = 0,
      pruned = 0,
      failed = 0;
    if (this.stopped) return { queued, blocked, pruned, failed };
    const due = this.queue
      ? await this.discovery<
          { workspace_id: string; installation_id: string }[]
        >`select * from retainer_extension_changes_due(${this.after}::uuid,1000)`
      : [];
    for (const item of due) {
      if (this.stopped || Date.now() >= deadline) break;
      this.after = item.installation_id;
      try {
        const result = await this.queue?.dispatchChanges(item.workspace_id, item.installation_id);
        queued += result?.queued ?? 0;
        blocked += result?.blocked ?? 0;
      } catch {
        failed++;
      }
    }
    if (this.stopped || Date.now() >= deadline || Date.now() < this.pruneAfter)
      return { queued, blocked, pruned, failed };
    this.pruneAfter = Date.now() + 60000;
    const expired = await this.discovery<
      { workspace_id: string }[]
    >`select * from retainer_change_retention_due(1000)`;
    for (const { workspace_id: workspace } of expired) {
      if (this.stopped || Date.now() >= deadline) break;
      try {
        pruned += await inWorkspace(this.sql, workspace, async (tx) => {
          await lockPrivacyShared(tx, workspace);
          await lockSchemaShared(tx, workspace);
          const installations = await tx<
            { id: string; registration_id: string }[]
          >`select id,registration_id from extension_installations order by registration_id,id`;
          for (const installation of installations) {
            await lockExtension(tx, workspace, installation.registration_id, true);
            await lockQueue(tx, workspace, installation.id);
          }
          const expired = await tx<
            { installation_id: string; generation: number }[]
          >`update extension_jobs set status='failed',code='job_expired',lease_owner=null,lease_until=null,run_until=null,updated_at=clock_timestamp()
              where id in(select id from extension_jobs where expires_at<=clock_timestamp() and (status='queued' or status='running' and lease_until<=clock_timestamp())
                order by expires_at,id limit 1000 for update skip locked) returning installation_id,generation`;
          for (const job of expired)
            await tx`update extension_installations set connection_health='degraded',last_error='job_expired'
              where id=${job.installation_id} and generation=${job.generation} and state='active'`;
          const jobs =
            await tx`delete from extension_jobs where id in(select id from extension_jobs where status in ('succeeded','failed','cancelled')
              and updated_at<clock_timestamp()-interval '30 days' order by updated_at,id limit 1000 for update skip locked) returning id`;
          const [counter] = await tx<
            { position: string; retained_after: string }[]
          >`select position::text,retained_after::text from change_counters where workspace_id=${workspace} for update`;
          if (!counter) return jobs.length;
          const floor = await retainedFloor(
            tx,
            workspace,
            counter.position,
            counter.retained_after,
          );
          const rows =
            await tx`delete from record_changes where workspace_id=${workspace} and position<=${floor}::bigint returning position`;
          await tx`update change_counters set retained_after=${floor}::bigint where workspace_id=${workspace}`;
          return rows.length + jobs.length;
        });
      } catch {
        failed++;
      }
    }
    return { queued, blocked, pruned, failed };
  }
}
