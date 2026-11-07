import type { Sql } from '../db/client.js';
import { getWorkspace, type Workspace } from '../db/workspaces.js';
import { AppError } from '../errors.js';
import { log } from '../log.js';

/**
 * Deleting a workspace (accounts spec 4.5, "Deleting"). Deleting only sets
 * `deletion_scheduled_at`; from then on every lookup treats the workspace
 * as gone: API keys, sessions and OAuth tokens are refused, the consolidator
 * skips it and the web app no longer lists it. After the grace period a
 * scheduled run removes it for good, its data cascading with it. Until then
 * an operator can restore it.
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

export type PurgeReport = { purged: number; failed: number };

/**
 * Removes for good every workspace deleted more than the grace period ago,
 * one at a time, each in its own statement. The delete repeats the
 * condition, so a workspace restored meanwhile is kept. `sql` connects as
 * the control role, which may delete workspaces; their rows cascade.
 */
export async function purgeDeletedWorkspaces(sql: Sql): Promise<PurgeReport> {
  const due = await sql<{ id: string }[]>`
    select id from workspaces
    where deletion_scheduled_at <= now() - make_interval(days => ${DELETION_GRACE_DAYS})
    order by deletion_scheduled_at, id`;
  const report: PurgeReport = { purged: 0, failed: 0 };
  for (const { id } of due) {
    try {
      const deleted = await sql`
        delete from workspaces
        where id = ${id}
          and deletion_scheduled_at <= now() - make_interval(days => ${DELETION_GRACE_DAYS})
        returning 1`;
      report.purged += deleted.length;
    } catch (error) {
      report.failed += 1;
      log.error(`Removing deleted workspace ${id} failed:`, error);
    }
  }
  if (report.purged > 0) log.info(`Removed ${report.purged} deleted workspace(s) for good.`);
  return report;
}
