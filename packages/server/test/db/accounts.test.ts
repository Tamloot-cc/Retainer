import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_ROLE, type Sql } from '../../src/db/client.js';
import { getWorkspace } from '../../src/db/workspaces.js';
import { runCli } from '../../src/operator/commands.js';
import {
  createOrganization,
  lockWorkspaceOrganization,
  moveWorkspace,
  setOrganizationMember,
  setWorkspaceMember,
} from '../../src/workspaces/organizations.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';

// Accounts data model (accounts spec 4.2, 4.9, 8): who can reach the account
// tables, the composite foreign keys, the last-owner rule and the CLI.

const db = useTestDatabase();
const CONTROL_ROLE = 'retainer_control';

const ACCOUNT_TABLES = [
  'users',
  'sessions',
  'auth_accounts',
  'auth_verifications',
  'passkeys',
  'auth_rate_limits',
  'organizations',
  'organization_members',
  'workspace_members',
  'invitations',
  'jwks',
  'oauth_clients',
  'oauth_resources',
  'oauth_client_resources',
  'oauth_refresh_tokens',
  'oauth_access_tokens',
  'oauth_consents',
  'oauth_client_assertions',
];

async function addUser(email: string, name = email.split('@')[0] ?? email) {
  const id = randomUUID();
  await db.owner`
    insert into users (id, name, email, email_verified) values (${id}, ${name}, ${email}, true)`;
  return id;
}

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    sql: db.owner,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('who can reach the account tables', () => {
  let runtime: Sql;
  let control: Sql;

  beforeAll(() => {
    runtime = db.connect({ role: RUNTIME_ROLE, max: 1 });
    control = db.connect({ role: CONTROL_ROLE, max: 1 });
  });

  it('keeps them under row-level security, with nothing for the runtime role', async () => {
    const rows = await db.owner<{ table: string; rls: boolean; runtime: boolean }[]>`
      select c.relname as table, c.relrowsecurity as rls,
        has_table_privilege(${RUNTIME_ROLE}, c.oid, 'select, insert, update, delete') as runtime
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${ACCOUNT_TABLES})`;
    expect(rows.map((r) => r.table).sort()).toEqual([...ACCOUNT_TABLES].sort());
    for (const row of rows) expect(row, row.table).toMatchObject({ rls: true, runtime: false });
    for (const table of ACCOUNT_TABLES) {
      await expect(runtime.unsafe(`select 1 from ${table}`), table).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('gives the control role account work and nothing more', async () => {
    const [role] = await db.owner`
      select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
      from pg_roles where rolname = ${CONTROL_ROLE}`;
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: false,
    });
    const owned = await db.owner`
      select 1 from pg_class where relowner = ${CONTROL_ROLE}::regrole`;
    expect(owned).toHaveLength(0);

    const denied = { code: '42501' };
    await expect(control`create table intruder (id int)`).rejects.toMatchObject(denied);
    await expect(control`alter table users add column intruder int`).rejects.toMatchObject(denied);
    // Tenant data only through SET ROLE, never directly.
    await expect(control`select 1 from records`).rejects.toMatchObject(denied);
    await expect(control`update workspaces set schema_version = 9`).rejects.toMatchObject(denied);
    await expect(control`update api_keys set scopes = '{admin}'`).rejects.toMatchObject(denied);

    const workspace = await createWorkspace(db.owner, { name: 'Control', template: 'sales' });
    const seen = await control`select id from workspaces where id = ${workspace.id}`;
    expect(seen).toHaveLength(1);
    const objects = await control.begin(async (tx) => {
      await tx`set local role retainer_app`;
      await tx`select set_config('app.workspace_id', ${workspace.id}, true)`;
      return tx`select 1 from object_types`;
    });
    expect(objects.length).toBeGreaterThan(0);
  });

  it('lets the control role switch to the runtime role but not inherit it', async () => {
    const [membership] = await db.owner`
      select m.inherit_option, m.set_option from pg_auth_members m
      where m.member = ${CONTROL_ROLE}::regrole and m.roleid = ${RUNTIME_ROLE}::regrole`;
    expect(membership).toEqual({ inherit_option: false, set_option: true });
  });
});

describe('organizations and members', () => {
  it('moves new workspaces into Default, created once', async () => {
    const [a, b] = await Promise.all([
      createWorkspace(db.owner, { name: 'Default A' }),
      createWorkspace(db.owner, { name: 'Default B' }),
    ]);
    expect(a.organizationId).toBe(b.organizationId);
    const defaults = await db.owner`select 1 from organizations where name = 'Default'`;
    expect(defaults).toHaveLength(1);
  });

  it('gives a workspace role only to members of its organization', async () => {
    const org = await createOrganization(db.owner, { name: 'Acme' });
    const workspace = await createWorkspace(db.owner, { name: 'Acme Sales', organization: org.id });
    const dana = await addUser('dana@acme.test');

    await expect(
      setWorkspaceMember(db.owner, {
        workspace: workspace.id,
        email: 'dana@acme.test',
        role: 'editor',
      }),
    ).rejects.toThrow("is not in this workspace's organization");
    // The foreign key holds even when application code is skipped.
    await expect(
      db.owner`insert into workspace_members (organization_id, workspace_id, user_id, role)
        values (${org.id}, ${workspace.id}, ${dana}, 'editor')`,
    ).rejects.toMatchObject({ code: '23503' });

    await setOrganizationMember(db.owner, {
      organization: org.id,
      email: 'Dana@Acme.test',
      role: 'member',
    });
    await setWorkspaceMember(db.owner, {
      workspace: workspace.slug,
      email: 'dana@acme.test',
      role: 'editor',
    });

    // Leaving the organization removes the workspace role in the same statement.
    await db.owner`delete from organization_members where user_id = ${dana}`;
    const left = await db.owner`select 1 from workspace_members where user_id = ${dana}`;
    expect(left).toHaveLength(0);
  });

  it('never deletes an organization that still has workspaces', async () => {
    const org = await createOrganization(db.owner, { name: 'Keeps' });
    await createWorkspace(db.owner, { name: 'Kept', organization: org.id });
    // ON DELETE RESTRICT: Postgres 18 reports restrict_violation, not foreign_key_violation.
    await expect(db.owner`delete from organizations where id = ${org.id}`).rejects.toMatchObject({
      code: '23001',
    });
  });

  it('keeps an owner once there is one, even when two owners demote each other at once', async () => {
    const org = await createOrganization(db.owner, { name: 'Two owners' });
    await addUser('ann@two.test');
    await addUser('ben@two.test');
    for (const email of ['ann@two.test', 'ben@two.test']) {
      await setOrganizationMember(db.owner, { organization: org.id, email, role: 'owner' });
    }
    const other = db.connect({ max: 1 });
    const results = await Promise.allSettled([
      setOrganizationMember(db.owner, {
        organization: org.id,
        email: 'ann@two.test',
        role: 'member',
      }),
      setOrganizationMember(other, { organization: org.id, email: 'ben@two.test', role: 'member' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [rejected] = results.filter((r) => r.status === 'rejected');
    expect(String((rejected as PromiseRejectedResult).reason)).toContain('always keeps an owner');
    const owners = await db.owner`
      select 1 from organization_members where organization_id = ${org.id} and role = 'owner'`;
    expect(owners).toHaveLength(1);
  });

  it('locks the organization a workspace moved to while the lock was awaited', async () => {
    const from = await createOrganization(db.owner, { name: 'Left' });
    const to = await createOrganization(db.owner, { name: 'Joined' });
    const workspace = await createWorkspace(db.owner, { name: 'Wandering', organization: from.id });
    // True when another transaction holds the organization's lock.
    const isLocked = async (organizationId: string) => {
      try {
        await db.owner.begin(
          (tx) => tx`select 1 from organizations where id = ${organizationId} for update nowait`,
        );
        return false;
      } catch (error) {
        if ((error as { code?: string }).code === '55P03') return true;
        throw error;
      }
    };
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waiter: Promise<string | null> | undefined;
    // A move held open, the way moveWorkspace does it, while the lock is asked for.
    await db.owner.begin(async (move) => {
      await move`select 1 from organizations where id = ${from.id} for update`;
      await move`update workspaces set organization_id = ${to.id} where id = ${workspace.id}`;
      waiter = db.owner.begin(async (tx) => {
        const locked = await lockWorkspaceOrganization(tx, workspace.id);
        await held;
        return locked;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    let followed = false;
    for (let i = 0; i < 40 && !followed; i++) {
      followed = await isLocked(to.id);
      if (!followed) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();
    expect(await waiter).toBe(to.id);
    expect(followed).toBe(true);
  });

  it('checks membership in the organization a workspace moved to at the same moment', async () => {
    const from = await createOrganization(db.owner, { name: 'Before' });
    const to = await createOrganization(db.owner, { name: 'After' });
    const workspace = await createWorkspace(db.owner, { name: 'Shifting', organization: from.id });
    await addUser('fay@before.test');
    await setOrganizationMember(db.owner, {
      organization: from.id,
      email: 'fay@before.test',
      role: 'member',
    });
    let adding: Promise<unknown> | undefined;
    // A move held open, the way moveWorkspace does it, while the role is given.
    await db.owner.begin(async (move) => {
      await move`select 1 from organizations where id = ${from.id} for update`;
      await move`update workspaces set organization_id = ${to.id} where id = ${workspace.id}`;
      adding = setWorkspaceMember(db.owner, {
        workspace: workspace.id,
        email: 'fay@before.test',
        role: 'editor',
      }).catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    // Fay is in the organization the workspace left, not the one it joined.
    expect(await adding).toMatchObject({ status: 409, code: 'not_a_member' });
    expect(
      await db.owner`select 1 from workspace_members where user_id in
      (select id from users where email = 'fay@before.test')`,
    ).toHaveLength(0);
  });

  it('removes member roles when a workspace moves to another organization', async () => {
    const from = await createOrganization(db.owner, { name: 'From' });
    const to = await createOrganization(db.owner, { name: 'To' });
    const workspace = await createWorkspace(db.owner, { name: 'Moving', organization: from.id });
    await addUser('eve@from.test');
    await setOrganizationMember(db.owner, {
      organization: from.id,
      email: 'eve@from.test',
      role: 'member',
    });
    await setWorkspaceMember(db.owner, {
      workspace: workspace.id,
      email: 'eve@from.test',
      role: 'viewer',
    });

    const moved = await moveWorkspace(db.owner, { workspace: workspace.slug, organization: to.id });
    expect(moved.removedMembers).toBe(1);
    expect((await getWorkspace(db.owner, workspace.id)).organizationId).toBe(to.id);
  });
});

describe('the CLI', () => {
  it('creates organizations, adds the first owner and lists them', async () => {
    const created = await cli('org', 'create', '--name', 'Northwind', '--json');
    expect(created.code).toBe(0);
    const { id } = JSON.parse(created.out) as { id: string };

    expect((await cli('org', 'list')).out).toMatch(
      new RegExp(`${id}\\tNorthwind\\t0 workspace\\(s\\)\\t0 member\\(s\\)\\tno owner`),
    );

    const missing = await cli(
      'member',
      'add',
      '--org',
      id,
      '--email',
      'nobody@x.test',
      '--role',
      'owner',
    );
    expect(missing).toMatchObject({ code: 1, err: expect.stringContaining('has signed in yet') });

    await addUser('olga@northwind.test');
    const added = await cli(
      'member',
      'add',
      '--org',
      'Northwind',
      '--email',
      'olga@northwind.test',
      '--role',
      'owner',
    );
    expect(added).toMatchObject({
      code: 0,
      out: 'olga@northwind.test is now owner of "Northwind".',
    });

    const workspace = await cli(
      'workspace',
      'create',
      '--name',
      'Northwind CRM',
      '--org',
      id,
      '--json',
    );
    expect(JSON.parse(workspace.out)).toMatchObject({ organizationId: id });

    const badRole = await cli(
      'member',
      'add',
      '--org',
      id,
      '--email',
      'olga@northwind.test',
      '--role',
      'boss',
    );
    expect(badRole).toMatchObject({
      code: 1,
      err: expect.stringContaining('owner, admin or member'),
    });
  });

  it('refuses a name two organizations share', async () => {
    await cli('org', 'create', '--name', 'Twin');
    await cli('org', 'create', '--name', 'Twin');
    const result = await cli('workspace', 'create', '--name', 'Twin CRM', '--org', 'Twin');
    expect(result).toMatchObject({ code: 1, err: expect.stringContaining('use its ID') });
  });
});
