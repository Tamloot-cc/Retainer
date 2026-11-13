import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it } from 'vitest';
import { createSql, RUNTIME_ROLE } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { inWorkspace } from '../../src/db/tx.js';
import { SecretCipher } from '../../src/extension-runtime/secrets.js';
import { databaseUrl, useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();
const actor = { type: 'user', id: 'member', name: 'Dana' };
const digest = 'a'.repeat(64);

async function installation(workspace?: string) {
  const ws = workspace ?? randomUUID();
  if (!workspace) {
    await db.owner`insert into organizations(id,name) values(${ws},'Connection schema')`;
    await db.owner`insert into workspaces(id,organization_id,name,slug) values(${ws},${ws},'Connection schema',${ws})`;
  }
  const [row] = await db.owner`insert into extension_installations
    (workspace_id,registration_id,version,release_digest,granted_actor,granted_scopes,created_by)
    values(${ws},${randomUUID()},'1.0.0',${digest},'integration','["read","write"]',${db.owner.json(actor)}) returning id`;
  if (!row) throw new Error('installation missing');
  return { workspace: ws, id: row.id as string };
}
async function connection(i: { workspace: string; id: string }, owner = actor.id) {
  const [row] =
    await db.owner`insert into extension_connections(workspace_id,installation_id,owner_id,owner)
    values(${i.workspace},${i.id},${owner},${db.owner.json({ ...actor, id: owner })}) returning id`;
  if (!row) throw new Error('connection missing');
  return row.id as string;
}

describe('member connection persistence on real Postgres', () => {
  it('enforces one live connection per owner when connects race, retaining disconnected provenance', async () => {
    const i = await installation();
    const results = await Promise.allSettled([connection(i), connection(i)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason.code).toBe('23505');
    await db.owner`update extension_connections set state='disconnected' where installation_id=${i.id}`;
    await connection(i);
    expect(
      await db.owner`select id from extension_connections where installation_id=${i.id}`,
    ).toHaveLength(2);
  });

  it('isolates KV by connection and rejects a connection belonging to another installation or tenant', async () => {
    const i = await installation(),
      c1 = await connection(i),
      c2 = await connection(i, 'second');
    for (const c of [null, c1, c2])
      await db.owner`insert into extension_kv(workspace_id,installation_id,connection_id,key,value)
        values(${i.workspace},${i.id},${c},'cursor',${db.owner.json(c ?? 'workspace')})`;
    expect(await db.owner`select key from extension_kv where installation_id=${i.id}`).toHaveLength(
      3,
    );
    await expect(db.owner`insert into extension_kv(workspace_id,installation_id,key,value)
      values(${i.workspace},${i.id},'cursor','null')`).rejects.toMatchObject({ code: '23505' });
    const other = await installation(i.workspace),
      foreign = await installation();
    for (const target of [other, foreign])
      await expect(db.owner`insert into extension_kv(workspace_id,installation_id,connection_id,key,value)
        values(${target.workspace},${target.id},${c1},'cursor','null')`).rejects.toMatchObject({
        code: '23503',
      });
    const app = db.connect({ role: RUNTIME_ROLE, max: 1 });
    expect(
      await inWorkspace(app, foreign.workspace, (tx) => tx`select id from extension_connections`),
    ).toHaveLength(0);
    expect(
      await inWorkspace(app, i.workspace, (tx) => tx`select id from extension_connections`),
    ).toHaveLength(2);
    await expect(
      inWorkspace(app, i.workspace, (tx) => tx`select envelope from extension_secrets`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('checks owner identity and job connection generations without SQL null escaping the checks', async () => {
    const i = await installation(),
      c = await connection(i);
    for (const owner of [{}, { type: 'agent', id: 'bad' }, { type: 'user', id: 'wrong' }])
      await expect(db.owner`insert into extension_connections(workspace_id,installation_id,owner_id,owner)
        values(${i.workspace},${i.id},'bad',${db.owner.json(owner)})`).rejects.toMatchObject({
        code: '23514',
      });
    for (const [cid, generation] of [
      [c, null],
      [c, 0],
      [null, 1],
    ] as const)
      await expect(db.owner`insert into extension_jobs
        (workspace_id,installation_id,connection_id,connection_generation,generation,release_digest,function_id,input,input_hash,dedupe_key)
        values(${i.workspace},${i.id},${cid},${generation},1,${digest},${randomUUID()},'{}','hash',${randomUUID()})`).rejects.toMatchObject(
        { code: '23514' },
      );
  });

  it('has one running slot per connection and a separate workspace slot, with generation-scoped dedupe', async () => {
    const i = await installation(),
      c1 = await connection(i),
      c2 = await connection(i, 'second');
    const insert = (
      cid: string | null,
      generation: number | null,
      status = 'running',
    ) => db.owner`insert into extension_jobs
      (workspace_id,installation_id,connection_id,connection_generation,generation,release_digest,function_id,input,input_hash,dedupe_key,status)
      values(${i.workspace},${i.id},${cid},${generation},1,${digest},${randomUUID()},'{}','hash','same',${status})`;
    await Promise.all([insert(null, null), insert(c1, 1), insert(c2, 1)]);
    await expect(insert(c1, 2)).rejects.toMatchObject({ code: '23505' });
    await expect(insert(c1, 1, 'queued')).rejects.toMatchObject({ code: '23505' });
    await insert(c1, 2, 'queued');
    expect(
      await db.owner`select id from extension_jobs where installation_id=${i.id}`,
    ).toHaveLength(4);
  });

  it('prevents sharing one verified provider account across two live connections and cascades workspace purge', async () => {
    const i = await installation(),
      c1 = await connection(i),
      c2 = await connection(i, 'second');
    const [account] =
      await db.owner`insert into source_accounts(workspace_id,registration_id,provider,namespace,identity)
      values(${i.workspace},${randomUUID()},'fixture','namespace','provider-user') returning id`;
    if (!account) throw new Error('account missing');
    const bind = (
      cid: string,
    ) => db.owner`insert into source_bindings(workspace_id,installation_id,connection_id,account_id,generation)
      values(${i.workspace},${i.id},${cid},${account.id},1)`;
    const results = await Promise.allSettled([bind(c1), bind(c2)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await db.owner`delete from workspaces where id=${i.workspace}`;
    expect(
      await db.owner`select id from extension_connections where workspace_id=${i.workspace}`,
    ).toHaveLength(0);
    expect(
      await db.owner`select account_id from source_bindings where workspace_id=${i.workspace}`,
    ).toHaveLength(0);
  });

  it('upgrades populated workspace scopes without losing primary-key data or ciphertext', async () => {
    // Build the previous schema from its unchanged journal, then use the real
    // migrator. This exercises an upgrade, not merely an empty latest schema.
    const folder = await mkdtemp(join(tmpdir(), 'retainer-member-migration-'));
    const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8'));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 99);
    await cp(join(migrations, 'meta'), join(folder, 'meta'), { recursive: true });
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      await cp(join(migrations, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    const name = `retainer_member_upgrade_${randomUUID().replaceAll('-', '')}`;
    await db.owner.unsafe(`create database "${name}"`);
    const url = databaseUrl(db.url, name),
      sql = createSql(url, { max: 1 });
    try {
      for (const extension of ['pg_trgm', 'btree_gin', 'unaccent'])
        await sql.unsafe(`create extension ${extension}`);
      const migrationSql = createSql(url, { max: 1 });
      try {
        await migrate(drizzle(migrationSql), { migrationsFolder: folder });
      } finally {
        await migrationSql.end();
      }
      const workspace = randomUUID(),
        id = randomUUID(),
        registration = randomUUID(),
        account = randomUUID(),
        fn = randomUUID();
      const identity = {
        workspaceId: workspace,
        installationId: id,
        registrationId: registration,
        name: 'apiKey',
      };
      const cipher = new SecretCipher('test', new Map([['test', Buffer.alloc(32, 1)]]));
      const envelope = cipher.encrypt('retained-credential', identity);
      await sql`insert into organizations(id,name) values(${workspace},'Old organization')`;
      await sql`insert into workspaces(id,organization_id,name,slug) values(${workspace},${workspace},'Old workspace',${workspace})`;
      await sql`insert into extension_installations(id,workspace_id,registration_id,version,release_digest,granted_actor,granted_scopes,created_by)
        values(${id},${workspace},${registration},'1.0.0',${digest},'integration','["read","write"]',${sql.json(actor)})`;
      await sql`insert into extension_kv(workspace_id,installation_id,key,value,revision) values(${workspace},${id},'cursor','"before"',9)`;
      await sql`insert into extension_secrets(workspace_id,installation_id,name,envelope,revision) values(${workspace},${id},'apiKey',${sql.json(envelope)},4)`;
      await sql`insert into extension_write_budgets(workspace_id,installation_id,window_start,count) values(${workspace},${id},now(),7)`;
      await sql`insert into extension_schedules(workspace_id,installation_id,function_id,next_due_at) values(${workspace},${id},${fn},now())`;
      await sql`insert into source_accounts(id,workspace_id,registration_id,provider,namespace,identity) values(${account},${workspace},${registration},'fixture','namespace','provider-user')`;
      await sql`insert into source_bindings(workspace_id,installation_id,account_id,generation) values(${workspace},${id},${account},1)`;
      await sql`insert into source_sync_state(workspace_id,installation_id,generation,scan_id,mode,lower_bound,upper_bound) values(${workspace},${id},1,${randomUUID()},'created',now(),now())`;
      await sql`insert into extension_jobs(workspace_id,installation_id,generation,release_digest,function_id,input,input_hash,dedupe_key) values(${workspace},${id},1,${digest},${fn},'{}','hash','before')`;
      await sql`insert into extension_pending_secrets(workspace_id,draft_installation_id,registration_id,name,envelope,created_by)
        values(${workspace},${id},${registration},'apiKey',${sql.json(envelope)},${sql.json(actor)})`;
      await runMigrations(url);
      for (const table of [
        'extension_kv',
        'extension_secrets',
        'extension_write_budgets',
        'extension_schedules',
        'source_bindings',
        'source_sync_state',
        'extension_jobs',
        'extension_pending_secrets',
      ]) {
        const rows = await sql.unsafe(`select connection_id from ${table} where workspace_id=$1`, [
          workspace,
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.connection_id).toBeNull();
      }
      const [secret] =
        await sql`select envelope,revision from extension_secrets where installation_id=${id}`;
      expect(secret?.revision).toBe(4);
      expect(cipher.decrypt(secret?.envelope, identity)).toBe('retained-credential');
      await sql`insert into extension_kv(workspace_id,installation_id,key,value) values(${workspace},${id},'cursor','"after"')
        on conflict(workspace_id,installation_id,connection_id,key) do update set value=excluded.value,revision=extension_kv.revision+1`;
      expect(
        (await sql`select value,revision from extension_kv where installation_id=${id}`)[0],
      ).toMatchObject({ value: 'after', revision: 10 });
      const [pending] =
        await sql`select id from extension_pending_secrets where draft_installation_id=${id}`;
      expect(
        await inWorkspace(
          sql,
          workspace,
          (tx) =>
            tx`select retainer_adopt_extension_secret(${pending?.id}::uuid,${id}::uuid,${registration}::uuid,'apiKey') as adopted`,
        ),
      ).toMatchObject([{ adopted: true }]);
    } finally {
      await sql.end();
      await db.owner.unsafe(`drop database if exists "${name}" with (force)`);
      await rm(folder, { recursive: true, force: true });
    }
  });
});
