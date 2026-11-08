import type { Actor } from '@retainer/shared';
import type { Tx } from '../db/tx.js';

/** What clearing one person's memory in one workspace deleted: counts only. */
export type PersonalMemoryCounts = {
  profiles: number;
  facts: number;
  notes: number;
  responses: number;
};

/**
 * Hard-deletes one person's personal memory in one workspace (personal
 * memory spec 4.6): their profile, its facts and sources, the private
 * internal notes `remember` created for it with their values and links, and
 * the stored idempotent responses private to them. Shared events their
 * facts cited stay. Notes copied out of `me` by a move are shared, and stay
 * with the record they were moved to.
 *
 * The transaction runs as the runtime role with `app.workspace_id` and
 * `app.user_id` set to that workspace and person, and holds their
 * membership lock exclusively, so no write of their memory is in flight.
 * Writes an audit row with counts only, never text.
 */
export async function deletePersonalMemory(
  tx: Tx,
  workspaceId: string,
  userId: string,
  actor: Pick<Actor, 'type' | 'id'>,
): Promise<PersonalMemoryCounts> {
  const [found] = await tx<{ facts: number; notes: number }[]>`
    select
      (select count(*)::int from facts
        where workspace_id = ${workspaceId} and private_to_user = ${userId}) as facts,
      (select count(*)::int from event_records
        where workspace_id = ${workspaceId} and private_to_user = ${userId}) as notes`;
  const responses = await tx`
    delete from idempotency_keys
    where workspace_id = ${workspaceId} and private_to_user = ${userId}
    returning 1`;
  // Facts, their sources, the notes' values, times and links go with the
  // records they belong to (tenant foreign keys cascade).
  const records = await tx`
    delete from records
    where workspace_id = ${workspaceId} and private_to_user = ${userId}
    returning 1`;
  const notes = found?.notes ?? 0;
  const counts: PersonalMemoryCounts = {
    profiles: records.length - notes,
    facts: found?.facts ?? 0,
    notes,
    responses: responses.length,
  };
  await tx`
    insert into deletion_audit_log (workspace_id, actor_type, actor_id, counts)
    values (${workspaceId}, ${actor.type}, ${actor.id},
      ${tx.json({ personalMemory: 1, ...counts })})`;
  return counts;
}
