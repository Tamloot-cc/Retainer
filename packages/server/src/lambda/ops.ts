import { z } from 'zod';
import { type Config, loadConfig, ownerDatabaseUrl } from '../config.js';
import { createSql, type Sql } from '../db/client.js';
import { applyLogins, loginsPending } from '../db/logins.js';
import {
  applyMigrationJournal,
  applyOnlineTables,
  applyRestrictedIndexes,
  migrationHistoryCompatible,
  migrationsPending,
  onlineTableStatus,
  restrictedIndexStatus,
} from '../db/migrate.js';
import { HOSTED_WRITER_BUILD } from '../db/writer-build.js';
import { WRITER_CONTROL_LOCK } from '../db/writer-lease.js';
import { parseExtensionCatalog } from '../extensions/catalog.js';
import { setLogLevel } from '../log.js';
import { runCli } from '../operator/commands.js';
import { extensionReleaseStatus } from '../operator/extension-releases.js';
import {
  lambdaRuntimeCompatible,
  type RuntimeCompatibility,
} from '../operator/extension-runtime.js';
import { backfillSearchTextBatch, rebuildSearchText } from '../records/rebuild-search.js';
import {
  bindingsMigrationPending,
  migrateExtensionBindings,
} from '../workspaces/binding-migration.js';
import {
  type UpgradeReport,
  upgradeWorkspaces,
  workspaceUpgradesPending,
} from '../workspaces/upgrade.js';
import { withMigrationLock } from './deploy-lock.js';
import { withWriterInvocation } from './writer-admission.js';
import {
  requireMigrationOwnership,
  writerAdmission,
  writerCommands,
  writerOwnership,
} from './writer-ops.js';

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
const journalProof = z.strictObject({
  appliedDigest: z.string().regex(/^[0-9a-f]{64}$/),
  pending: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .min(1)
    .max(1000),
});

const opsEvent = z.discriminatedUnion('command', [
  ...writerCommands,
  z.object({ command: z.literal('migration-status') }),
  z.strictObject({ command: z.literal('restricted-index-status'), protocol: z.literal(1) }),
  z.strictObject({ command: z.literal('online-table-status'), protocol: z.literal(1) }),
  z.strictObject({
    command: z.literal('backfill-search-text'),
    protocol: z.literal(1),
    workspaceId: z.uuid(),
    batch: z.number().int().min(1).max(100).default(50),
  }),
  z.strictObject({
    command: z.literal('migrate-online-tables'),
    protocol: z.literal(1),
    servingBuild: z.string().regex(/^[0-9a-f]{40}$/),
    admittedBuilds: z
      .array(z.string().regex(/^[0-9a-f]{40}$/))
      .min(1)
      .optional(),
    journal: journalProof,
  }),
  z.strictObject({
    command: z.literal('migrate-restricted-indexes'),
    protocol: z.literal(1),
    writerAdmission: writerOwnership,
    journal: journalProof,
  }),
  z.object({
    command: z.literal('extension-runtime-status'),
    configurationDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    bundles: z.number().int().min(1).max(10000).optional(),
  }),
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
    writerAdmission: writerOwnership.optional(),
  }),
  z.object({ command: z.literal('cli'), args: z.array(z.string()) }),
]);

export type OpsEvent = z.input<typeof opsEvent>;
export type OpsResult =
  | (Awaited<ReturnType<typeof writerAdmission>> & { writerBuild: string | undefined })
  | { command: 'extension-runtime-status'; protocol: 1; compatible: boolean; reason?: string }
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
      writerTiming?: { closedAt: Date; permittedAt: Date; journalAppliedAt: Date };
    }
  | {
      command: 'restricted-index-status' | 'online-table-status';
      protocol: 1;
      writerBuild: string;
      journal: Awaited<ReturnType<typeof restrictedIndexStatus>>;
    }
  | { command: 'migrate-online-tables'; protocol: 1; writerBuild: string }
  | { command: 'backfill-search-text'; protocol: 1; rebuilt: number; pending: boolean }
  | {
      command: 'migrate-restricted-indexes';
      protocol: 1;
      writerBuild: string;
      followUpReasons: string[];
      writerTiming: { closedAt: Date; permittedAt: Date; journalAppliedAt: Date };
    }
  | { command: 'cli'; exitCode: number; stdout: string; stderr: string };

async function otherStopReasons(config: Config, sql: Sql): Promise<string[]> {
  const reasons: string[] = [];
  if (await loginsPending(config, sql)) reasons.push('logins');
  const [stale] =
    await sql`select exists(select 1 from records where search is null and merged_into_id is null) as pending`;
  if (stale?.pending) reasons.push('search');
  if (await bindingsMigrationPending(sql, parseExtensionCatalog(config.RETAINER_EXTENSION_CATALOG)))
    reasons.push('bindings');
  if (await workspaceUpgradesPending(sql)) reasons.push('definitions');
  return reasons;
}

export function createOpsHandler(
  config: Config,
  writerBuild = HOSTED_WRITER_BUILD,
  restrictedFixtureFolder?: string,
) {
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
    const command = parsed.data;
    if (
      command.command === 'writer-admission-status' ||
      command.command === 'writer-admission-close' ||
      command.command === 'writer-admission-open' ||
      command.command === 'writer-admission-enroll' ||
      command.command === 'writer-admission-reconcile'
    ) {
      const sql = createSql(databaseUrl, { max: 1, statementTimeoutMs: 5000 });
      try {
        if ('candidate' in command && command.candidate !== writerBuild)
          throw new Error('writer admission candidate does not match the ops build');
        return { ...(await writerAdmission(sql, command, writerBuild)), writerBuild };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    // Operator commands connect as the migration role, like the CLI.
    // `max: 1`, because the deploy lock and the search rebuild are session
    // locks; the workspace upgrade runs on the same connection.
    if (command.command === 'extension-runtime-status') {
      if (config.RETAINER_EXTENSION_DRIVER === 'lambda') {
        let status: RuntimeCompatibility;
        try {
          status = await lambdaRuntimeCompatible(config);
        } catch (error) {
          status = {
            compatible: false,
            reason: `runtime check failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        // The deploy prints the reason; the log keeps it when nobody reads the deploy.
        if (!status.compatible) console.warn(`extension runtime incompatible: ${status.reason}`);
        return { command: 'extension-runtime-status', protocol: 1, ...status };
      }
      if (!command.configurationDigest || !command.bundles)
        throw new Error('launcher status requires configurationDigest and bundles');
      // Only the operator-configured private origin is reachable; payloads cannot choose a URL.
      const origin = config.RETAINER_EXTENSION_LAUNCHER_ORIGIN;
      if (!origin) throw new Error('extension launcher is not configured');
      try {
        const response = await fetch(new URL('/health', origin), {
          signal: AbortSignal.timeout(10000),
          redirect: 'error',
        });
        const status = z
          .object({
            status: z.literal('ok'),
            protocolVersion: z.literal(1),
            runtimeVersion: z.literal('node24'),
            configurationDigest: z.literal(command.configurationDigest),
            bundles: z.literal(command.bundles),
          })
          .safeParse(await response.json());
        return {
          command: 'extension-runtime-status',
          protocol: 1,
          compatible: response.ok && status.success,
        };
      } catch {
        return { command: 'extension-runtime-status', protocol: 1, compatible: false };
      }
    }
    if (command.command === 'extension-release-status') {
      const sql = createSql(databaseUrl, { max: 1 });
      try {
        return {
          command: 'extension-release-status',
          protocol: 1,
          ...(await extensionReleaseStatus(sql, command.releaseDigests)),
        };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    if (command.command === 'migration-status') {
      const sql = createSql(databaseUrl, { max: 1 });
      try {
        // SQL can change any write rule. Return early on old schemas rather
        // than querying columns they may not have yet. Any failure is a stop.
        const reasons: string[] = [];
        if (!(await migrationHistoryCompatible(sql))) reasons.push('incompatible_migrations');
        else if (await migrationsPending(sql)) reasons.push('migrations');
        else reasons.push(...(await otherStopReasons(config, sql)));
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
    if (
      command.command === 'restricted-index-status' ||
      command.command === 'online-table-status'
    ) {
      if (!writerBuild) throw new Error('Restricted migration requires a hosted writer build.');
      const sql = createSql(databaseUrl, { max: 1, statementTimeoutMs: 5000 });
      try {
        const inspect =
          command.command === 'online-table-status' ? onlineTableStatus : restrictedIndexStatus;
        const journal = await sql.begin('isolation level repeatable read read only', (tx) =>
          inspect(tx, restrictedFixtureFolder),
        );
        return { command: command.command, protocol: 1, writerBuild, journal };
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    if (command.command === 'migrate-online-tables') {
      if (!writerBuild) throw new Error('Online migration requires a hosted writer build.');
      const sql = createSql(databaseUrl, { max: 1, statementTimeoutMs: 5000 });
      try {
        return await withMigrationLock(sql, 1, async (tx) => {
          const [lock] =
            await tx`select pg_try_advisory_xact_lock(${WRITER_CONTROL_LOCK}) as acquired`;
          if (!lock?.acquired) throw new Error('Writer admission is busy; retry online migration.');
          const [admission] = await tx`select builds from retainer_deploy.admission
            where singleton and generation is not null and closed_at is null`;
          const approvedBuilds = command.admittedBuilds ?? [command.servingBuild];
          const approved = new Set(approvedBuilds);
          if (
            approved.size !== approvedBuilds.length ||
            !approved.has(command.servingBuild) ||
            admission?.builds?.length !== approved.size ||
            !admission.builds.every((build: string) => approved.has(build))
          )
            throw new Error(
              'Online migration requires the verified serving build and admitted builds.',
            );
          await applyOnlineTables(tx, command.journal, restrictedFixtureFolder);
          if ((await otherStopReasons(config, tx as unknown as Sql)).length)
            throw new Error('Additional migration work requires a stopped deployment.');
          return { command: command.command, protocol: 1, writerBuild };
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    if (command.command === 'backfill-search-text') {
      if (!writerBuild) throw new Error('An online backfill requires a hosted writer build.');
      const sql = createSql(databaseUrl, { max: 1, writerBuild, statementTimeoutMs: 5000 });
      try {
        return await withMigrationLock(sql, 1, async (tx) => {
          if (!(await migrationHistoryCompatible(tx)) || (await migrationsPending(tx)))
            throw new Error('Apply and verify the migration journal before running a backfill.');
          const [admission] = await tx<{ admitted: boolean }[]>`
            select retainer_deploy.admit_writer() and exists (
              select 1 from retainer_deploy.admission where singleton and generation is not null
            ) as admitted`;
          if (!admission?.admitted) throw new Error('The backfill build is not admitted.');
          await tx`select set_config('lock_timeout', '250ms', true)`;
          const result = await backfillSearchTextBatch(tx, command.workspaceId, command.batch);
          return { command: command.command, protocol: 1, ...result };
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    if (command.command === 'migrate-restricted-indexes') {
      if (!writerBuild) throw new Error('Restricted migration requires a hosted writer build.');
      const sql = createSql(databaseUrl, { max: 1, keepConnections: true });
      try {
        return await withMigrationLock(sql, 330, async (tx) => {
          const admission = await requireMigrationOwnership(
            tx,
            command.writerAdmission,
            writerBuild,
          );
          if (!admission)
            throw new Error('Restricted migration requires closed admission ownership.');
          await applyRestrictedIndexes(tx, command.journal, restrictedFixtureFolder);
          const [journal] = await tx<{ at: Date }[]>`select clock_timestamp() as at`;
          if (!journal) throw new Error('Missing index deployment timestamp.');
          const followUpReasons = await otherStopReasons(config, tx as unknown as Sql);
          if (followUpReasons.length === 0)
            await tx`update retainer_deploy.admission set migrated = true where singleton`;
          return {
            command: 'migrate-restricted-indexes',
            protocol: 1,
            writerBuild,
            followUpReasons,
            writerTiming: { ...admission, journalAppliedAt: journal.at },
          };
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    if (command.command === 'migrate') {
      const sql = createSql(databaseUrl, { max: 1, keepConnections: true });
      try {
        return await withMigrationLock(sql, command.waitSeconds, async (tx) => {
          const admission = await requireMigrationOwnership(
            tx,
            command.writerAdmission,
            writerBuild,
          );
          await applyMigrationJournal(tx);
          const [journal] = admission
            ? await tx<{ at: Date }[]>`select clock_timestamp() as at`
            : [];
          // postgres.js provides begin() as a savepoint on this transaction.
          const migrationSql = tx as unknown as Sql;
          const bindings = await migrateExtensionBindings(
            migrationSql,
            parseExtensionCatalog(config.RETAINER_EXTENSION_CATALOG),
            false,
          );
          // Before the api and consolidate functions start with the new login.
          const logins = await applyLogins(config, migrationSql);
          const rebuiltSearchText = await rebuildSearchText(migrationSql);
          const workspaceUpgrade = await upgradeWorkspaces(migrationSql);
          if (workspaceUpgrade.failed.length > 0)
            throw new Error('Workspace upgrades failed; keep maintenance enabled and retry.');
          if (command.writerAdmission)
            await tx`update retainer_deploy.admission set migrated = true where singleton`;
          return {
            command: 'migrate',
            logins,
            rebuiltSearchText,
            workspaceUpgrade,
            bindings: bindings.length,
            ...(admission && journal
              ? { writerTiming: { ...admission, journalAppliedAt: journal.at } }
              : {}),
          };
        });
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    const sql = createSql(databaseUrl, { max: 1 });
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await runCli(command.args, {
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
export const handler = (event: unknown, context: { getRemainingTimeInMillis(): number }) => {
  cached ??= createOpsHandler(loadConfig());
  const ops = cached;
  // CLI calls can have writes or external effects. Other commands are either
  // read-only or take ownership inside the mutating transaction.
  return (event as { command?: string } | null)?.command === 'cli'
    ? withWriterInvocation(context, () => ops(event))
    : ops(event);
};
