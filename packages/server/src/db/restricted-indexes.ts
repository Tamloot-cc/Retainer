import { createHash } from 'node:crypto';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import type { Sql } from './client.js';
import type { Tx } from './tx.js';

export type RestrictedIndexJournal = { appliedDigest: string; pending: string[] };

const name = '"[a-z_][a-z0-9_]*"';
const columns = `${name}(?:\\s*,\\s*${name})*`;
const createIndex = new RegExp(
  `^CREATE INDEX ${name} ON (?:"public"\\.)?"([a-z_][a-z0-9_]*)"(?: USING btree)?\\s*\\(${columns}\\);$`,
);

/**
 * Verify the complete applied prefix and each pending statement. A plain
 * non-unique index on an ordinary table takes SHARE, allowing ACCESS SHARE
 * reads with the same shape before and after commit.
 */
export async function inspectRestrictedIndexes(
  sql: Sql | Tx,
  journal: MigrationMeta[],
  requiredExtensions: readonly string[],
): Promise<{ plan: RestrictedIndexJournal; pending: MigrationMeta[] } | null> {
  const [table] = await sql`select to_regclass('drizzle.__drizzle_migrations') as name`;
  if (!table?.name) return null;
  const applied = await sql<{ created_at: string; hash: string }[]>`
    select created_at, hash from drizzle.__drizzle_migrations order by created_at`;
  const pending = journal.slice(applied.length);
  if (
    applied.length === 0 ||
    pending.length === 0 ||
    applied.some(
      (row, index) =>
        Number(row.created_at) !== journal[index]?.folderMillis ||
        row.hash !== journal[index]?.hash,
    )
  )
    return null;
  const extensions = await sql`select extname from pg_extension`;
  if (requiredExtensions.some((name) => !extensions.some((row) => row.extname === name)))
    return null;
  const tables = new Set<string>();
  for (const statement of pending.flatMap((migration) => migration.sql)) {
    const tableName = createIndex.exec(statement.trim())?.[1];
    if (!tableName) return null;
    tables.add(tableName);
  }
  const relations = await sql<{ relname: string }[]>`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relispartition
      and c.relname = any(${[...tables]}::text[])`;
  if (relations.length !== tables.size) return null;
  return {
    plan: {
      appliedDigest: createHash('sha256').update(JSON.stringify(applied)).digest('hex'),
      pending: pending.map((migration) => migration.hash),
    },
    pending,
  };
}
