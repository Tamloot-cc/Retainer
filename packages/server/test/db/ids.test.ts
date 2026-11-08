import { describe, expect, it } from 'vitest';
import { assertSupportedServer } from '../../src/db/migrate.js';
import { startAccountsApp } from '../helpers/accounts.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();

describe('ids', () => {
  it('generates every uuid primary key with uuidv7()', async () => {
    const rows = await db.owner<{ table_name: string; column_default: string | null }[]>`
      select c.table_name, c.column_default
      from information_schema.columns c
      join information_schema.key_column_usage k
        on k.table_schema = c.table_schema and k.table_name = c.table_name
        and k.column_name = c.column_name
      join information_schema.table_constraints t
        on t.constraint_name = k.constraint_name and t.table_schema = k.table_schema
      where c.table_schema = 'public' and c.column_name = 'id' and c.data_type = 'uuid'
        and t.constraint_type = 'PRIMARY KEY'
      order by c.table_name`;
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.column_default !== 'uuidv7()')).toEqual([]);
  });

  it('orders new IDs by creation', async () => {
    const rows = await db.owner<{ id: string; version: number }[]>`
      insert into organizations (name)
      select 'Ids ' || g from generate_series(1, 20) g
      returning id, uuid_extract_version(id) as version`;
    expect(rows.every((r) => r.version === 7)).toBe(true);
    const ids = rows.map((r) => r.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('leaves Better Auth IDs to the database', async () => {
    const { userId } = await startAccountsApp(db).signIn();
    const [row] = await db.owner<{ user: number; session: number; account: number }[]>`
      select uuid_extract_version(${userId}::uuid) as user,
        (select uuid_extract_version(id) from sessions where user_id = ${userId}) as session,
        (select uuid_extract_version(id) from auth_accounts where user_id = ${userId}) as account`;
    expect(row).toEqual({ user: 7, session: 7, account: 7 });
  });
});

describe('assertSupportedServer', () => {
  it('accepts PostgreSQL 18 and later', () => {
    expect(() => assertSupportedServer(180003)).not.toThrow();
    expect(() => assertSupportedServer(190000)).not.toThrow();
  });

  it('rejects PostgreSQL 17 with a plain message', () => {
    expect(() => assertSupportedServer(170009)).toThrow(
      'Retainer needs PostgreSQL 18 or later; this database runs 17.',
    );
  });
});
