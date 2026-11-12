import { createHash } from 'node:crypto';
import type { Actor } from '@retainer/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Caller } from '../../src/caller.js';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { logEventFor } from '../../src/memory/service.js';
import { createRecord } from '../../src/records/service.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();

/** Tables that hold rows private to one person (personal memory spec 4.2). */
const PRIVATE_TABLES = [
  'records',
  'facts',
  'fact_sources',
  'field_assertions',
  'event_records',
  'event_links',
  'idempotency_keys',
];

const TENANT_TABLES = [
  'object_types',
  'fields',
  'schema_changes',
  'records',
  'record_links',
  'record_identifiers',
  'event_records',
  'event_links',
  'event_identity_tombstones',
  'field_assertions',
  'facts',
  'fact_sources',
  'comments',
  'merge_suggestions',
  'idempotency_keys',
  'suppressions',
  'deletion_audit_log',
  'views',
  'workspace_request_counts',
];

let app: Sql;
let workspaceA: string;
let workspaceB: string;

beforeAll(async () => {
  app = db.connect({ role: RUNTIME_ROLE });
  const [organization] = await db.owner<{ id: string }[]>`
    insert into organizations (name) values ('Security') returning id`;
  const rows = await db.owner<{ id: string }[]>`
    insert into workspaces (organization_id, slug, name)
    values (${organization?.id ?? ''}, 'a', 'A'), (${organization?.id ?? ''}, 'b', 'B') returning id`;
  [workspaceA, workspaceB] = rows.map((r) => r.id) as [string, string];
});

describe('extensions', () => {
  it('has pg_trgm and btree_gin', async () => {
    const rows = await db.owner<{ extname: string }[]>`
      select extname from pg_extension where extname in ('pg_trgm', 'btree_gin') order by extname`;
    expect(rows.map((r) => r.extname)).toEqual(['btree_gin', 'pg_trgm']);
  });
});

describe('roles', () => {
  it('runs the app as a role that owns nothing and cannot bypass RLS', async () => {
    const [who] = await app<{ current_user: string }[]>`select current_user`;
    expect(who?.current_user).toBe(RUNTIME_ROLE);

    const [role] = await db.owner<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolbypassrls, rolsuper from pg_roles where rolname = ${RUNTIME_ROLE}`;
    expect(role).toEqual({ rolbypassrls: false, rolsuper: false });

    const owned = await db.owner`
      select tablename from pg_tables where schemaname = 'public' and tableowner = ${RUNTIME_ROLE}`;
    expect(owned).toHaveLength(0);
  });
});

describe('row-level security', () => {
  it('is enabled with a workspace policy on every tenant table', async () => {
    const rows = await db.owner<
      { tablename: string; rowsecurity: boolean; policies: number; restrictive: string[] }[]
    >`
      select t.tablename, t.rowsecurity,
        (select count(*)::int from pg_policies p
          where p.schemaname = 'public' and p.tablename = t.tablename
            and p.roles = '{public}' and p.permissive = 'PERMISSIVE') as policies,
        array(select p.policyname::text from pg_policies p
          where p.schemaname = 'public' and p.tablename = t.tablename
            and p.roles = '{public}' and p.permissive = 'RESTRICTIVE'
          order by 1) as restrictive
      from pg_tables t where t.schemaname = 'public'`;
    const byTable = new Map(rows.map((r) => [r.tablename, r]));
    for (const table of [...TENANT_TABLES, 'workspaces']) {
      expect(byTable.get(table), table).toMatchObject({
        rowsecurity: true,
        policies: 1,
        // Personal memory (personal memory spec 4.2): one restrictive policy
        // on each table that holds private rows, and none elsewhere.
        restrictive: PRIVATE_TABLES.includes(table) ? ['private_to_user'] : [],
      });
    }
    // Every table with a workspace_id column is covered.
    const withWorkspace = await db.owner<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'workspace_id'`;
    for (const { table_name } of withWorkspace) {
      expect(byTable.get(table_name)?.rowsecurity, table_name).toBe(true);
    }
  });

  it('shows the runtime role only the workspace of the transaction', async () => {
    await db.owner`
      insert into suppressions (workspace_id, kind, hmac)
      values (${workspaceA}, 'email', 'a-1'), (${workspaceB}, 'email', 'b-1')`;

    const seenByA = await inWorkspace(app, workspaceA, (tx) => tx`select hmac from suppressions`);
    expect(seenByA.map((r) => r.hmac)).toEqual(['a-1']);

    const workspacesSeenByA = await inWorkspace(
      app,
      workspaceA,
      (tx) => tx`select id from workspaces`,
    );
    expect(workspacesSeenByA.map((r) => r.id)).toEqual([workspaceA]);

    // Outside a workspace transaction nothing is visible.
    expect(await app`select * from suppressions`).toHaveLength(0);
  });

  it('rejects writes into another workspace', async () => {
    await expect(
      inWorkspace(
        app,
        workspaceA,
        (tx) =>
          tx`insert into suppressions (workspace_id, kind, hmac) values (${workspaceB}, 'email', 'x')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('does not let the setting leak past the transaction', async () => {
    // One connection, so the second query runs where the transaction ran.
    const single = db.connect({ role: RUNTIME_ROLE, max: 1 });
    await inWorkspace(single, workspaceA, (tx) => tx`select 1`);
    expect(await single`select * from suppressions`).toHaveLength(0);
  });
});

let workspaces = 0;
/** A workspace with a schema, one event and one entity record, for the event tables. */
async function workspaceWithEvent() {
  const id = (
    await createWorkspace(db.owner, { name: `Events ${++workspaces}`, template: 'sales' })
  ).id;
  const caller: Caller = {
    workspaceId: id,
    actor: { type: 'agent', id: 'inbox' } satisfies Actor,
    scopes: ['read', 'write'],
  };
  const event = await logEventFor(app, caller, {
    type: 'conversation',
    channel: 'api',
    externalId: 'security-1',
    occurredAt: '2026-10-01T10:00:00Z',
    summary: 'hello',
    fields: {},
    participants: [],
    about: [],
  });
  const person = await createRecord(app, caller, 'person', { emails: 'dana@acme.com' });
  return { id, eventId: event.id, personId: person.id };
}

describe('tenant foreign keys', () => {
  it('rejects a reference to a row in another workspace', async () => {
    const other = await workspaceWithEvent();
    await expect(
      db.owner`
        insert into event_links (workspace_id, event_id, position, handle, link)
        values (${workspaceA}, ${other.eventId}, 0, 'dana@acme.com', 'participant')`,
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      db.owner`
        insert into event_links (workspace_id, event_id, position, record_id, link)
        values (${workspaceA}, ${other.eventId}, 0, ${other.personId}, 'about')`,
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('event records (0015)', () => {
  it('shows the runtime role only its own event rows and tombstones', async () => {
    const one = await workspaceWithEvent();
    const two = await workspaceWithEvent();
    await db.owner`
      insert into event_identity_tombstones (workspace_id, key_id, hmac)
      values (${one.id}, 'k', 'one-1'), (${two.id}, 'k', 'two-1')`;
    const seen = await inWorkspace(app, one.id, async (tx) => ({
      events: await tx<{ record_id: string }[]>`select record_id from event_records`,
      tombstones: await tx<{ hmac: string }[]>`select hmac from event_identity_tombstones`,
    }));
    expect(seen.events.map((r) => r.record_id)).toEqual([one.eventId]);
    expect(seen.tombstones.map((r) => r.hmac)).toEqual(['one-1']);
    await expect(
      inWorkspace(
        app,
        one.id,
        (tx) => tx`
          insert into event_identity_tombstones (workspace_id, key_id, hmac)
          values (${two.id}, 'k', 'x')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('never lets the runtime role change or remove a tombstone', async () => {
    const ws = await workspaceWithEvent();
    await inWorkspace(
      app,
      ws.id,
      (tx) => tx`
        insert into event_identity_tombstones (workspace_id, key_id, hmac)
        values (${ws.id}, 'k', 'kept')`,
    );
    for (const statement of [
      `update event_identity_tombstones set hmac = 'changed'`,
      'delete from event_identity_tombstones',
    ]) {
      await expect(inWorkspace(app, ws.id, (tx) => tx.unsafe(statement))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('gives event columns only to event records, and keeps them immutable', async () => {
    const ws = await workspaceWithEvent();
    await expect(
      db.owner`
        insert into event_records (workspace_id, record_id, occurred_at, channel)
        values (${ws.id}, ${ws.personId}, now(), 'api')`,
    ).rejects.toMatchObject({ code: '23514' });
    for (const change of [
      db.owner`update event_records set occurred_at = now() where record_id = ${ws.eventId}`,
      db.owner`update event_records set channel = 'other' where record_id = ${ws.eventId}`,
      db.owner`update event_records set external_id = 'other' where record_id = ${ws.eventId}`,
    ]) {
      await expect(change).rejects.toMatchObject({ code: '23514' });
    }
    // Erasure may clear the raw identity (2.1), and nothing can set it again.
    await db.owner`
      update event_records set channel = null, external_id = null where record_id = ${ws.eventId}`;
    await expect(
      db.owner`update event_records set channel = 'api' where record_id = ${ws.eventId}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an event record without its event columns at commit', async () => {
    const ws = await workspaceWithEvent();
    const [note] = await db.owner<{ id: string }[]>`
      select r.object_type_id as id from records r where r.id = ${ws.eventId}`;
    await expect(
      db.owner.begin(
        (tx) => tx`
          insert into records (workspace_id, object_type_id, created_by, updated_by)
          values (${ws.id}, ${note?.id ?? ''}, ${tx.json({ type: 'system', id: 'test' })},
            ${tx.json({ type: 'system', id: 'test' })})`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('API-key lookup', () => {
  const hash = (key: string) => createHash('sha256').update(key).digest('hex');

  beforeAll(async () => {
    await db.owner`
      insert into api_keys (workspace_id, name, prefix, hash, scopes, actor, revoked_at) values
        (${workspaceA}, 'live', 'rtn_live', ${hash('live-key')}, ${['read']},
          ${db.owner.json({ type: 'agent', id: 'bot' })}, null),
        (${workspaceA}, 'revoked', 'rtn_revk', ${hash('revoked-key')}, ${['read']},
          ${db.owner.json({ type: 'agent', id: 'old' })}, now())`;
  });

  it('denies the runtime role direct access to api_keys', async () => {
    await expect(app`select * from api_keys`).rejects.toMatchObject({ code: '42501' });
  });

  it('returns workspace, scopes and actor for a live key', async () => {
    const rows = await app`select * from retainer_lookup_api_key(${hash('live-key')})`;
    expect(rows).toEqual([
      {
        key_id: expect.any(String),
        workspace_id: workspaceA,
        scopes: ['read'],
        actor: { type: 'agent', id: 'bot' },
        acts_for_user: null,
        acts_for_name: null,
      },
    ]);
  });

  it('returns nothing for revoked or unknown keys', async () => {
    expect(await app`select * from retainer_lookup_api_key(${hash('revoked-key')})`).toHaveLength(
      0,
    );
    expect(await app`select * from retainer_lookup_api_key(${hash('nope')})`).toHaveLength(0);
  });

  it('is executable only by the runtime role', async () => {
    const grantees = await db.owner<{ grantee: string }[]>`
      select a.grantee::regrole::text as grantee
      from pg_proc p, aclexplode(p.proacl) a
      where p.proname = 'retainer_lookup_api_key' and a.privilege_type = 'EXECUTE'`;
    const names = grantees.map((g) => g.grantee);
    expect(names).toContain(RUNTIME_ROLE);
    expect(names).not.toContain('-'); // PUBLIC (grantee 0) shows as "-"
  });
});

describe('SECURITY DEFINER functions', () => {
  // Every way around RLS is listed here (ARCHITECTURE.md 7.2, accounts spec
  // 7.4). Adding one means adding it here, on purpose, with a review.
  const ALLOWED: Record<string, string | null> = {
    retainer_adopt_extension_secret: RUNTIME_ROLE,
    retainer_admit_secret_run: 'retainer_secret_broker',
    retainer_admit_webhook: 'retainer_secret_broker',
    retainer_webhook_candidate: RUNTIME_ROLE,
    retainer_erase_private_derivatives: RUNTIME_ROLE,
    retainer_extension_runtime_due: 'retainer_executor',
    retainer_extension_jobs_due: 'retainer_executor',
    retainer_extension_maintenance_due: 'retainer_executor',
    retainer_finish_extension_cleanup: RUNTIME_ROLE,
    retainer_extension_pending_secrets: RUNTIME_ROLE,
    retainer_extension_secret_names: RUNTIME_ROLE,
    retainer_extension_slot_available: RUNTIME_ROLE,
    retainer_file_maintenance_due: 'retainer_executor',
    retainer_extension_changes_due: 'retainer_executor',
    retainer_change_retention_due: 'retainer_executor',
    retainer_queue_file_deletion: null,
    retainer_lookup_api_key: RUNTIME_ROLE,
    retainer_lookup_extension_key: RUNTIME_ROLE,
    retainer_bootstrap_oauth_reference: null,
    retainer_oauth_reference: 'retainer_control',
    retainer_extension_oauth_client_active: RUNTIME_ROLE,
    retainer_retire_extension_secrets: RUNTIME_ROLE,
    retainer_session_access: RUNTIME_ROLE,
    retainer_token_access: RUNTIME_ROLE,
    retainer_token_keys: RUNTIME_ROLE,
    retainer_workspaces_due: RUNTIME_ROLE,
    retainer_workspace_extension_cleanup_pending: 'retainer_control',
  };

  it('exist only on the reviewed list, each fixing its search_path and execution role', async () => {
    const rows = await db.owner<{ name: string; config: string[] | null; grantees: string[] }[]>`
      select p.proname as name, p.proconfig as config,
        array(select a.grantee::regrole::text from aclexplode(p.proacl) a
          where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner) as grantees
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname = 'public'
      order by p.proname`;
    expect(rows.map((r) => r.name)).toEqual(Object.keys(ALLOWED).sort());
    for (const row of rows) {
      expect(row.config, row.name).toContain('search_path=pg_catalog, pg_temp');
      expect(row.grantees, row.name).toEqual(ALLOWED[row.name] ? [ALLOWED[row.name]] : []);
    }
  });
});
