import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { expect, inject, it } from 'vitest';
import { createSql } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { inWorkspace } from '../../src/db/tx.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { databaseUrl, useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const migrations = fileURLToPath(new URL('../../drizzle', import.meta.url));
it('preserves existing person grants and bootstraps concurrent/new workspaces before switching OAuth foreign keys', async () => {
  const adminUrl = inject('adminDatabaseUrl'),
    name = `retainer_test_oauth_upgrade_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: false });
  await admin.unsafe(`create database "${name}"`);
  const url = databaseUrl(adminUrl, name),
    folder = await mkdtemp(join(tmpdir(), 'retainer-oauth-migrations-'));
  const sql = createSql(url, { max: 1 }),
    watcher = postgres(url, { max: 1, onnotice: false });
  try {
    await cp(migrations, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json'),
      journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const last = journal.entries.findIndex(
      (e: { tag: string }) => e.tag === '0076_standalone_credential_security',
    );
    expect(last).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, last + 1);
    await writeFile(journalPath, JSON.stringify(journal));
    const migrator = postgres(url, { max: 1, onnotice: false });
    try {
      for (const extension of ['pg_trgm', 'btree_gin', 'unaccent'])
        await migrator.unsafe(`create extension if not exists ${extension}`);
      await migrate(drizzle(migrator), { migrationsFolder: folder });
    } finally {
      await migrator.end();
    }
    const workspace = await createWorkspace(sql, { name: 'Legacy OAuth' });
    const [user] =
      await sql`insert into users(name,email) values('Legacy','legacy@example.test') returning id`;
    await sql`insert into oauth_clients(client_id,redirect_uris) values('legacy-client',array['https://app.example/callback'])`;
    await sql`insert into oauth_consents(client_id,user_id,reference_id,scopes,created_at,updated_at)
      values('legacy-client',${user?.id},${workspace.id},array['read'],clock_timestamp(),clock_timestamp())`;
    await sql`insert into oauth_refresh_tokens(token,client_id,user_id,reference_id,expires_at,created_at,scopes)
      values('hashed-refresh','legacy-client',${user?.id},${workspace.id},clock_timestamp()+interval '1 day',clock_timestamp(),array['read'])`;
    await sql`insert into oauth_access_tokens(token,client_id,user_id,reference_id,expires_at,created_at,scopes)
      values('hashed-access','legacy-client',${user?.id},${workspace.id},clock_timestamp()+interval '1 hour',clock_timestamp(),array['read'])`;
    const before = await sql`select id,reference_id,scopes from oauth_consents`;
    let entered: () => void = () => {},
      release: () => void = () => {};
    const ready = new Promise<void>((r) => {
        entered = r;
      }),
      barrier = new Promise<void>((r) => {
        release = r;
      });
    const concurrent = sql.begin(async (tx) => {
      const [inserted] = await tx`insert into workspaces(organization_id,slug,name)
        select organization_id,'concurrent','Concurrent' from workspaces where id=${workspace.id} returning id`;
      entered();
      await barrier;
      return inserted?.id as string;
    });
    await ready;
    let finished = false;
    const upgrade = runMigrations(url).then(() => {
      finished = true;
    });
    try {
      let waiting = false;
      for (let n = 0; n < 100; n++) {
        const [lock] =
          await watcher`select count(*)::int as count from pg_locks where relation='workspaces'::regclass and not granted`;
        if (Number(lock?.count) > 0) {
          waiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(waiting).toBe(true);
      expect(finished).toBe(false);
    } finally {
      release();
    }
    const [concurrentId] = await Promise.all([concurrent, upgrade]);
    expect(await sql`select id,reference_id,scopes from oauth_consents`).toEqual(before);
    expect((await sql`select token,reference_id from oauth_refresh_tokens`)[0]).toMatchObject({
      token: 'hashed-refresh',
      reference_id: workspace.id,
    });
    expect((await sql`select token,reference_id from oauth_access_tokens`)[0]).toMatchObject({
      token: 'hashed-access',
      reference_id: workspace.id,
    });
    expect(
      await sql`select id,workspace_id,kind from oauth_grant_references where id=${concurrentId}`,
    ).toEqual([{ id: concurrentId, workspace_id: concurrentId, kind: 'person' }]);
    const fresh = await createWorkspace(sql, { name: 'After migration' });
    expect((await sql`select kind from oauth_grant_references where id=${fresh.id}`)[0]?.kind).toBe(
      'person',
    );
    await sql`delete from workspaces where id=${workspace.id}`;
    expect(await sql`select 1 from oauth_consents`).toHaveLength(0);
    expect(await sql`select 1 from oauth_refresh_tokens`).toHaveLength(0);
    expect(await sql`select 1 from oauth_access_tokens`).toHaveLength(0);
  } finally {
    await sql.end();
    await watcher.end();
    await rm(folder, { recursive: true, force: true });
    await admin.unsafe(`drop database if exists "${name}" with(force)`);
    await admin.end();
  }
});

it('allows only tenant-matched installation references and keeps person references hidden from the runtime role', async () => {
  const a = await createWorkspace(db.owner, { name: 'Refs A' }),
    b = await createWorkspace(db.owner, { name: 'Refs B' });
  const app = db.connect({ role: 'retainer_app' }),
    control = db.connect({ role: 'retainer_control' }),
    registration = randomUUID();
  const [installation] =
    await db.owner`insert into extension_installations(workspace_id,registration_id,version,release_digest,state,granted_actor,granted_scopes,created_by)
    values(${a.id},${registration},'1.0.0',${'a'.repeat(64)},'active','integration','["read"]'::jsonb,'{"type":"user","id":"admin"}'::jsonb) returning id`;
  const clientId = `client-${randomUUID()}`;
  await db.owner`insert into oauth_clients(client_id,redirect_uris) values(${clientId},array['https://app.example/callback'])`;
  const [credential] = await inWorkspace(app, a.id, async (tx) => {
    const [c] =
      await tx`insert into extension_credentials(workspace_id,installation_id,generation,kind,client_id,subject_id,scopes,created_by)
      values(${a.id},${installation?.id},1,'oauth',${clientId},${randomUUID()},'["read"]'::jsonb,'{"type":"user","id":"admin"}'::jsonb) returning id`;
    if (!c) throw new Error('missing credential');
    await tx`insert into oauth_grant_references(id,workspace_id,kind,credential_id) values(${c.id},${a.id},'installation',${c.id})`;
    return [c];
  });
  const visible = await inWorkspace(
    app,
    a.id,
    (tx) => tx`select id,kind from oauth_grant_references`,
  );
  expect(visible).toEqual([{ id: credential?.id, kind: 'installation' }]);
  expect(
    await inWorkspace(app, b.id, (tx) => tx`select id from oauth_grant_references`),
  ).toHaveLength(0);
  await expect(
    inWorkspace(
      app,
      a.id,
      (tx) => tx`insert into oauth_grant_references(id,workspace_id,kind,credential_id)
    values(${randomUUID()},${a.id},'person',null)`,
    ),
  ).rejects.toMatchObject({ code: '42501' });
  const [unreferenced] =
    await db.owner`insert into extension_credentials(workspace_id,installation_id,generation,kind,client_id,subject_id,scopes,created_by)
    values(${a.id},${installation?.id},1,'oauth',${clientId},${randomUUID()},'["read"]'::jsonb,'{"type":"user","id":"admin"}'::jsonb) returning id`;
  await expect(
    inWorkspace(
      app,
      b.id,
      (tx) => tx`insert into oauth_grant_references(id,workspace_id,kind,credential_id)
    values(${unreferenced?.id},${b.id},'installation',${unreferenced?.id})`,
    ),
  ).rejects.toMatchObject({ code: '23503' });
  expect(
    await inWorkspace(
      app,
      a.id,
      (tx) => tx`delete from oauth_grant_references where id=${a.id} returning id`,
    ),
  ).toHaveLength(0);
  expect(
    (await control`select * from retainer_oauth_reference(${credential?.id}::uuid)`)[0],
  ).toMatchObject({ workspace_id: a.id, kind: 'installation', active: true, client_id: clientId });
  await expect(
    app`select * from retainer_oauth_reference(${credential?.id}::uuid)`,
  ).rejects.toMatchObject({ code: '42501' });
  await db.owner`delete from extension_credentials where id=${credential?.id}`;
  expect(
    await db.owner`select id from oauth_grant_references where credential_id=${credential?.id}`,
  ).toHaveLength(0);
});
