import { fileURLToPath } from 'node:url';
import { type MigrationMeta, readMigrationFiles } from 'drizzle-orm/migrator';
import { loadConfig, ownerDatabaseUrl } from '../config.js';
import { createSql, type Sql } from './client.js';
import {
  inspectOnlineTables,
  inspectRestrictedIndexes,
  type RestrictedIndexJournal,
} from './restricted-indexes.js';
import type { Tx } from './tx.js';
import { WRITER_CONTROL_LOCK } from './writer-lease.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Extensions search needs (5.1): trigram and combined GIN indexes, and
 * accent folding.
 */
const EXTENSIONS = ['pg_trgm', 'btree_gin', 'unaccent'] as const;

/** The migrations use `uuidv7()`, new in PostgreSQL 18. */
const MIN_SERVER_VERSION = 180000;

/** Fails with a plain message before a migration fails on a missing function. */
export function assertSupportedServer(serverVersionNum: number): void {
  if (serverVersionNum < MIN_SERVER_VERSION) {
    const major = Math.floor(serverVersionNum / 10000);
    throw new Error(`Retainer needs PostgreSQL 18 or later; this database runs ${major}.`);
  }
}

/**
 * Applies pending migrations as the migration role (the table owner). The
 * extensions are trusted, so a database owner without superuser can create
 * them.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const sql = createSql(databaseUrl, { max: 1 });
  try {
    await sql.begin(async (tx) => {
      const [gate] = await tx`select to_regclass('retainer_deploy.admission') as name`;
      if (gate?.name) {
        await tx`select pg_advisory_xact_lock(${WRITER_CONTROL_LOCK})`;
        const [active] =
          await tx`select generation is not null as active from retainer_deploy.admission where singleton`;
        if (active?.active !== false)
          throw new Error('managed writer admission requires the hosted migration command');
      }
      await applyMigrationJournal(tx);
    });
  } finally {
    await sql.end();
  }
}

/** Applies DDL, journal rows and writer guards on one connection and transaction. */
export async function applyMigrationJournal(sql: Tx): Promise<void> {
  const [server] = await sql<{ version: number }[]>`
    select current_setting('server_version_num')::int as version`;
  assertSupportedServer(server?.version ?? 0);
  if (!(await migrationHistoryCompatible(sql)))
    throw new Error(
      'database migration history is incompatible with this build; deploy compatible code before migrating',
    );
  for (const extension of EXTENSIONS) {
    await sql.unsafe(`create extension if not exists ${extension}`);
  }
  // Use Drizzle's files, hashes and table format. The caller owns the
  // transaction so its deployment lock and journal commit cannot separate.
  await sql`create schema if not exists drizzle`;
  await sql`create table if not exists drizzle.__drizzle_migrations (
    id serial primary key, hash text not null, created_at bigint)`;
  const [last] = await sql<{ created_at: string }[]>`
    select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
  const pending = readMigrationFiles({ migrationsFolder }).filter(
    (migration) => !last || Number(last.created_at) < migration.folderMillis,
  );
  await applyJournalEntries(sql, pending);
  const [guards] = await sql`select to_regprocedure('retainer_deploy.install_guards()') as name`;
  if (guards?.name) await sql`select retainer_deploy.install_guards()`;
}

async function applyJournalEntries(sql: Tx, migrations: MigrationMeta[]): Promise<void> {
  for (const migration of migrations) {
    for (const statement of migration.sql) await sql.unsafe(statement);
    await sql`insert into drizzle.__drizzle_migrations (hash, created_at)
      values (${migration.hash}, ${migration.folderMillis})`;
  }
}

/** Separately scoped SQL preflight. Checks only the index phase. */
export async function restrictedIndexStatus(sql: Tx, folder = migrationsFolder) {
  return (
    (
      await inspectRestrictedIndexes(
        sql,
        readMigrationFiles({ migrationsFolder: folder }),
        EXTENSIONS,
      )
    )?.plan ?? null
  );
}

export async function onlineTableStatus(sql: Tx, folder = migrationsFolder) {
  return (
    (await inspectOnlineTables(sql, readMigrationFiles({ migrationsFolder: folder }), EXTENSIONS))
      ?.plan ?? null
  );
}

/** Apply an exact, previously reviewed journal while the current build serves. */
export async function applyOnlineTables(
  sql: Tx,
  expected: RestrictedIndexJournal,
  folder = migrationsFolder,
): Promise<void> {
  await sql`set local lock_timeout to '250ms'`;
  await sql`set local statement_timeout to '2s'`;
  const inspected = await inspectOnlineTables(
    sql,
    readMigrationFiles({ migrationsFolder: folder }),
    EXTENSIONS,
  );
  if (
    !inspected ||
    inspected.plan.appliedDigest !== expected.appliedDigest ||
    inspected.plan.pending.length !== expected.pending.length ||
    inspected.plan.pending.some((hash, index) => hash !== expected.pending[index])
  )
    throw new Error('The online table journal no longer matches the approved plan.');

  // An unqualified CREATE TABLE targets public. PostgreSQL still searches
  // pg_catalog first for types because it is implicit.
  await sql`set local search_path to public`;
  await applyJournalEntries(sql, inspected.pending);
  await sql`select retainer_deploy.install_guards()`;
  await sql`set local search_path to default`;
}

/** The deployment owns this transaction before applying any reviewed SQL. */
export async function applyRestrictedIndexes(
  sql: Tx,
  expected: RestrictedIndexJournal,
  folder = migrationsFolder,
): Promise<void> {
  const inspected = await inspectRestrictedIndexes(
    sql,
    readMigrationFiles({ migrationsFolder: folder }),
    EXTENSIONS,
  );
  if (
    !inspected ||
    inspected.plan.appliedDigest !== expected.appliedDigest ||
    inspected.plan.pending.length !== expected.pending.length ||
    inspected.plan.pending.some((hash, index) => hash !== expected.pending[index])
  )
    throw new Error('The restricted index journal no longer matches the approved plan.');

  await sql`set local search_path to pg_catalog, public`;
  await sql`set local lock_timeout to '2s'`;
  await applyJournalEntries(sql, inspected.pending);
  // Subsequent checks use their normal timeout and search path.
  await sql`set local lock_timeout to '0'`;
  await sql`set local search_path to default`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  await runMigrations(ownerDatabaseUrl(config));
  console.log('Migrations applied.');
}

/** Read-only: every applied timestamp/hash must be known to this build before it can migrate. */
export async function migrationHistoryCompatible(sql: Sql | Tx): Promise<boolean> {
  const [table] = await sql`select to_regclass('drizzle.__drizzle_migrations') as name`;
  if (!table?.name) return true;
  const known = new Map(
    readMigrationFiles({ migrationsFolder }).map((migration) => [
      migration.folderMillis,
      migration.hash,
    ]),
  );
  const applied = await sql<
    { created_at: string; hash: string }[]
  >`select created_at,hash from drizzle.__drizzle_migrations`;
  return applied.every((row) => known.get(Number(row.created_at)) === row.hash);
}

/** Read-only: use the same timestamp rule and journal as Drizzle's migrator. */
export async function migrationsPending(sql: Sql): Promise<boolean> {
  const [table] = await sql`select to_regclass('drizzle.__drizzle_migrations') as name`;
  if (!table?.name) return true;
  const [last] =
    await sql`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
  const extensions = await sql`select extname from pg_extension`;
  return (
    EXTENSIONS.some((name) => !extensions.some((row) => row.extname === name)) ||
    readMigrationFiles({ migrationsFolder }).some(
      (migration) => !last || Number(last.created_at) < migration.folderMillis,
    )
  );
}
