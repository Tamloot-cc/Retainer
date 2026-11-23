import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, inject } from 'vitest';
import { createSql, type Sql, type SqlOptions } from '../../src/db/client.js';

declare module 'vitest' {
  interface ProvidedContext {
    /** Server URL whose database is used to create and drop test databases. */
    adminDatabaseUrl: string;
    /** Migrated database that every test database is cloned from. */
    templateDatabase: string;
  }
}

export type TestDatabase = {
  name: string;
  url: string;
  /** Connects as the migration role, which owns the tables (no RLS). */
  owner: Sql;
  /** Opens another pool on this database; closed by `drop`. */
  connect: (options?: SqlOptions) => Sql;
  /**
   * Opens a one-connection pool on another URL, such as another role's
   * login; closed by `drop`. Each call connects afresh, so it picks up the
   * role's current password and defaults.
   */
  connectUrl: (url: string) => Sql;
  drop: () => Promise<void>;
};

export function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Clones the migrated template into a database of its own. */
export async function createTestDatabase(templateOverride?: string): Promise<TestDatabase> {
  const adminUrl = inject('adminDatabaseUrl');
  const template = templateOverride ?? inject('templateDatabase');
  const name = `retainer_test_${randomBytes(8).toString('hex')}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: false });
  try {
    // CREATE DATABASE … TEMPLATE fails while another session is copying the
    // same template; parallel test files retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.unsafe(`create database "${name}" template "${template}"`);
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== '55006' || attempt >= 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
      }
    }
  } finally {
    await admin.end();
  }

  const url = databaseUrl(adminUrl, name);
  const owner = createSql(url, { max: 5 });
  const pools: Sql[] = [owner];

  return {
    name,
    url,
    owner,
    connect: (options) => {
      const sql = createSql(url, options);
      pools.push(sql);
      return sql;
    },
    connectUrl: (other) => {
      const sql = createSql(other, { max: 1 });
      pools.push(sql);
      return sql;
    },
    drop: async () => {
      await Promise.all(pools.map((sql) => sql.end()));
      const dropper = postgres(adminUrl, { max: 1, onnotice: false });
      try {
        await dropper.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/**
 * Gives the test file a fresh database, created before its tests and dropped
 * after them. The returned object is filled in by `beforeAll`.
 */
export function useTestDatabase(): TestDatabase {
  const db = {} as TestDatabase;
  beforeAll(async () => {
    Object.assign(db, await createTestDatabase());
  });
  afterAll(async () => {
    await db.drop?.();
  });
  return db;
}
