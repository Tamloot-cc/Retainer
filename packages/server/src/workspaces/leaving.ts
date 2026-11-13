import type { Actor } from '@retainer/shared';
import { RUNTIME_ROLE } from '../db/client.js';
import {
  lockMemberExclusive,
  lockPrivacyShared,
  lockSchemaShared,
  setScope,
  type Tx,
} from '../db/tx.js';
import { disconnectMemberConnections } from '../extension-runtime/connections.js';
import { deletePersonalMemory } from '../privacy/personal.js';

/** A person and a workspace they may have lost access to. */
export type Membership = { workspaceId: string; userId: string };

/**
 * Ends personal memory where people stopped being members (personal memory
 * spec 4.6, M8). Call it last in the transaction that removed them, after
 * every membership change: being removed from the workspace or from the
 * organization, a lower organization role, or the workspace moving to
 * another organization. Of `candidates`, only those who now have no role in
 * the workspace are ended: for each, in one transaction with the change,
 *
 * 1. their membership lock is taken exclusively, after the workspace's
 *    privacy lock in shared mode, the order every write takes them in;
 * 2. API keys there that work for them are revoked;
 * 3. the transaction switches to the runtime role, sets the workspace and
 *    the person, and deletes their profile, its facts and sources, their
 *    private internal notes and private stored responses;
 * 4. an audit row records counts only.
 *
 * `tx` runs as the control role (or as the operator's owner role), which
 * can read memberships and revoke keys but cannot see records. Switching to
 * the runtime role is not undone, so nothing may follow it.
 */
export async function endLostMemberships(
  tx: Tx,
  candidates: readonly Membership[],
  actor: Pick<Actor, 'type' | 'id'>,
): Promise<number> {
  if (candidates.length === 0) return 0;
  const lost = await tx<Membership[]>`
    select distinct c.workspace_id as "workspaceId", c.user_id as "userId"
    from unnest(${candidates.map((c) => c.workspaceId)}::uuid[],
      ${candidates.map((c) => c.userId)}::uuid[]) as c(workspace_id, user_id)
    join workspaces w on w.id = c.workspace_id
    where not exists (
        select 1 from organization_members om
        where om.organization_id = w.organization_id and om.user_id = c.user_id
          and om.role in ('owner', 'admin'))
      and not exists (
        select 1 from workspace_members wm
        where wm.workspace_id = c.workspace_id and wm.user_id = c.user_id)
    order by 1, 2`;
  if (lost.length === 0) return 0;

  for (const { workspaceId, userId } of lost) {
    await lockPrivacyShared(tx, workspaceId);
    await lockSchemaShared(tx, workspaceId);
    await lockMemberExclusive(tx, workspaceId, userId);
    await tx`
      update api_keys set revoked_at = now()
      where workspace_id = ${workspaceId} and acts_for_user = ${userId} and revoked_at is null`;
  }

  await tx.unsafe(`set local role ${RUNTIME_ROLE}`);
  for (const { workspaceId, userId } of lost) {
    await setScope(tx, workspaceId, userId);
    await disconnectMemberConnections(tx, workspaceId, userId);
    await deletePersonalMemory(tx, workspaceId, userId, actor);
  }
  return lost.length;
}

/** The workspaces of an organization one person has a role in now (A5). */
export async function organizationMemberships(
  tx: Tx,
  organizationId: string,
  userId: string,
): Promise<Membership[]> {
  return tx<Membership[]>`
    select w.id as "workspaceId", om.user_id as "userId"
    from workspaces w
    join organization_members om
      on om.organization_id = w.organization_id and om.user_id = ${userId}
    where w.organization_id = ${organizationId}
      and (om.role in ('owner', 'admin') or exists (
        select 1 from workspace_members wm where wm.workspace_id = w.id and wm.user_id = om.user_id))`;
}

/** Everyone with a role in a workspace now, by organization role or their own (A5). */
export async function membersOf(tx: Tx, workspaceIds: readonly string[]): Promise<Membership[]> {
  if (workspaceIds.length === 0) return [];
  return tx<Membership[]>`
    select w.id as "workspaceId", om.user_id as "userId"
    from workspaces w
    join organization_members om on om.organization_id = w.organization_id
    where w.id = any(${[...workspaceIds]}::uuid[])
      and (om.role in ('owner', 'admin') or exists (
        select 1 from workspace_members wm where wm.workspace_id = w.id and wm.user_id = om.user_id))`;
}
