import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { initMastraSchema, MASTRA_SCHEMA } from '../src/store.js';

export type MastraTestDatabase = {
  /** The owner's URL: it ran Mastra's init and owns the tables. */
  ownerUrl: string;
  /** A login role like `retainer_mastra`: USAGE and DML on `mastra`, nothing else. */
  mastraUrl: string;
  query: (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
  drop: () => Promise<void>;
};

function withDatabase(url: string, database: string, user?: { name: string; password: string }) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

/**
 * A fresh database for one test file, with Mastra's tables and a role that
 * reaches only the `mastra` schema, granted the way the migration step does.
 */
export async function createMastraTestDatabase(): Promise<MastraTestDatabase> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL is not set; agent store tests need Postgres.');
  const suffix = randomBytes(6).toString('hex');
  const name = `agent_test_${suffix}`;
  const role = { name: `agent_mastra_${suffix}`, password: randomBytes(12).toString('hex') };
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"`);
    await admin.query(`create role "${role.name}" login password '${role.password}'`);
  } finally {
    await admin.end();
  }
  const ownerUrl = withDatabase(adminUrl, name);
  await initMastraSchema(ownerUrl);
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  await owner.query(`revoke all on schema public from "${role.name}"`);
  await owner.query(`grant usage on schema ${MASTRA_SCHEMA} to "${role.name}"`);
  await owner.query(
    `grant select, insert, update, delete on all tables in schema ${MASTRA_SCHEMA} to "${role.name}"`,
  );
  await owner.query(
    `grant usage, select on all sequences in schema ${MASTRA_SCHEMA} to "${role.name}"`,
  );
  return {
    ownerUrl,
    mastraUrl: withDatabase(adminUrl, name, role),
    query: (text, values) => owner.query(text, values),
    drop: async () => {
      await owner.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        await a.query(`drop database if exists "${name}" with (force)`);
        await a.query(`drop role if exists "${role.name}"`);
      } finally {
        await a.end();
      }
    },
  };
}
