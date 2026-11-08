import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig, ownerDatabaseUrl } from '../config.js';
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
