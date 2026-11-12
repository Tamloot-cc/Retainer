import { RUNTIME_ROLE, type Sql } from '../db/client.js';
import { inWorkspaceTransaction, lockSchemaShared, type Tx } from '../db/tx.js';
import { getWorkspace, type Workspace } from '../db/workspaces.js';
import { AppError } from '../errors.js';
import type { RuntimeCatalog } from '../extension-runtime/availability.js';
import { uninstallForWorkspaceDeletion } from '../extension-runtime/workspace-deletion.js';
import { log } from '../log.js';

/**
 * Deleting a workspace (accounts spec 4.5, "Deleting"). Deleting only sets
 * `deletion_scheduled_at`; from then on every lookup treats the workspace
 * as gone: API keys, sessions and OAuth tokens are refused, the consolidator
 * skips it and the web app no longer lists it. After the grace period a
 * scheduled run removes it for good, its data cascading with it. Until then
 * an operator can restore it.
 *
 * Its extensions are uninstalled when it is deleted (extensions spec 7):
 * hosted ones get the usual 24-hour cleanup deadline, well inside the grace
 * period, so their provider cleanup runs before the workspace is removed. The
 * removal waits for that cleanup to finish or pass its deadline, and never
 * longer. Restoring the workspace does not reinstall them.
 */

/** Days between deleting a workspace and removing it for good. */
export const DELETION_GRACE_DAYS = 7;

/** When a workspace deleted at `scheduledAt` is removed for good. */
export const purgeAfter = (scheduledAt: Date) =>
  new Date(scheduledAt.getTime() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);

/**
 * Undoes a deletion within the grace period. An operator operation: `sql`
 * connects as the migration role. A purge running at the same moment either
 * removed the workspace first (404) or finds it restored and leaves it.
 */
export async function restoreWorkspace(sql: Sql, idOrSlug: string): Promise<Workspace> {
  const { id } = await getWorkspace(sql, idOrSlug);
  const restored = await sql`
    update workspaces set deletion_scheduled_at = null, updated_at = now()
    where id = ${id} and deletion_scheduled_at is not null returning 1`;
  if (restored.length === 0) {
    throw new AppError(409, 'not_deleted', `workspace "${idOrSlug}" is not being deleted`);
  }
  return getWorkspace(sql, id);
}

/**
 * Uninstalls a deleted workspace's extensions. `tx` is a control transaction
 * that has scheduled the deletion; it continues as the runtime role, scoped to
 * the workspace, so this comes last in it.
 */
export async function uninstallExtensions(
  tx: Tx,
  workspaceId: string,
  catalog?: RuntimeCatalog,
): Promise<number> {
  await tx.unsafe(`set local role ${RUNTIME_ROLE}`);
  return inWorkspaceTransaction(tx, workspaceId, (scoped) =>
    uninstallForWorkspaceDeletion(scoped, workspaceId, catalog),
  );
}

/**
 * `waiting` counts workspaces past their grace period whose extension cleanup
 * is still running; a later run removes them.
 */
export type PurgeReport = { purged: number; failed: number; waiting: number };

type Cleanup = { pending: boolean; unfinished: number };

/**
 * Where a due workspace's extension cleanup stands. A workspace deleted
 * without uninstalling its extensions (before that step existed) has them
 * uninstalled now, and waits for their cleanup like any other.
 */
async function extensionCleanup(sql: Sql, id: string): Promise<Cleanup> {
  return (await sql.begin(async (tx) => {
    // The schema lock before the row, as a schema change takes them.
    await lockSchemaShared(tx, id);
    // Serializes with a restore, which updates the row.
    const [due] = await tx`
      select 1 from workspaces
      where id = ${id}
        and deletion_scheduled_at <= now() - make_interval(days => ${DELETION_GRACE_DAYS})
      for share`;
    if (!due) return { pending: false, unfinished: 0 };
    await tx.unsafe(`set local role ${RUNTIME_ROLE}`);
    return inWorkspaceTransaction(tx, id, async (scoped) => {
      const started = await uninstallForWorkspaceDeletion(scoped, id);
      const [row] = await scoped<{ pending: number; unfinished: number }[]>`
        select
          count(*) filter (where state = 'uninstalling' and cleanup_deadline > clock_timestamp())::int as pending,
          count(*) filter (where (state = 'uninstalling' and cleanup_deadline <= clock_timestamp())
            or (state = 'uninstalled'
              and last_error in ('cleanup_deadline_expired', 'cleanup_unavailable')))::int as unfinished
        from extension_installations where workspace_id = ${id}`;
      return { pending: started > 0 || (row?.pending ?? 0) > 0, unfinished: row?.unfinished ?? 0 };
    });
  })) as Cleanup;
}

/**
 * Removes for good every workspace deleted more than the grace period ago,
 * one at a time, each in its own statement. The delete repeats the
 * condition, so a workspace restored meanwhile is kept, and it skips a
 * workspace whose extension cleanup is still within its deadline. `sql`
 * connects as the control role, which may delete workspaces; their rows
 * cascade.
 */
export async function purgeDeletedWorkspaces(sql: Sql): Promise<PurgeReport> {
  const due = await sql<{ id: string }[]>`
    select id from workspaces
    where deletion_scheduled_at <= now() - make_interval(days => ${DELETION_GRACE_DAYS})
    order by deletion_scheduled_at, id`;
  const report: PurgeReport = { purged: 0, failed: 0, waiting: 0 };
  for (const { id } of due) {
    try {
      const cleanup = await extensionCleanup(sql, id);
      if (cleanup.pending) {
        report.waiting += 1;
        continue;
      }
      if (cleanup.unfinished > 0)
        log.warn(
          `Deleted workspace ${id}: ${cleanup.unfinished} extension cleanup(s) did not finish by their deadline; provider webhooks may remain registered. Removing it anyway.`,
        );
      const deleted = await sql.begin(async (tx) => {
        await lockSchemaShared(tx, id);
        return tx`
          delete from workspaces
          where id = ${id}
            and deletion_scheduled_at <= now() - make_interval(days => ${DELETION_GRACE_DAYS})
            and not retainer_workspace_extension_cleanup_pending(${id}::uuid)
          returning 1`;
      });
      report.purged += deleted.length;
    } catch (error) {
      report.failed += 1;
      log.error(`Removing deleted workspace ${id} failed:`, error);
    }
  }
  if (report.purged > 0) log.info(`Removed ${report.purged} deleted workspace(s) for good.`);
  if (report.waiting > 0)
    log.info(`${report.waiting} deleted workspace(s) wait for extension cleanup to finish.`);
  return report;
}
