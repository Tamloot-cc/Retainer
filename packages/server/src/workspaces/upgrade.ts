import type { Sql } from '../db/client.js';
import type { AppliedTemplate } from '../db/schema.js';
import { inWorkspace, lockSchemaExclusive } from '../db/tx.js';
import { log } from '../log.js';
import { seedWorkspaceProfile } from '../memory/profiles.js';
import { loadSchemaState } from '../schema/load.js';
import { runSchemaChange, SYSTEM_ACTOR } from '../schema-engine/engine.js';
import { planUpgrade, type UpgradeConflict } from '../schema-engine/upgrade.js';
import { definitionsFor } from '../templates/definitions.js';

export { definitionsFor } from '../templates/definitions.js';

import { getTemplate } from '../templates/index.js';

export type UpgradeReport = {
  /** Slugs of the workspaces whose schema the run changed. */
  upgraded: string[];
  conflicts: (UpgradeConflict & { workspace: string })[];
  failed: { workspace: string; message: string }[];
  /**
   * Workspaces with `about` links to events, which can no longer be added
   * (C4). They stay and still read; this says how many there are.
   */
  aboutEventLinks: { workspace: string; count: number }[];
};

type WorkspaceRow = { templates: AppliedTemplate[]; definitions_digest: string | null };

type WorkspaceUpgrade = { changed: boolean; conflicts: UpgradeConflict[] };

/** `about` links to events, from before they were refused (C4). They stay and still read. */
async function countAboutEventLinks(sql: Sql, workspaceId: string) {
  const [links] = await inWorkspace(
    sql,
    workspaceId,
    (tx) => tx<{ count: number }[]>`
      select count(*)::int as count from event_links l
      join event_records e on e.record_id = l.record_id
      where l.workspace_id = ${workspaceId} and l.link = 'about'`,
  );
  return links?.count ?? 0;
}

/**
 * Brings one workspace up to its definitions through the schema engine's
 * trusted path, as the server's own actor. Holds the workspace's exclusive
 * schema lock and re-reads the digest under it, so concurrent runs upgrade
 * the workspace once. The digest is stamped only when nothing conflicted.
 */
async function upgradeWorkspace(sql: Sql, workspaceId: string): Promise<WorkspaceUpgrade> {
  return inWorkspace(sql, workspaceId, async (tx) => {
    await lockSchemaExclusive(tx, workspaceId);
    const [row] = await tx<WorkspaceRow[]>`
      select templates, definitions_digest from workspaces where id = ${workspaceId}`;
    if (!row) return { changed: false, conflicts: [] };
    const definitions = definitionsFor(row.templates);
    if (row.definitions_digest === definitions.digest) {
      return { changed: false, conflicts: [] };
    }

    const { operations, conflicts } = planUpgrade(
      await loadSchemaState(tx, workspaceId),
      definitions.operations,
    );
    // Even with nothing to create, the trusted path may protect elements.
    const result = await runSchemaChange(tx, {
      workspaceId,
      actor: SYSTEM_ACTOR,
      scopes: [],
      operations,
      reason: 'Upgrade built-in definitions',
      owner: 'system',
      trusted: true,
    });
    if (result.status !== 'applied' && result.status !== 'unchanged') {
      throw new Error(`the upgrade change was ${result.status}: ${result.change?.error ?? ''}`);
    }
    // Workspaces from before workspace memory get its profile (personal memory 4.1).
    await seedWorkspaceProfile(tx, workspaceId, SYSTEM_ACTOR);
    if (conflicts.length === 0) {
      const templates = row.templates.map((t) => ({
        ...t,
        version: getTemplate(t.name)?.version ?? t.version,
      }));
      await tx`
        update workspaces
        set templates = ${tx.json(templates)}, definitions_digest = ${definitions.digest},
          updated_at = now()
        where id = ${workspaceId}`;
    }
    return { changed: result.status === 'applied', conflicts };
  });
}

/**
 * Upgrades every workspace whose digest is stale (3), after migrations.
 * `sql` connects as the migration role. A workspace that fails is logged
 * and reported, and keeps its schema; the others still run.
 */
export async function upgradeWorkspaces(sql: Sql): Promise<UpgradeReport> {
  const report: UpgradeReport = { upgraded: [], conflicts: [], failed: [], aboutEventLinks: [] };
  const rows = await sql<(WorkspaceRow & { id: string; slug: string })[]>`
    select id, slug, templates, definitions_digest from workspaces order by created_at, id`;
  for (const row of rows) {
    if (row.definitions_digest === definitionsFor(row.templates).digest) continue;
    try {
      const { changed, conflicts } = await upgradeWorkspace(sql, row.id);
      // Outside the upgrade: every write in the workspace waits on its lock.
      const aboutEventLinks = await countAboutEventLinks(sql, row.id);
      if (changed) {
        report.upgraded.push(row.slug);
        log.info(`Upgraded workspace ${row.slug} to the built-in definitions.`);
      }
      if (aboutEventLinks > 0) {
        report.aboutEventLinks.push({ workspace: row.slug, count: aboutEventLinks });
        log.info(
          `Workspace ${row.slug} has ${aboutEventLinks} about links to events. They stay and ` +
            'still read; new ones are refused.',
        );
      }
      for (const conflict of conflicts) {
        report.conflicts.push({ workspace: row.slug, ...conflict });
        log.warn(
          `Workspace ${row.slug}: could not add built-in ${conflict.element}: ${conflict.message}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ workspace: row.slug, message });
      log.error(`Upgrading workspace ${row.slug} failed: ${message}`);
    }
  }
  return report;
}

/** Read-only and deliberately conservative, including unresolved conflicts. */
export async function workspaceUpgradesPending(sql: Sql): Promise<boolean> {
  const rows = await sql<WorkspaceRow[]>`select templates, definitions_digest from workspaces`;
  return rows.some((row) => row.definitions_digest !== definitionsFor(row.templates).digest);
}
