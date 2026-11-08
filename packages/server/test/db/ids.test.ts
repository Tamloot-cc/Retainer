import { describe, expect, it } from 'vitest';
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
});
