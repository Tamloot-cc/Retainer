import type { Sql } from '../db/client.js';
import { inWorkspace, lockPrivacyShared } from '../db/tx.js';
import type { FileStorage } from '../file-storage/contract.js';
import { queueFileErasure } from '../files/erasure.js';

/** Durable erasure survives both crashes and workspace deletion; storage calls hold no DB transaction. */
export class FileMaintenance {
  private stopped = false;
  private readonly shutdown = new AbortController();
  stop() {
    this.stopped = true;
    this.shutdown.abort();
  }
  constructor(
    private readonly sql: Sql,
    private readonly discovery: Sql,
    private readonly storage: FileStorage,
  ) {}
  async tick(options: { budgetMs?: number } = {}) {
    const budget = options.budgetMs ?? 240000;
    if (!Number.isInteger(budget) || budget < 1 || budget > 240000)
      throw new Error('invalid file maintenance budget');
    const deadline = Date.now() + budget;
    if (this.stopped) return { erased: 0, failed: 0 };
    const due = await this.discovery<
      { workspace_id: string }[]
    >`select * from retainer_file_maintenance_due(${this.storage.id},100)`;
    let erased = 0,
      failed = 0;
    for (const { workspace_id: workspace } of due) {
      if (this.stopped || Date.now() >= deadline) break;
      await inWorkspace(this.sql, workspace, async (tx) => {
        await lockPrivacyShared(tx, workspace);
        const expired = await tx<
          { id: string }[]
        >`select f.id from files f where f.storage_id=${this.storage.id} and f.state in ('pending','ready') and f.expires_at<=clock_timestamp()
          and not exists(select 1 from file_references ref where ref.file_id=f.id)
          order by f.expires_at,f.id limit 100 for update skip locked`;
        await queueFileErasure(
          tx,
          workspace,
          expired.map((r) => r.id),
        );
      });
      for (let count = 0; count < 100; count++) {
        if (this.stopped || Date.now() >= deadline) break;
        const job = await inWorkspace(this.sql, workspace, async (tx) => {
          const [candidate] = await tx<
            { id: string }[]
          >`select id from file_deletions where storage_id=${this.storage.id}
            and ((status='queued' and available_at<=clock_timestamp()) or (status='running' and lease_until<=clock_timestamp()))
            order by available_at,id limit 1 for update skip locked`;
          if (!candidate) return null;
          const [job] = await tx<
            { id: string; object_key: string; fence: string; attempt: number }[]
          >`update file_deletions set status='running',lease_until=clock_timestamp()+interval '5 minutes',fence=fence+1,attempt=attempt+1 where id=${candidate.id} returning *`;
          return job ?? null;
        });
        if (!job) break;
        let success = false;
        try {
          await this.storage.erase(
            job.object_key,
            AbortSignal.any([
              this.shutdown.signal,
              AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            ]),
          );
          success = true;
        } catch {
          /* Persist only a safe code, never provider errors. */
        }
        const acknowledged = await inWorkspace(this.sql, workspace, async (tx) => {
          const [ack] =
            await tx`update file_deletions set status=${success ? 'succeeded' : 'queued'},lease_until=null,
            code=${success ? null : 'storage_erasure_unavailable'},available_at=clock_timestamp()+${Math.min(3600, 30 * 2 ** Math.min(job.attempt, 7))}*interval '1 second'
            where id=${job.id} and fence=${job.fence} and status='running' and lease_until>clock_timestamp() returning id`;
          if (ack && success)
            await tx`update files set state='erased' where storage_id=${this.storage.id} and object_key=${job.object_key} and state='erasing'`;
          return !!ack;
        });
        if (acknowledged) {
          if (success) erased++;
          else failed++;
        }
      }
    }
    return { erased, failed };
  }
}
