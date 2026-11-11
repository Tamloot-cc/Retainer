import { retainedFloor } from '../db/change-cursor.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, lockPrivacyShared, lockSchemaShared } from '../db/tx.js';
import { failInstallation } from '../extension-runtime/lifecycle.js';
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
    const due = this.queue ? await this.queue.discoverChanges(this.discovery, this.after) : [];
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
          const installations = await tx<{ id: string; registration_id: string }[]>`
            select id,registration_id from extension_installations order by registration_id,id`;
          for (const installation of installations) {
            await lockExtension(tx, workspace, installation.registration_id, true);
            await lockQueue(tx, workspace, installation.id);
          }
          const locked = await tx<
            {
              id: string;
              generation: number;
              release_digest: string;
              setup_kind: string;
            }[]
          >`select id,generation,release_digest,setup_kind from extension_installations
            where id=any(${installations.map((row) => row.id)}::uuid[])`;
          const current = new Map(locked.map((row) => [row.id, row]));
          const expired = await tx<
            {
              id: string;
              installation_id: string;
              generation: number;
              release_digest: string;
              trigger_kind: string;
            }[]
          >`update extension_jobs set status='failed',code='job_expired',lease_owner=null,lease_until=null,run_until=null,updated_at=clock_timestamp()
              where id in(select id from extension_jobs where installation_id=any(${installations.map((row) => row.id)}::uuid[]) and expires_at<=clock_timestamp() and (status='queued' or status='running' and lease_until<=clock_timestamp())
                order by expires_at,id limit 1000 for update skip locked) returning id,installation_id,generation,release_digest,trigger_kind`;
          for (const job of expired) {
            await tx`update extension_attempts set status='failed',code='job_expired',finished_at=clock_timestamp()
              where job_id=${job.id} and finished_at is null`;
            const installation = current.get(job.installation_id);
            if (installation) await failInstallation(tx, installation, job, 'job_expired');
          }
          const jobs =
            await tx`delete from extension_jobs where id in(select id from extension_jobs where status in ('succeeded','failed','cancelled')
              and updated_at<clock_timestamp()-interval '30 days' order by updated_at,id limit 1000 for update skip locked) returning id`;
          const receipts =
            await tx`with expired as (select workspace_id,binding_id,delivery_hash from webhook_receipts
              where created_at<clock_timestamp()-interval '7 days' order by created_at,binding_id,delivery_hash limit 10000 for update skip locked)
            delete from webhook_receipts r using expired e where r.workspace_id=e.workspace_id and r.binding_id=e.binding_id and r.delivery_hash=e.delivery_hash returning r.binding_id`;
          const bindings =
            await tx`delete from webhook_bindings where id in(select b.id from webhook_bindings b
              where b.state='retired' and b.updated_at<clock_timestamp()-interval '30 days'
              and not exists(select 1 from webhook_receipts r where r.binding_id=b.id)
              order by b.updated_at,b.id limit 1000 for update skip locked) returning id`;
          const unavailable = await tx`with stale as (
            select workspace_id,installation_id,runtime_identity from extension_runtime_unavailable
            where checked_at<clock_timestamp()-interval '30 days' order by checked_at,installation_id limit 1000 for update skip locked)
            delete from extension_runtime_unavailable u using stale s where u.workspace_id=s.workspace_id
              and u.installation_id=s.installation_id and u.runtime_identity=s.runtime_identity returning u.installation_id`;
          const removed = jobs.length + receipts.length + bindings.length + unavailable.length;
          const [counter] = await tx<
            { position: string; retained_after: string }[]
          >`select position::text,retained_after::text from change_counters where workspace_id=${workspace} for update`;
          if (!counter) return removed;
          const floor = await retainedFloor(
            tx,
            workspace,
            counter.position,
            counter.retained_after,
          );
          const rows =
            await tx`delete from record_changes where workspace_id=${workspace} and position<=${floor}::bigint returning position`;
          await tx`update change_counters set retained_after=${floor}::bigint where workspace_id=${workspace}`;
          return rows.length + removed;
        });
      } catch {
        failed++;
      }
    }
    return { queued, blocked, pruned, failed };
  }
}
