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
const createTable = /^CREATE TABLE (?:"public"\.)?"([a-z_][a-z0-9_]*)"\s*\(([\s\S]+)\);$/;
const column = `${name}\\s+(?:text|uuid|integer|bigint|boolean|jsonb|timestamptz)(?:\\s+NOT NULL)?(?:\\s+PRIMARY KEY)?`;
const simpleColumns = new RegExp(`^\\s*${column}(?:\\s*,\\s*${column})*\\s*$`);

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
  const verified = await inspectPendingJournal(sql, journal, requiredExtensions);
  if (!verified) return null;
  const tables = new Set<string>();
  for (const statement of verified.pending.flatMap((migration) => migration.sql)) {
    const tableName = createIndex.exec(statement.trim())?.[1];
    if (!tableName) return null;
    tables.add(tableName);
  }
  const relations = await sql<{ relname: string }[]>`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relispartition
      and c.relname = any(${[...tables]}::text[])`;
  return relations.length === tables.size ? verified : null;
}

/** Only independent, empty tables qualify. References to existing relations are excluded. */
export async function inspectOnlineTables(
  sql: Sql | Tx,
  journal: MigrationMeta[],
  requiredExtensions: readonly string[],
) {
  const verified = await inspectPendingJournal(sql, journal, requiredExtensions);
  if (!verified) return null;
  const tables = new Set<string>();
  for (const statement of verified.pending.flatMap((migration) => migration.sql)) {
    const match = createTable.exec(statement.trim());
    if (!match?.[1] || !match[2] || !simpleColumns.test(match[2]) || tables.has(match[1]))
      return null;
    tables.add(match[1]);
  }
  if (!tables.size) return null;
  const [existing] = await sql`select exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any(${[...tables]}::text[])
  ) as found`;
  return existing?.found === false ? verified : null;
}

async function inspectPendingJournal(
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
  return {
    plan: {
      appliedDigest: createHash('sha256').update(JSON.stringify(applied)).digest('hex'),
      pending: pending.map((migration) => migration.hash),
    },
    pending,
  };
}
