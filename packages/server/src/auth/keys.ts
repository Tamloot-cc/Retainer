import { createHash, randomBytes } from 'node:crypto';
import { type Actor, actorSchema } from '@retainer/shared';
import type { Sql } from '../db/client.js';
import { API_KEY_SCOPES, type ApiKeyScope } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { getWorkspace } from '../db/workspaces.js';
import { AppError, notFound } from '../errors.js';

const KEY_PREFIX = 'rtn_';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Characters of the key shown in listings, after `rtn_`. */
const DISPLAY_LENGTH = 8;

/** A new key: `rtn_` and 43 base62 characters (256 bits of randomness). */
export function generateApiKey(): string {
  let n = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let body = '';
  while (body.length < 43) {
    body = BASE62[Number(n % 62n)] + body;
    n /= 62n;
  }
  return `${KEY_PREFIX}${body}`;
}

/** Keys are stored only as their SHA-256 (7). */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export const keyPrefix = (key: string) => key.slice(0, KEY_PREFIX.length + DISPLAY_LENGTH);

/** Parses `type:id`, e.g. `agent:front-desk` or `user:dana`. */
export function parseActor(value: string, name?: string): Actor {
  const separator = value.indexOf(':');
  const parsed = actorSchema.safeParse({
    type: separator > 0 ? value.slice(0, separator) : value,
    id: separator > 0 ? value.slice(separator + 1) : '',
    ...(name ? { name } : {}),
  });
  if (!parsed.success) {
    throw new AppError(
      400,
      'invalid_actor',
      `actor "${value}" must be type:id with type user, integration, agent or system`,
    );
  }
  return parsed.data;
}

export function parseScopes(value: string): ApiKeyScope[] {
  const scopes = [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const unknown = scopes.filter((s) => !(API_KEY_SCOPES as readonly string[]).includes(s));
  if (scopes.length === 0 || unknown.length > 0) {
    throw new AppError(
      400,
      'invalid_scopes',
      `scopes must be some of: ${API_KEY_SCOPES.join(', ')}`,
      {
        unknown,
      },
    );
  }
  return scopes as ApiKeyScope[];
}

export type CreatedApiKey = {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  actor: Actor;
  /** Shown once; only the hash is stored. */
  key: string;
};

/**
 * Issues a key for one workspace. A trusted operator operation (7.1): `sql`
 * connects as the migration role, since the runtime role cannot touch
 * api_keys, so no agent credential can mint a key.
 */
export async function createApiKey(
  sql: Sql | Tx,
  input: {
    workspace: string;
    name: string;
    actor: Actor;
    scopes: ApiKeyScope[];
    /** The person who created it in the web app (accounts spec 4.5). */
    createdByUser?: string;
    /**
     * The person the agent works for (personal memory spec 4.3): only ever
     * the person creating it in the web app.
     */
    actsForUser?: string;
  },
): Promise<CreatedApiKey> {
  const workspace = await getWorkspace(sql, input.workspace);
  const key = generateApiKey();
  const [row] = await sql<{ id: string }[]>`
    insert into api_keys
      (workspace_id, name, prefix, hash, scopes, actor, created_by_user, acts_for_user)
    values (${workspace.id}, ${input.name}, ${keyPrefix(key)}, ${hashApiKey(key)},
      ${input.scopes}, ${sql.json(input.actor)}, ${input.createdByUser ?? null},
      ${input.actsForUser ?? null})
    returning id`;
  return {
    id: row?.id as string,
    workspaceId: workspace.id,
    name: input.name,
    prefix: keyPrefix(key),
    scopes: input.scopes,
    actor: input.actor,
    key,
  };
}

export async function revokeApiKey(
  sql: Sql,
  id: string,
): Promise<{ id: string; revokedAt: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(`key ${id}`);
  const [row] = await sql<{ id: string; revoked_at: Date }[]>`
    update api_keys set revoked_at = coalesce(revoked_at, now()) where id = ${id}
    returning id, revoked_at`;
  if (!row) throw notFound(`key ${id}`);
  return { id: row.id, revokedAt: row.revoked_at.toISOString() };
}

export type ApiKeyListing = Omit<CreatedApiKey, 'key'> & {
  createdAt: string;
  revokedAt: string | null;
};

export async function listApiKeys(sql: Sql, workspace: string): Promise<ApiKeyListing[]> {
  const { id } = await getWorkspace(sql, workspace);
  const rows = await sql<
    {
      id: string;
      name: string;
      prefix: string;
      scopes: ApiKeyScope[];
      actor: Actor;
      created_at: Date;
      revoked_at: Date | null;
    }[]
  >`select id, name, prefix, scopes, actor, created_at, revoked_at from api_keys
    where workspace_id = ${id} order by created_at, id`;
  return rows.map((r) => ({
    id: r.id,
    workspaceId: id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    actor: r.actor,
    createdAt: r.created_at.toISOString(),
    revokedAt: r.revoked_at?.toISOString() ?? null,
  }));
}
