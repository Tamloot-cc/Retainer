import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import {
  CONTROL_ROLE,
  type Config,
  EXECUTOR_ROLE,
  passwordOf,
  SECRET_BROKER_ROLE,
} from '../config.js';
import { createSql, RUNTIME_ROLE, type Sql } from './client.js';

/** The roles a function may log in as, and the role each may switch to. */
const LOGIN_ROLES = {
  [RUNTIME_ROLE]: null,
  [SECRET_BROKER_ROLE]: null,
  [EXECUTOR_ROLE]: null,
  // Seeds a new workspace by switching to the runtime role, without
  // inheriting its privileges (drizzle/0027_accounts_security.sql).
  [CONTROL_ROLE]: RUNTIME_ROLE,
} as const;
type LoginRole = keyof typeof LOGIN_ROLES;

/**
 * Gives one of Retainer's roles a login (accounts spec 4.9), so each function
 * connects as its own role and its connections can never act as the owner.
 *
 * The password comes from the role's URL, and the migration role sets it on
 * every boot or migration, so rotating it means changing the URL and
 * redeploying. Roles are cluster-wide: the password is shared by every
 * database on the server.
 */
export async function setRoleLogin(owner: Sql, role: LoginRole, password: string): Promise<void> {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    // SCRAM normalizes non-ASCII passwords (SASLprep); keeping to printable
    // ASCII means the verifier below needs no normalization.
    throw new Error(`The ${role} password must be printable ASCII without spaces.`);
  }
  const verifier = scramVerifier(password);
  await owner.begin(async (tx) => {
    // Two containers booting at once would otherwise update the role row
    // concurrently, which Postgres refuses ("tuple concurrently updated").
    await tx`select pg_advisory_xact_lock(${LOGIN_LOCK})`;
    // A login for a role that is privileged, owns objects or can become
    // another role would defeat the point. The migrations only create the
    // roles when they are missing, so one made or altered by hand gets here.
    const problems = await roleProblems(tx, role);
    if (problems.length > 0) {
      throw new Error(`${role} ${problems.join('; ')}. Fix that before giving it a login.`);
    }
    // The verifier holds only base64, digits, `$` and `:`.
    await tx.unsafe(`alter role ${role} login password '${verifier}'`);
  });
}

/** `setRoleLogin` for the runtime role. */
export const setRuntimeLogin = (owner: Sql, password: string) =>
  setRoleLogin(owner, RUNTIME_ROLE, password);

/**
 * Sets the logins the config asks for (`setRoleLogin`). `owner` connects as
 * the migration role. Returns which it set.
 */
export async function applyLogins(
  config: Config,
  owner: Sql,
): Promise<{ runtime: boolean; control: boolean }> {
  const runtime = config.RETAINER_RUNTIME_DATABASE_URL;
  const control = config.RETAINER_CONTROL_DATABASE_URL;
  if (runtime) await setRoleLogin(owner, RUNTIME_ROLE, passwordOf(runtime));
  if (control) await setRoleLogin(owner, CONTROL_ROLE, passwordOf(control));
  if (config.RETAINER_SECRET_BROKER_DATABASE_URL)
    await setRoleLogin(
      owner,
      SECRET_BROKER_ROLE,
      passwordOf(config.RETAINER_SECRET_BROKER_DATABASE_URL),
    );
  if (config.RETAINER_EXECUTOR_DATABASE_URL)
    await setRoleLogin(owner, EXECUTOR_ROLE, passwordOf(config.RETAINER_EXECUTOR_DATABASE_URL));
  return { runtime: runtime !== undefined, control: control !== undefined };
}

/** What makes a role unsafe to log in as, in plain words. */
async function roleProblems(tx: TransactionSql, name: LoginRole): Promise<string[]> {
  const mayBecome = LOGIN_ROLES[name];
  const [role] = await tx<
    {
      attributes: string[];
      memberOf: string[];
      owns: number;
    }[]
  >`
    select
      array_remove(array[
        case when r.rolsuper then 'SUPERUSER' end,
        case when r.rolbypassrls then 'BYPASSRLS' end,
        case when r.rolcreaterole then 'CREATEROLE' end,
        case when r.rolcreatedb then 'CREATEDB' end,
        case when r.rolreplication then 'REPLICATION' end
      ], null) as attributes,
      array(
        select m.roleid::regrole::text from pg_auth_members m
        where m.member = r.oid
          -- The one role it may switch to, as long as it does not inherit it.
          and not (m.roleid::regrole::text = ${mayBecome ?? ''} and not m.inherit_option)
      ) as "memberOf",
      (select count(*) from pg_class c where c.relowner = r.oid)::int
        + (select count(*) from pg_namespace n where n.nspowner = r.oid)::int
        + (select count(*) from pg_proc p where p.proowner = r.oid)::int as owns
    from pg_roles r
    where r.rolname = ${name}`;
  if (!role) return ['does not exist; run the migrations first'];
  const problems: string[] = [];
  if (role.attributes.length > 0) problems.push(`has ${role.attributes.join(', ')}`);
  if (role.memberOf.length > 0) problems.push(`is a member of ${role.memberOf.join(', ')}`);
  if (role.owns > 0) problems.push(`owns ${role.owns} object(s) in this database`);
  return problems;
}

/** "RTN" and a number, like the other advisory lock keys. */
const LOGIN_LOCK = 0x52544e04;

/** Postgres's default for SCRAM-SHA-256 (`scram_iterations`). */
const SCRAM_ITERATIONS = 4096;

/**
 * A SCRAM-SHA-256 verifier (RFC 7677), the form Postgres stores. Sending it
 * instead of the password keeps the password out of the server's logs.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (buffer: Buffer) => buffer.toString('base64');
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

/**
 * Rewriting an unchanged SCRAM verifier is unnecessary. A fresh authenticated
 * connection proves the configured login works without reading pg_authid (RDS
 * owners cannot). Rotation/role repair needs a stop: old pools may reconnect.
 * Never return connection errors: they may contain credentials.
 */
export async function loginsPending(config: Config, owner: Sql): Promise<boolean> {
  for (const [role, url] of [
    [RUNTIME_ROLE, config.RETAINER_RUNTIME_DATABASE_URL],
    [CONTROL_ROLE, config.RETAINER_CONTROL_DATABASE_URL],
    [SECRET_BROKER_ROLE, config.RETAINER_SECRET_BROKER_DATABASE_URL],
    [EXECUTOR_ROLE, config.RETAINER_EXECUTOR_DATABASE_URL],
  ] as const) {
    if (!url) continue;
    if ((await owner.begin((tx) => roleProblems(tx, role))).length > 0) return true;
    const login = createSql(url, { max: 1 });
    try {
      const [row] = await login`select current_user as name`;
      if (row?.name !== role) return true;
    } catch {
      return true;
    } finally {
      await login.end({ timeout: 5 });
    }
  }
  return false;
}
