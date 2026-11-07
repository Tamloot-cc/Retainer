import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { CONTROL_ROLE, type Config, ownerDatabaseUrl, RUNTIME_ROLE } from '../config.js';
import * as schema from './schema.js';

export { RUNTIME_ROLE };

export type SqlOptions = {
  /**
   * Postgres role every connection switches to at startup. The API and
   * workers run as the runtime role so row-level security applies to them;
   * migrations and operator commands connect without one.
   */
  role?: string;
  max?: number;
  /**
   * Keep connections open instead of retiring each after postgres.js's
   * random 30–60 minutes. For pools that hold a session lock across many
   * queries: a retired connection takes the lock with it, and the pool
   * carries on with a new connection that does not hold it.
   */
  keepConnections?: boolean;
  /**
   * Cancels any statement that runs longer, in milliseconds (accounts spec
   * 4.8). Set per connection at startup rather than with ALTER ROLE, which
   * applies only to logins as that role: the container logs in as the owner
   * and switches role, and the consolidator logs in as the runtime role too.
   */
  statementTimeoutMs?: number;
};

/**
 * The API's statement timeout: under API Gateway's 29-second request limit,
 * so one expensive search cannot hold connections past its own request.
 */
export const API_STATEMENT_TIMEOUT_MS = 25_000;

export function createSql(databaseUrl: string, options: SqlOptions = {}) {
  const connection = {
    ...(options.role ? { role: options.role } : {}),
    ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
  };
  return postgres(databaseUrl, {
    max: options.max ?? 10,
    onnotice: false,
    ...(Object.keys(connection).length > 0 ? { connection } : {}),
    ...(options.keepConnections ? { max_lifetime: null } : {}),
  });
}

export function createDb(databaseUrl: string, options: SqlOptions = {}) {
  const sql = createSql(databaseUrl, options);
  const db = drizzle(sql, { schema });
  return { db, sql };
}

/**
 * How the API and workers connect: as the runtime role itself when
 * RETAINER_RUNTIME_DATABASE_URL is set, otherwise with the migration role's
 * credentials, switching to the runtime role at connection startup.
 */
export function runtimeConnection(config: Config): { url: string; role?: string } {
  const url = config.RETAINER_RUNTIME_DATABASE_URL;
  return url ? { url } : { url: ownerDatabaseUrl(config), role: RUNTIME_ROLE };
}

/**
 * A pool for account work: as the control role itself when
 * RETAINER_CONTROL_DATABASE_URL is set, otherwise with the migration role's
 * credentials, switching to the control role at connection startup.
 */
export function createControlSql(config: Config, options: Omit<SqlOptions, 'role'> = {}) {
  const url = config.RETAINER_CONTROL_DATABASE_URL;
  return url
    ? createSql(url, options)
    : createSql(ownerDatabaseUrl(config), { ...options, role: CONTROL_ROLE });
}

/** A pool for the API or workers (see `runtimeConnection`). */
export function createRuntimeSql(config: Config, options: Omit<SqlOptions, 'role'> = {}) {
  const { url, role } = runtimeConnection(config);
  return createSql(url, { ...options, role });
}

/**
 * The API's pool: the runtime role, with the statement timeout. Workers get
 * a pool of their own without it, since a consolidator pass may run for
 * minutes (accounts spec 4.8).
 */
export function createApiSql(config: Config, options: Pick<SqlOptions, 'max'> = {}) {
  return createRuntimeSql(config, { ...options, statementTimeoutMs: API_STATEMENT_TIMEOUT_MS });
}

export type Db = ReturnType<typeof createDb>['db'];
export type Sql = ReturnType<typeof createSql>;
