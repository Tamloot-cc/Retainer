import { readFileSync, statSync } from 'node:fs';
import { SIGN_IN_PROVIDERS, type SignInProvider } from '@retainer/shared';
import { z } from 'zod';
import { LOG_LEVELS } from './log.js';

export const publicOriginSchema = z
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    );
  }, 'use an http(s) origin without credentials, a path, query or fragment')
  .transform((value) => new URL(value).origin);

/**
 * The role the API and workers run as (created by drizzle/0001_security.sql).
 * It owns no tables and has no BYPASSRLS, so row-level security applies.
 */
export const RUNTIME_ROLE = 'retainer_app';

/**
 * The role account work runs as (drizzle/0027_accounts_security.sql): the
 * account tables, workspaces and API keys, and seeding by switching to the
 * runtime role. No BYPASSRLS and no DDL.
 */
export const CONTROL_ROLE = 'retainer_control';
export const SECRET_BROKER_ROLE = 'retainer_secret_broker';
export const EXECUTOR_ROLE = 'retainer_executor';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

/** The decoded password of a database URL. */
export const passwordOf = (url: string) => decodeURIComponent(new URL(url).password);
const userOf = (url: string) => decodeURIComponent(new URL(url).username);

/** A database URL that logs in as `role` with a password SCRAM can take as is. */
const loginUrl = (role: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .url()
      .refine((value) => URL.canParse(value) && userOf(value) === role, {
        message: `log in as ${role}`,
      })
      .refine((value) => URL.canParse(value) && /^[\x21-\x7e]+$/.test(passwordOf(value)), {
        message: 'include a password of printable ASCII without spaces',
      })
      .optional(),
  );

const configSchema = z
  .object({
    RETAINER_PUBLIC_ORIGIN: z.preprocess(emptyToUndefined, publicOriginSchema.optional()),
    RETAINER_WEB_DIR: z.string().optional(),
    RETAINER_FILE_STORAGE: z.preprocess(emptyToUndefined, z.enum(['local', 's3']).optional()),
    RETAINER_FILE_PUBLIC_ORIGIN: z.preprocess(emptyToUndefined, publicOriginSchema.optional()),
    RETAINER_FILE_CONTROL_ORIGIN: z.preprocess(emptyToUndefined, publicOriginSchema.optional()),
    RETAINER_FILE_EXECUTION_ORIGIN: z.preprocess(emptyToUndefined, publicOriginSchema.optional()),
    RETAINER_FILE_SIGNING_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    RETAINER_FILE_STORAGE_ID: z.string().default('local-v1'),
    RETAINER_FILE_S3_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
    RETAINER_FILE_QUOTA_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(1099511627776)
      .default(1073741824),
    /**
     * The migration role, which owns the tables. Migrations, boot tasks and the
     * operator CLI connect with it. Without RETAINER_RUNTIME_DATABASE_URL the
     * API and workers connect with it too and switch to the runtime role.
     */
    DATABASE_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    /**
     * A login as the runtime role itself, for the API and workers (accounts
     * spec 4.9), so their connections can never act as the owner. The owner
     * sets this password on boot or migration, so the database needs no
     * separate setup. Printable ASCII only: SCRAM would otherwise normalize it.
     */
    RETAINER_RUNTIME_DATABASE_URL: loginUrl(RUNTIME_ROLE),
    /**
     * A login as the control role, for account work (accounts spec 4.9). Like
     * the runtime login, the owner sets its password on boot or migration.
     * Without it, account work connects as the owner and switches role.
     */
    RETAINER_CONTROL_DATABASE_URL: loginUrl(CONTROL_ROLE),
    RETAINER_SECRET_BROKER_DATABASE_URL: loginUrl(SECRET_BROKER_ROLE),
    RETAINER_EXECUTOR_DATABASE_URL: loginUrl(EXECUTOR_ROLE),
    RETAINER_EXTENSION_CATALOG: z.preprocess(emptyToUndefined, z.string().max(2097152).optional()),
    RETAINER_EXTENSION_EXECUTABLES: z.preprocess(
      emptyToUndefined,
      z.string().max(2097152).optional(),
    ),
    RETAINER_EXTENSION_CATALOG_FILE: z.preprocess(
      emptyToUndefined,
      z.string().min(1).max(4096).optional(),
    ),
    RETAINER_EXTENSION_EXECUTABLES_FILE: z.preprocess(
      emptyToUndefined,
      z.string().min(1).max(4096).optional(),
    ),
    RETAINER_EXTENSION_RUN_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    RETAINER_EXTENSION_RUN_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
    RETAINER_EXTENSION_RUN_KEY_ID: z.string().default('v1'),
    RETAINER_EXTENSION_API_ORIGIN: z.preprocess(emptyToUndefined, publicOriginSchema.optional()),
    RETAINER_EXTENSION_ISSUER: z.preprocess(emptyToUndefined, publicOriginSchema.optional()),
    RETAINER_EXTENSION_SECRET_KEYS: z.preprocess(emptyToUndefined, z.string().optional()),
    RETAINER_EXTENSION_LAUNCHER_ORIGIN: z.preprocess(
      emptyToUndefined,
      publicOriginSchema.optional(),
    ),
    RETAINER_LAUNCHER_TOKEN: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    RETAINER_EXTENSION_VERIFIER_ORIGIN: z.preprocess(
      emptyToUndefined,
      publicOriginSchema.optional(),
    ),
    RETAINER_VERIFIER_TOKEN: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    RETAINER_WEBHOOK_RATE_LIMIT: z.coerce.number().int().min(1).max(10000).default(100),
    /**
     * `control` serves only /account: sign-in and account management. `all`
     * serves everything, including /account in accounts mode.
     */
    RETAINER_ROLE: z
      .enum(['api', 'worker', 'control', 'extensions', 'files', 'all'])
      .default('all'),
    /**
     * Turns on accounts mode (accounts spec 4.1): people sign in with Google,
     * Microsoft or a passkey. Signs session cookies, so changing it signs
     * everyone out. The API checks cookies with it; the code that signs people
     * in also needs a Google or Microsoft client below.
     */
    RETAINER_AUTH_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().min(32, 'use at least 32 characters').optional(),
    ),
    /** The Google OAuth client people sign in with in accounts mode. */
    RETAINER_GOOGLE_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    RETAINER_GOOGLE_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
    /**
     * The Microsoft app people sign in with in accounts mode: work, school and
     * personal accounts (tenant `common`). Off unless both are set.
     */
    RETAINER_MICROSOFT_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
    RETAINER_MICROSOFT_CLIENT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
    /**
     * Requests each workspace may make per minute through /v1 and /mcp, past
     * which it gets a 429 (accounts spec 4.8). 0 turns it off. Unset: 600 in
     * accounts mode, where anyone can sign up, and off in key mode.
     */
    RETAINER_RATE_LIMIT_PER_MINUTE: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().min(0).optional(),
    ),
    /**
     * AWS Lambda only: the secret CloudFront sends as `x-retainer-edge-secret`.
     * When set, the api and control functions refuse requests without it and
     * take the caller's address from `CloudFront-Viewer-Address`
     * (lambda/edge.ts).
     */
    RETAINER_EDGE_SECRET: z.preprocess(
      emptyToUndefined,
      z.string().min(32, 'use at least 32 characters').optional(),
    ),
    PORT: z.coerce.number().int().positive().default(8787),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** How often the consolidator runs per workspace (4.2). */
    RETAINER_CONSOLIDATE_INTERVAL_MINUTES: z.coerce.number().int().positive().default(60),
    /**
     * Database connections each API process opens. The container serves many
     * requests at once; a Lambda instance serves one, so the AWS deployment
     * sets this low to keep the total under the database's limit.
     */
    RETAINER_DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    /**
     * Secret for the keyed HMAC of suppressed handles (2.1). Needed by
     * `forget`; read from the environment where it is used.
     */
    RETAINER_SUPPRESSION_KEY: z.preprocess(
      emptyToUndefined,
      z.string().min(32, 'use at least 32 characters').optional(),
    ),
    /**
     * Earlier suppression keys, comma-separated, still checked so a rotation
     * keeps erased handles and event identities suppressed (6.4).
     */
    RETAINER_SUPPRESSION_PREVIOUS_KEYS: z.preprocess(emptyToUndefined, z.string().optional()),
  })
  // Each function holds only its own login: the control function on AWS has
  // the control URL alone (accounts spec 4.6).
  .refine(
    (config) =>
      config.DATABASE_URL ||
      config.RETAINER_RUNTIME_DATABASE_URL ||
      config.RETAINER_CONTROL_DATABASE_URL,
    {
      path: ['DATABASE_URL'],
      message: 'set DATABASE_URL, RETAINER_RUNTIME_DATABASE_URL or RETAINER_CONTROL_DATABASE_URL',
    },
  )
  .refine((config) => !config.RETAINER_GOOGLE_CLIENT_ID === !config.RETAINER_GOOGLE_CLIENT_SECRET, {
    path: ['RETAINER_GOOGLE_CLIENT_ID'],
    message: 'set RETAINER_GOOGLE_CLIENT_ID and RETAINER_GOOGLE_CLIENT_SECRET together',
  })
  .refine((config) => !config.RETAINER_GOOGLE_CLIENT_ID || config.RETAINER_AUTH_SECRET, {
    path: ['RETAINER_AUTH_SECRET'],
    message: 'a Google client needs RETAINER_AUTH_SECRET too (accounts mode)',
  })
  .refine(
    (config) => !config.RETAINER_MICROSOFT_CLIENT_ID === !config.RETAINER_MICROSOFT_CLIENT_SECRET,
    {
      path: ['RETAINER_MICROSOFT_CLIENT_ID'],
      message: 'set RETAINER_MICROSOFT_CLIENT_ID and RETAINER_MICROSOFT_CLIENT_SECRET together',
    },
  )
  .refine((config) => !config.RETAINER_MICROSOFT_CLIENT_ID || config.RETAINER_AUTH_SECRET, {
    path: ['RETAINER_AUTH_SECRET'],
    message: 'a Microsoft client needs RETAINER_AUTH_SECRET too (accounts mode)',
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const config = parsed.data;
  // Operator-owned immutable release files avoid large manifests in small environment blocks.
  // Never accept these paths from an installation request or evaluate package code here.
  for (const [value, path] of [
    ['RETAINER_EXTENSION_CATALOG', 'RETAINER_EXTENSION_CATALOG_FILE'],
    ['RETAINER_EXTENSION_EXECUTABLES', 'RETAINER_EXTENSION_EXECUTABLES_FILE'],
  ] as const) {
    const file = config[path];
    if (!file) continue;
    if (config[value]) throw new Error(`set only one of ${value} and ${path}`);
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 2097152) throw new Error('invalid release file');
      const bytes = readFileSync(file);
      if (bytes.length > 2097152) throw new Error('invalid release file');
      config[value] = bytes.toString('utf8');
    } catch {
      throw new Error(`cannot load bounded operator release configuration: ${path}`);
    }
  }
  return config;
}

/**
 * The migration role's URL, for code that owns the database: migrations,
 * boot tasks and the operator CLI. The api and consolidate functions on AWS
 * are not given it.
 */
export function ownerDatabaseUrl(config: Config): string {
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is required here: migrations and operator commands need it.');
  }
  return config.DATABASE_URL;
}

/** Accounts mode's default rate limit per workspace (accounts spec 4.8). */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;

/**
 * Requests per minute each workspace may make, or 0 for no limit. A
 * self-hosted install in key mode that sets nothing behaves as before.
 */
export function rateLimitPerMinute(config: Config): number {
  return (
    config.RETAINER_RATE_LIMIT_PER_MINUTE ??
    (accountsMode(config) ? DEFAULT_RATE_LIMIT_PER_MINUTE : 0)
  );
}

/**
 * Where people reach Retainer in accounts mode: `RETAINER_PUBLIC_ORIGIN`, or
 * this machine's port. `/account` issues OAuth tokens for this origin's `/mcp`
 * and the API checks them for it, so both must use this one function.
 */
export function accountsOrigin(config: Config): string {
  return config.RETAINER_PUBLIC_ORIGIN ?? `http://localhost:${config.PORT}`;
}

/** Accounts mode: people sign in with Google, Microsoft or a passkey (accounts spec 4.1). */
export function accountsMode(config: Config): boolean {
  return config.RETAINER_AUTH_SECRET !== undefined;
}

export type OAuthClient = { clientId: string; clientSecret: string };

export type AccountsConfig = {
  secret: string;
  /** At least one is set. */
  google?: OAuthClient;
  microsoft?: OAuthClient;
};

/**
 * What signing people in needs. Code that serves /account calls this at
 * startup, so a half-configured install refuses to start instead of quietly
 * running without sign-in. Google, Microsoft or both: a person's first
 * sign-in is through one of them (passkeys come after).
 */
export function accountsConfig(config: Config): AccountsConfig {
  const secret = config.RETAINER_AUTH_SECRET;
  const google = client(config.RETAINER_GOOGLE_CLIENT_ID, config.RETAINER_GOOGLE_CLIENT_SECRET);
  const microsoft = client(
    config.RETAINER_MICROSOFT_CLIENT_ID,
    config.RETAINER_MICROSOFT_CLIENT_SECRET,
  );
  if (!secret || (!google && !microsoft)) {
    throw new Error(
      'Accounts mode needs RETAINER_AUTH_SECRET and a sign-in provider: ' +
        'RETAINER_GOOGLE_CLIENT_ID and RETAINER_GOOGLE_CLIENT_SECRET, ' +
        'RETAINER_MICROSOFT_CLIENT_ID and RETAINER_MICROSOFT_CLIENT_SECRET, or both. ' +
        'Set the secret and at least one provider, or none of them to stay in key mode.',
    );
  }
  return { secret, ...(google ? { google } : {}), ...(microsoft ? { microsoft } : {}) };
}

const client = (clientId?: string, clientSecret?: string): OAuthClient | undefined =>
  clientId && clientSecret ? { clientId, clientSecret } : undefined;

/** The providers an accounts config turns on, in the sign-in page's order. */
export function signInProviders(config: AccountsConfig): SignInProvider[] {
  return SIGN_IN_PROVIDERS.filter((provider) => config[provider]);
}
