import type { TransactionSql } from 'postgres';
import type { Sql } from './client.js';

export type Tx = TransactionSql<Record<string, never>>;
const publications = new WeakMap<Tx, { publish?: () => Promise<void> }>();
/** One terminal publication stage, after all workspace work and before COMMIT. No network I/O. */
export function publishAtCommit(tx: Tx, publish: () => Promise<void>) {
  const stage = publications.get(tx);
  if (!stage) throw new Error('publication requires an inWorkspace transaction');
  if (stage.publish) throw new Error('workspace publication already registered');
  stage.publish = publish;
}

/** What `sql.json` accepts. */
type JSONValue = Parameters<Tx['json']>[0];

/**
 * Runs `fn` in a transaction scoped to one workspace. `app.workspace_id` is
 * set for this transaction only, so row-level security confines every query
 * in it to that workspace (7). With `userId`, `app.user_id` is set too, and
 * that person's private rows become visible and writable (personal memory
 * spec 4.2); without it, no private row is.
 */
export async function inWorkspace<T>(
  sql: Sql,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
  userId?: string,
): Promise<T> {
  const result = await sql.begin((tx) =>
    inWorkspaceTransaction(tx as unknown as Tx, workspaceId, fn, userId),
  );
  return result as T;
}

/** Terminal workspace stage for a control transaction that creates the workspace first. */
export async function inWorkspaceTransaction<T>(
  tx: Tx,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
  userId?: string,
): Promise<T> {
  if (publications.has(tx)) throw new Error('workspace transaction is already scoped');
  const stage: { publish?: () => Promise<void> } = {};
  publications.set(tx, stage);
  try {
    await setScope(tx, workspaceId, userId);
    const result = await fn(tx);
    await stage.publish?.();
    return result;
  } finally {
    publications.delete(tx);
  }
}

/**
 * Sets the transaction's row-level security context: the workspace, and the
 * person whose personal memory it may see (none when `userId` is absent).
 */
export async function setScope(tx: Tx, workspaceId: string, userId?: string): Promise<void> {
  await tx`
    select set_config('app.workspace_id', ${workspaceId}, true),
      set_config('app.user_id', ${userId ?? ''}, true)`;
}

/** Advisory-lock class for a person's membership of a workspace (personal memory spec 4.3). */
const MEMBER_LOCK_CLASS = 0x524d; // "RM"
/** A separate class for creating a person's profile, so it never upgrades the membership lock (4.1). */
const PROFILE_LOCK_CLASS = 0x524e; // "RN"

const memberKey = (workspaceId: string, userId: string) => `${workspaceId}:${userId}`;

/**
 * Every read or write of a person's personal memory holds their membership
 * lock in shared mode and re-checks the membership after taking it; removing
 * them takes it exclusively (4.3, 4.6). So a write either commits before the
 * removal, and is deleted with the rest, or starts after it and fails.
 */
export async function lockMemberShared(tx: Tx, workspaceId: string, userId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock_shared(${MEMBER_LOCK_CLASS}::int4,
    hashtext(${memberKey(workspaceId, userId)}))`;
}

export async function lockMemberExclusive(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(${MEMBER_LOCK_CLASS}::int4,
    hashtext(${memberKey(workspaceId, userId)}))`;
}

/** Serializes creating one person's profile in one workspace (4.1). */
export async function lockProfileCreation(
  tx: Tx,
  workspaceId: string,
  userId: string | null,
): Promise<void> {
  await tx`select pg_advisory_xact_lock(${PROFILE_LOCK_CLASS}::int4,
    hashtext(${memberKey(workspaceId, userId ?? 'workspace')}))`;
}

/** Advisory-lock class for workspace schema locks (3). */
const SCHEMA_LOCK_CLASS = 0x5254; // "RT"

/**
 * Record writers hold the workspace schema lock in shared mode for the rest
 * of the transaction, so a schema change (exclusive mode) cannot race a
 * write's validation or commit against a stale schema.
 */
export async function lockSchemaShared(tx: Tx, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock_shared(${SCHEMA_LOCK_CLASS}::int4, hashtext(${workspaceId}))`;
}

/** Schema changes hold the workspace schema lock exclusively. */
export async function lockSchemaExclusive(tx: Tx, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(${SCHEMA_LOCK_CLASS}::int4, hashtext(${workspaceId}))`;
}

/** Advisory-lock class for the workspace deletion boundary (2.1). */
const PRIVACY_LOCK_CLASS = 0x5250; // "RP"

/**
 * The privacy lock is the serialization boundary between `forget` and
 * every other write (2.1). Writers hold it in shared mode, so a write
 * either commits before `forget` collects what to erase, or starts after
 * the suppression list is updated and sees it. `forget` holds it
 * exclusively. The consolidator holds it shared without the schema lock.
 */
export async function lockPrivacyShared(tx: Tx, workspaceId: string): Promise<void> {
  await tx`select pg_advisory_xact_lock_shared(${PRIVACY_LOCK_CLASS}::int4, hashtext(${workspaceId}))`;
}

export type WriteLocks = {
  /** Exclusive only for `forget` (2.1). */
  privacy?: 'shared' | 'exclusive';
  /** Exclusive only for moving events between types, which no write may interleave with (1.3). */
  schema?: 'shared' | 'exclusive';
};

/**
 * A record write's locks in one round trip: privacy first (exclusive for
 * `forget`), then schema (exclusive when rewriting what other writes resolve
 * against). This matches the extension/source-import lock order. Postgres evaluates the
 * select list left to right, so the order matches taking them one at a time.
 */
export async function lockForWrite(
  tx: Tx,
  workspaceId: string,
  { privacy = 'shared', schema = 'shared' }: WriteLocks = {},
): Promise<void> {
  const lock = (lockClass: number, mode: 'shared' | 'exclusive') =>
    mode === 'shared'
      ? tx`pg_advisory_xact_lock_shared(${lockClass}::int4, hashtext(${workspaceId}))`
      : tx`pg_advisory_xact_lock(${lockClass}::int4, hashtext(${workspaceId}))`;
  await tx`select ${lock(PRIVACY_LOCK_CLASS, privacy)}, ${lock(SCHEMA_LOCK_CLASS, schema)}`;
}

/** Advisory-lock class for one consolidator run per workspace at a time (4.2). */
const CONSOLIDATOR_LOCK_CLASS = 0x5243; // "RC"

/** Takes the workspace's consolidator lock if it is free; false when another worker holds it. */
export async function tryLockConsolidator(tx: Tx, workspaceId: string): Promise<boolean> {
  const [row] = await tx<{ locked: boolean }[]>`
    select pg_try_advisory_xact_lock(${CONSOLIDATOR_LOCK_CLASS}::int4, hashtext(${workspaceId}))
      as locked`;
  return row?.locked === true;
}

/**
 * Values headed for jsonb columns. They come from validated input or from
 * jsonb itself, so they are JSON; postgres.js types `sql.json` narrowly.
 */
export function jsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}
