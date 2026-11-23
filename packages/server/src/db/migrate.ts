import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig, ownerDatabaseUrl } from '../config.js';
import type { Sql } from './client.js';
import { createDb } from './client.js';

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
  const { db, sql } = createDb(databaseUrl, { max: 1 });
  try {
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
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  await runMigrations(ownerDatabaseUrl(config));
  console.log('Migrations applied.');
}

/** Read-only: every applied timestamp/hash must be known to this build before it can migrate. */
export async function migrationHistoryCompatible(sql: Sql): Promise<boolean> {
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
