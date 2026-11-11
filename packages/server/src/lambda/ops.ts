import { z } from 'zod';
import { type Config, loadConfig, ownerDatabaseUrl } from '../config.js';
import { createSql } from '../db/client.js';
import { applyLogins, loginsPending } from '../db/logins.js';
import { migrationHistoryCompatible, migrationsPending, runMigrations } from '../db/migrate.js';
import { setLogLevel } from '../log.js';
import { runCli } from '../operator/commands.js';
import { extensionReleaseStatus } from '../operator/extension-releases.js';
import { rebuildSearchText } from '../records/rebuild-search.js';
import {
  type UpgradeReport,
  upgradeWorkspaces,
  workspaceUpgradesPending,
} from '../workspaces/upgrade.js';
import { withMigrationLock } from './deploy-lock.js';

/**
 * Operator tasks as an AWS Lambda function that only the operator invokes.
 * It is the deployment's replacement for running the CLI in
 * the container, since the database is not reachable from outside the VPC.
 *
 * - `{ "command": "migration-status" }` reports pending work without writes.
 *   Only protocol 1 with historyChecked true and needsStop false permits a rolling code update.
 * - `extension-release-status` checks candidate runtime/protocol and retained
 *   release hashes against active, disabled and cleanup-capable installations.
 *   It returns hashes/counts only and writes nothing.
 * - `{ "command": "migrate" }` applies pending migrations, sets the runtime
 *   and control roles' logins from their URLs, rebuilds stale search
 *   text and upgrades workspaces to the built-in definitions: what the
 *   container does on every start. The deploy runs it
 *   once, with the API and the consolidator stopped. It first waits, up to
 *   `waitSeconds` (default 330, past the consolidator's 300-second timeout),
 *   for consolidator passes still running on the old version (deploy-lock.ts).
 * - `{ "command": "cli", "args": ["key", "create", ...] }` runs the
 *   operator CLI (7.1).
 *
 * The CLI's output is returned to the caller and never logged: `key create`
 * prints the only copy of a key.
 */
const opsEvent = z.discriminatedUnion('command', [
  z.object({ command: z.literal('migration-status') }),
  z.object({
    command: z.literal('extension-release-status'),
    protocolVersion: z.literal(1),
    runtimeVersion: z.literal('node24'),
    releaseDigests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000),
  }),
  z.object({
    command: z.literal('migrate'),
    // At least 1: a lock_timeout of 0 would wait forever.
    waitSeconds: z.number().int().min(1).max(840).default(330),
  }),
  z.object({ command: z.literal('cli'), args: z.array(z.string()) }),
]);

export type OpsEvent = z.input<typeof opsEvent>;
export type OpsResult =
  | ({ command: 'extension-release-status'; protocol: 1 } & Awaited<
      ReturnType<typeof extensionReleaseStatus>
    >)
  | {
      command: 'migration-status';
      protocol: 1;
      historyChecked: true;
      needsStop: boolean;
      reasons: string[];
    }
  | {
      command: 'migrate';
      logins: { runtime: boolean; control: boolean };
      rebuiltSearchText: number;
      workspaceUpgrade: UpgradeReport;
    }
  | { command: 'cli'; exitCode: number; stdout: string; stderr: string };

export function createOpsHandler(config: Config) {
  setLogLevel(config.LOG_LEVEL);
  // Every operator task needs the owner; fail at init without it.
  const databaseUrl = ownerDatabaseUrl(config);
  return async (event: unknown): Promise<OpsResult> => {
    const parsed = opsEvent.safeParse(event);
    if (!parsed.success) {
      throw new Error(
        'Expected {"command":"migrate"}, {"command":"migration-status"}, {"command":"extension-release-status",...} or {"command":"cli","args":[...]}: ' +
          parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    // Operator commands connect as the migration role, like the CLI.
    // `max: 1`, because the deploy lock and the search rebuild are session
    // locks; the workspace upgrade runs on the same connection.
    if (parsed.data.command === 'extension-release-status') {
      const sql = createSql(databaseUrl, { max: 1 });
      try {
        return {
          command: 'extension-release-status',
          protocol: 1,
          ...(await extensionReleaseStatus(sql, parsed.data.releaseDigests)),
        };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    if (parsed.data.command === 'migration-status') {
      const sql = createSql(databaseUrl, { max: 1 });
      try {
        // SQL can change any write rule. Return early on old schemas rather
        // than querying columns they may not have yet. Any failure is a stop.
        const reasons: string[] = [];
        if (!(await migrationHistoryCompatible(sql))) reasons.push('incompatible_migrations');
        else if (await migrationsPending(sql)) reasons.push('migrations');
        else {
          if (await loginsPending(config, sql)) reasons.push('logins');
          // Rebuild batches lock rows, but old writers could still produce
          // old-format text. Definition upgrades change schema/protection
          // and seed profiles. Both require a stop across release versions.
          const [stale] =
            await sql`select exists(select 1 from records where search is null and merged_into_id is null) as pending`;
          if (stale?.pending) reasons.push('search');
          if (await workspaceUpgradesPending(sql)) reasons.push('definitions');
        }
        return {
          command: 'migration-status',
          protocol: 1,
          historyChecked: true,
          needsStop: reasons.length > 0,
          reasons,
        };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    if (parsed.data.command === 'migrate') {
      const sql = createSql(databaseUrl, { max: 1, keepConnections: true });
      try {
        return await withMigrationLock(sql, parsed.data.waitSeconds, async () => {
          await runMigrations(databaseUrl);
          // Before the api and consolidate functions start with the new login.
          const logins = await applyLogins(config, sql);
          const rebuiltSearchText = await rebuildSearchText(sql);
          const workspaceUpgrade = await upgradeWorkspaces(sql);
          if (workspaceUpgrade.failed.length > 0)
            throw new Error('Workspace upgrades failed; keep maintenance enabled and retry.');
          return { command: 'migrate', logins, rebuiltSearchText, workspaceUpgrade };
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    const sql = createSql(databaseUrl, { max: 1 });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await runCli(parsed.data.args, {
        sql,
        out: (line) => stdout.push(line),
        err: (line) => stderr.push(line),
      });
      return { command: 'cli', exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    } finally {
      await sql.end({ timeout: 5 });
    }
  };
}

let cached: ReturnType<typeof createOpsHandler> | undefined;

/** The Lambda entry point (`dist/lambda/ops.handler`). */
export const handler = (event: unknown) => {
  cached ??= createOpsHandler(loadConfig());
  return cached(event);
};
