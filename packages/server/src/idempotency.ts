import { createHash } from 'node:crypto';
import { jsonValue, type Tx } from './db/tx.js';
import { AppError } from './errors.js';
import { stableJson } from './stable-json.js';

/** How long a key protects against a retry. */
const TTL = '24 hours';

export function requestHash(request: unknown): string {
  return createHash('sha256').update(stableJson(request)).digest('hex');
}

export type IdempotencyClaim = { kind: 'new'; id: string } | { kind: 'replay'; result: unknown };

/** The scope of a claim made by a credential that works for no person (personal memory spec 4.2). */
export const NO_PERSON_SCOPE = '00000000-0000-0000-0000-000000000000';

export type ClaimScope = {
  /** The person behind the credential, if any: two people never share a claim. */
  personId?: string | undefined;
  /**
   * Set when the stored response will read or change that person's private
   * facts, so only they can replay it. Must be the same person.
   */
  private?: boolean;
};

/**
 * Claims a caller's idempotency key for one operation (6.2), in the same
 * transaction as the write. A concurrent request with the same key waits on
 * the unique index until this transaction ends, then replays its result. A
 * key reused with a different request fails. An expired key starts over.
 * Claims are scoped by person as well as workspace and operation, so another
 * person reusing the key gets a claim of their own (personal memory 4.2).
 * Resolve aliases and check access before claiming: a replay returns the
 * stored response as it is.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  workspaceId: string,
  operation: string,
  key: string,
  hash: string,
  scope: ClaimScope = {},
): Promise<IdempotencyClaim> {
  if (key.length === 0 || key.length > 200) {
    throw new AppError(400, 'invalid_request', 'Idempotency-Key must be 1 to 200 characters');
  }
  const personScope = scope.personId ?? NO_PERSON_SCOPE;
  const privateTo = scope.private && scope.personId ? scope.personId : null;
  const [claimed] = await tx<{ id: string }[]>`
    insert into idempotency_keys
      (workspace_id, operation, person_scope, key, request_hash, expires_at, private_to_user)
    values (${workspaceId}, ${operation}, ${personScope}, ${key}, ${hash},
      now() + ${TTL}::interval, ${privateTo})
    on conflict (workspace_id, operation, person_scope, key) do update
      set request_hash = excluded.request_hash, result = null, created_at = now(),
        expires_at = excluded.expires_at, private_to_user = excluded.private_to_user
      where idempotency_keys.expires_at < now()
    returning id`;
  if (claimed) return { kind: 'new', id: claimed.id };

  const [existing] = await tx<{ request_hash: string; result: unknown }[]>`
    select request_hash, result from idempotency_keys
    where workspace_id = ${workspaceId} and operation = ${operation}
      and person_scope = ${personScope} and key = ${key}`;
  if (!existing || existing.request_hash !== hash) {
    throw new AppError(
      422,
      'idempotency_key_reused',
      'this Idempotency-Key was used for a different request',
    );
  }
  return { kind: 'replay', result: existing.result };
}

export async function storeIdempotentResult(tx: Tx, id: string, result: unknown): Promise<void> {
  await tx`update idempotency_keys set result = ${tx.json(jsonValue(result))} where id = ${id}`;
}
