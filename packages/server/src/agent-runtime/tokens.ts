import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUuid } from '../db/ids.js';

/**
 * The workspace agent's credentials for Retainer's API (agent spec §7.3).
 *
 * - A **stream token** is the client's: it can start a turn on one chat and
 *   nothing else. Only the runtime's claim accepts it, with the runtime
 *   credential beside it.
 * - A **turn token** is the agent runtime's: bound to one claimed turn, it
 *   reaches only the runtime routes (`/v1/agent/runtime/...`); every other
 *   route refuses it, since no lookup knows its prefix.
 *
 * Both are opaque: `<prefix><workspace>.<row id>.<secret>`. The API keeps
 * only the secret's SHA-256 on the row, so a token is checked, revoked and
 * fenced in the database, and nothing holding the runtime credential can mint
 * one. The workspace in the token only routes the lookup into its row-level
 * security scope; the hash proves it.
 */
export const STREAM_TOKEN_PREFIX = 'rt_agent_stream_';
export const TURN_TOKEN_PREFIX = 'rt_agent_turn_';
/**
 * A task job's delivery (agent spec §9.3): the dispatcher hands it to the
 * runtime, which trades it, with the runtime credential, for a turn. Its
 * row is the task's own; a new delivery replaces it.
 */
export const JOB_TOKEN_PREFIX = 'rt_agent_job_';

export type TokenPrefix =
  | typeof STREAM_TOKEN_PREFIX
  | typeof TURN_TOKEN_PREFIX
  | typeof JOB_TOKEN_PREFIX;

export type ParsedToken = { workspaceId: string; id: string; secret: string };

export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** A new token for a row: the token to hand out once, and the hash to store. */
export function mintToken(prefix: TokenPrefix, workspaceId: string, id: string) {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${prefix}${workspaceId}.${id}.${secret}`, hash: hashSecret(secret) };
}

/** The parts of a token of this kind, or undefined when it is not one. */
export function parseToken(prefix: TokenPrefix, token: string): ParsedToken | undefined {
  if (!token.startsWith(prefix)) return undefined;
  const [workspaceId, id, secret, ...rest] = token.slice(prefix.length).split('.');
  if (rest.length > 0 || !workspaceId || !id || !secret) return undefined;
  if (!isUuid(workspaceId) || !isUuid(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return undefined;
  return { workspaceId: workspaceId.toLowerCase(), id: id.toLowerCase(), secret };
}

/** Whether a stored hash matches a presented secret, in constant time. */
export function secretMatches(storedHash: string, secret: string): boolean {
  const a = Buffer.from(storedHash, 'hex');
  const b = Buffer.from(hashSecret(secret), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Whether a request carries the runtime credential: the secret the API and
 * the agent runtime share (`RETAINER_AGENT_RUNTIME_SECRET`), which clients
 * never see. Compared by hash, so lengths never leak.
 */
export function isRuntimeCredential(configured: string | undefined, presented: string | undefined) {
  if (!configured || !presented) return false;
  const a = createHash('sha256').update(configured).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}
