import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspaceFor } from '../../src/accounts/people.js';
import { createApiKey } from '../../src/auth/keys.js';
import { CONTROL_ROLE, loadConfig } from '../../src/config.js';
import { createRuntimeSql, RUNTIME_ROLE } from '../../src/db/client.js';
import { scramVerifier, setRoleLogin, setRuntimeLogin } from '../../src/db/logins.js';
import { inWorkspace } from '../../src/db/tx.js';
import { createApiHandler } from '../../src/lambda/api.js';
import { createOpsHandler } from '../../src/lambda/ops.js';
import { createWorkspace } from '../../src/workspaces/workspaces.js';
import { useTestDatabase } from '../helpers/db.js';
import { context, httpEvent } from '../helpers/lambda.js';

// Credentials (accounts spec 4.9, 8): the API and workers log in as the
// runtime role itself and can never become the owner. The role is
// cluster-wide, so only this file gives it a login, and it takes it away
// again at the end.

const db = useTestDatabase();
let ownerRole: string;
let workspaceId: string;

function runtimeUrl(password: string) {
  const url = new URL(db.url);
  url.username = RUNTIME_ROLE;
  url.password = password;
  return url.toString();
}

const PASSWORD = 'runtime-test-password-1';

beforeAll(async () => {
  [{ ownerRole } = { ownerRole: '' }] = await db.owner<{ ownerRole: string }[]>`
    select current_user as "ownerRole"`;
  workspaceId = (await createWorkspace(db.owner, { name: 'Creds', template: 'sales' })).id;
  await setRuntimeLogin(db.owner, PASSWORD);
});

afterAll(async () => {
  await db.owner.unsafe(`alter role ${RUNTIME_ROLE} nologin password null`);
});

describe('the runtime login', () => {
  it('logs in as the runtime role, with no other role to become', async () => {
    const sql = db.connectUrl(runtimeUrl(PASSWORD));
    const [who] = await sql<{ user: string }[]>`select current_user as user`;
    expect(who?.user).toBe(RUNTIME_ROLE);
    const [flags] = await db.owner`
      select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      from pg_roles where rolname = ${RUNTIME_ROLE}`;
    expect(flags).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    const memberships = await db.owner`
      select 1 from pg_auth_members where member = ${RUNTIME_ROLE}::regrole`;
    expect(memberships).toHaveLength(0);
  });

  it('cannot become the owner', async () => {
    const sql = db.connectUrl(runtimeUrl(PASSWORD));
    await expect(sql.unsafe(`set role "${ownerRole}"`)).rejects.toMatchObject({ code: '42501' });
    await expect(sql.unsafe(`set session authorization "${ownerRole}"`)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('cannot change the schema', async () => {
    const sql = db.connectUrl(runtimeUrl(PASSWORD));
    const denied = { code: '42501' };
    await expect(sql`create table public.intruder (id int)`).rejects.toMatchObject(denied);
    await expect(sql`create schema intruder`).rejects.toMatchObject(denied);
    await expect(sql`alter table records add column intruder int`).rejects.toMatchObject(denied);
    await expect(sql`drop table records`).rejects.toMatchObject(denied);
    await expect(sql`alter table records disable row level security`).rejects.toMatchObject(denied);
  });

  it('stays under row-level security and cannot read keys', async () => {
    const sql = db.connectUrl(runtimeUrl(PASSWORD));
    const [none] = await sql<{ count: number }[]>`select count(*)::int as count from object_types`;
    expect(none?.count).toBe(0);
    const [own] = await inWorkspace(
      sql,
      workspaceId,
      (tx) => tx<{ count: number }[]>`select count(*)::int as count from object_types`,
    );
    expect(own?.count).toBeGreaterThan(0);
    await expect(sql`select * from api_keys`).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses the old password once a new one is set', async () => {
    await setRuntimeLogin(db.owner, 'runtime-test-password-2');
    await expect(db.connectUrl(runtimeUrl(PASSWORD))`select 1`).rejects.toMatchObject({
      code: '28P01',
    });
    await setRuntimeLogin(db.owner, PASSWORD);
    const [ok] = await db.connectUrl(runtimeUrl(PASSWORD))`select 1 as ok`;
    expect(ok?.ok).toBe(1);
  });

  it('serializes two owners setting it at once', async () => {
    const second = db.connect({ max: 1 });
    await Promise.all([
      setRuntimeLogin(db.owner, PASSWORD),
      setRuntimeLogin(second, PASSWORD),
      setRuntimeLogin(db.owner, PASSWORD),
    ]);
    const [ok] = await db.connectUrl(runtimeUrl(PASSWORD))`select 1 as ok`;
    expect(ok?.ok).toBe(1);
  });

  it('refuses a password it would have to normalize', async () => {
    await expect(setRuntimeLogin(db.owner, 'pass word')).rejects.toThrow('printable ASCII');
    await expect(setRuntimeLogin(db.owner, 'pässword')).rejects.toThrow('printable ASCII');
  });

  it('is not given while the runtime role can become another role', async () => {
    const extra = `retainer_runtime_test_${Math.random().toString(16).slice(2, 10)}`;
    await db.owner.unsafe(`create role ${extra} nologin`);
    try {
      await db.owner.unsafe(`grant ${extra} to ${RUNTIME_ROLE}`);
      await expect(setRuntimeLogin(db.owner, PASSWORD)).rejects.toThrow(
        `${RUNTIME_ROLE} is a member of ${extra}`,
      );
    } finally {
      await db.owner.unsafe(`drop role ${extra}`);
    }
  });

  // CREATEDB stands in for every attribute: it changes nothing for the test
  // files running alongside, which a cluster-wide BYPASSRLS would.
  it('is not given while the runtime role has a privileged attribute', async () => {
    await db.owner.unsafe(`alter role ${RUNTIME_ROLE} createdb`);
    try {
      await expect(setRuntimeLogin(db.owner, PASSWORD)).rejects.toThrow(
        `${RUNTIME_ROLE} has CREATEDB`,
      );
    } finally {
      await db.owner.unsafe(`alter role ${RUNTIME_ROLE} nocreatedb`);
    }
  });

  it('is not given while the runtime role owns something', async () => {
    await db.owner`create table runtime_owned (id int)`;
    await db.owner.unsafe(`alter table runtime_owned owner to ${RUNTIME_ROLE}`);
    try {
      await expect(setRuntimeLogin(db.owner, PASSWORD)).rejects.toThrow(
        `${RUNTIME_ROLE} owns 1 object(s) in this database`,
      );
    } finally {
      await db.owner`drop table runtime_owned`;
    }
  });
});

describe('functions on separate logins', () => {
  it('migrates with the owner, then serves the API with the runtime login alone', async () => {
    const ops = createOpsHandler(
      loadConfig({
        DATABASE_URL: db.url,
        RETAINER_RUNTIME_DATABASE_URL: runtimeUrl('runtime-test-password-3'),
        LOG_LEVEL: 'error',
      }),
    );
    expect(await ops({ command: 'migrate' })).toMatchObject({
      logins: { runtime: true, control: false },
    });

    const config = loadConfig({
      RETAINER_RUNTIME_DATABASE_URL: runtimeUrl('runtime-test-password-3'),
      LOG_LEVEL: 'error',
    });
    const sql = createRuntimeSql(config, { max: 1 });
    const [who] = await sql<{ user: string }[]>`select current_user as user`;
    expect(who?.user).toBe(RUNTIME_ROLE);

    const { key } = await createApiKey(db.owner, {
      workspace: workspaceId,
      name: 'Agent',
      actor: { type: 'agent', id: 'creds' },
      scopes: ['read'],
    });
    const api = createApiHandler(config, sql);
    const res = await api(
      httpEvent('GET', '/v1/me', { headers: { authorization: `Bearer ${key}` } }),
      context,
    );
    expect(res).toMatchObject({ statusCode: 200 });
    await sql.end();
    await setRuntimeLogin(db.owner, PASSWORD);
  });

  it('cannot run operator commands without the owner URL', () => {
    const config = loadConfig({
      RETAINER_RUNTIME_DATABASE_URL: runtimeUrl(PASSWORD),
      LOG_LEVEL: 'error',
    });
    expect(() => createOpsHandler(config)).toThrow('DATABASE_URL is required');
  });
});

describe('scramVerifier', () => {
  it('builds the verifier Postgres stores', () => {
    const salt = Buffer.alloc(16, 1);
    const verifier = scramVerifier('pencil', salt);
    expect(verifier).toMatch(
      /^SCRAM-SHA-256\$4096:AQEBAQEBAQEBAQEBAQEBAQ==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
    expect(scramVerifier('pencil', salt)).toBe(verifier);
  });
});

describe('the control login', () => {
  const password = 'control-test-password-1';
  let control: ReturnType<typeof db.connectUrl>;

  beforeAll(async () => {
    await setRoleLogin(db.owner, CONTROL_ROLE, password);
    const url = new URL(db.url);
    url.username = CONTROL_ROLE;
    url.password = password;
    control = db.connectUrl(url.toString());
  });

  afterAll(async () => {
    await db.owner.unsafe(`alter role ${CONTROL_ROLE} nologin password null`);
  });

  it('may switch to the runtime role, but read nothing itself or become the owner', async () => {
    const [who] = await control<{ user: string }[]>`select current_user as user`;
    expect(who?.user).toBe(CONTROL_ROLE);
    await expect(control`select 1 from records`).rejects.toMatchObject({ code: '42501' });
    await expect(control.unsafe(`set role "${ownerRole}"`)).rejects.toMatchObject({
      code: '42501',
    });
    await control.unsafe(`set role ${RUNTIME_ROLE}`);
    const [now] = await control<{ user: string }[]>`select current_user as user`;
    expect(now?.user).toBe(RUNTIME_ROLE);
    await control.unsafe('reset role');
  });

  // Logged in as the owner, SET ROLE is checked against the owner, so only a
  // real control login shows that its SET LOCAL ROLE seeding works (4.5, 4.9).
  it('creates and seeds a workspace, switching to the runtime role for the seed', async () => {
    const person = { id: randomUUID(), name: 'Seed', email: 'seed@example.com' };
    await db.owner`
      insert into users (id, name, email, email_verified)
      values (${person.id}, ${person.name}, ${person.email}, true)`;
    const workspace = await createWorkspaceFor(control, person, {
      name: 'Seeded',
      template: 'sales',
    });

    const objects = await db.owner<{ key: string }[]>`
      select name_singular as key from object_types where workspace_id = ${workspace.id}`;
    expect(objects.map((o) => o.key)).toEqual(
      expect.arrayContaining(['company', 'person', 'deal']),
    );
    const [membership] = await db.owner`
      select role from organization_members
      where organization_id = ${workspace.organizationId} and user_id = ${person.id}`;
    expect(membership).toEqual({ role: 'owner' });
    // The switch ended with the transaction.
    const [who] = await control<{ user: string }[]>`select current_user as user`;
    expect(who?.user).toBe(CONTROL_ROLE);
  });
});
