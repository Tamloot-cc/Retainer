import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, inject, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { databaseUrl } from '../helpers/db.js';

// Credentials issued before grant_generation existed bound to `generation`.
// The upgrade keeps exactly the currently valid ones valid.

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const LAST_BEFORE_GRANT_GENERATION = '0087_extension_runtime_probe_index';

async function migrationsBefore(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'retainer-migrations-'));
  await cp(MIGRATIONS, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  journal.entries = journal.entries.slice(0, last + 1);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

it('backfills grant_generation so current standalone credentials stay valid and stale ones stay revoked', async () => {
  const adminUrl = inject('adminDatabaseUrl');
  const name = `retainer_test_upgrade_${Math.random().toString(16).slice(2, 10)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: false });
  await admin.unsafe(`create database "${name}"`);
  const folder = await migrationsBefore(LAST_BEFORE_GRANT_GENERATION);
  const url = databaseUrl(adminUrl, name);
  const sql = postgres(url, { max: 1, onnotice: false });
  try {
    for (const extension of ['pg_trgm', 'btree_gin', 'unaccent']) {
      await sql.unsafe(`create extension if not exists ${extension}`);
    }
    await migrate(drizzle(sql), { migrationsFolder: folder });
    const [organization] =
      await sql`insert into organizations (name) values ('Default') returning id`;
    const [workspace] = await sql`insert into workspaces (slug, name, organization_id)
      values ('acme', 'Acme', ${organization?.id}) returning id`;
    const installation = randomUUID();
    await sql`insert into extension_installations
      (id,workspace_id,registration_id,version,release_digest,state,generation,granted_actor,granted_scopes,created_by)
      values(${installation},${workspace?.id},${randomUUID()},'1.0.0',${'d'.repeat(64)},'active',5,'integration',
        ${JSON.stringify(['read', 'write'])}::jsonb,${JSON.stringify({ type: 'user', id: 'admin' })}::jsonb)`;
    const key = async (generation: number, hash: string) =>
      sql`insert into extension_credentials(workspace_id,installation_id,generation,kind,key_hash,prefix,scopes,created_by)
        values(${workspace?.id},${installation},${generation},'key',${hash},'rti_prefix',${JSON.stringify(['read'])}::jsonb,
          ${JSON.stringify({ type: 'user', id: 'admin' })}::jsonb)`;
    await key(5, 'c'.repeat(64));
    await key(3, 'e'.repeat(64));

    await runMigrations(url);

    const [row] =
      await sql`select generation,grant_generation from extension_installations where id=${installation}`;
    expect(row).toEqual({ generation: 5, grant_generation: 5 });
    expect(
      await sql`select installation_id,generation from retainer_lookup_extension_key(${'c'.repeat(64)})`,
    ).toEqual([{ installation_id: installation, generation: 5 }]);
    expect(await sql`select 1 from retainer_lookup_extension_key(${'e'.repeat(64)})`).toHaveLength(
      0,
    );
    // Release changes no longer touch the grant binding.
    await sql`update extension_installations set generation=generation+1 where id=${installation}`;
    expect(await sql`select 1 from retainer_lookup_extension_key(${'c'.repeat(64)})`).toHaveLength(
      1,
    );
  } finally {
    await sql.end();
    await rm(folder, { recursive: true, force: true });
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
  }
});
