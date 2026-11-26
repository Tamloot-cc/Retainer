import { type Actor, WORKSPACE_ROLE_SCOPES, type WorkspaceRole } from '@retainer/shared';
import { z } from 'zod';
import type { AgentBinding, Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import type { ApiKeyScope } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';

/**
 * The credential a chat's stream token was minted from, kept on the token
 * and on each turn it starts (agent spec §6.7, §7.3). Access follows it,
 * never where the chat was created, and it is re-checked on every call:
 *
 * - `member`: a person signed in to the web app (accounts mode). Their
 *   current role in the workspace, through `retainer_agent_access`.
 * - `cli`: the CLI login. The same role, while the login is live; each write
 *   also needs the login's elevation in the workspace.
 * - `key`: an API key (key mode, where nobody signs in). The key's current
 *   scopes, while it is not revoked.
 */
export const agentAccessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('member'), userId: z.uuid() }),
  z.strictObject({ kind: z.literal('cli'), userId: z.uuid(), loginId: z.uuid() }),
  z.strictObject({ kind: z.literal('key'), hash: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type AgentAccess = z.infer<typeof agentAccessSchema>;

/** Who owns a chat: the person, or in key mode the key's actor. */
export type AgentOwner = { owner: string; personId: string | null; name: string };

/**
 * The access and owner a caller may open and use chats with: a person's
 * session, the CLI login, or in key mode an API key. Machine credentials
 * (extension runs, installations, routines, apps connected over OAuth) get none,
 * and API keys only in key mode (`keys`), where nobody signs in.
 */
export function agentAccessOf(
  caller: Caller,
  options: { keys: boolean },
): (AgentOwner & { access: AgentAccess }) | undefined {
  if (caller.run || caller.installation || caller.routine || caller.agent) return undefined;
  if (caller.cli) {
    return {
      access: { kind: 'cli', userId: caller.cli.userId, loginId: caller.cli.loginId },
      owner: `user:${caller.cli.userId}`,
      personId: caller.cli.userId,
      name: caller.cli.userName,
    };
  }
  if (caller.connectedBy) return undefined;
  if (caller.userId && caller.actor.type === 'user') {
    return {
      access: { kind: 'member', userId: caller.userId },
      owner: `user:${caller.userId}`,
      personId: caller.userId,
      name: caller.actor.name ?? caller.person?.name ?? '',
    };
  }
  if (options.keys && caller.apiKey && !caller.userId) {
    return {
      access: { kind: 'key', hash: caller.apiKey.hash },
      owner: caller.person ? `user:${caller.person.id}` : `key:${caller.actor.id}`,
      personId: caller.person?.id ?? null,
      name: caller.person?.name ?? caller.actor.name ?? caller.actor.id,
    };
  }
  return undefined;
}

/** What the agent may do in Retainer: reads and record writes, never more. */
const AGENT_SCOPES: readonly ApiKeyScope[] = ['read', 'write'];
const agentScopes = (scopes: readonly string[]) =>
  AGENT_SCOPES.filter((scope) => scopes.includes(scope) || scopes.includes('admin'));

/** The agent's actor for a chat: an agent acting for its owner, never the owner (§7.1). */
export function agentActor(ownerKey: string, name: string): Actor {
  return {
    type: 'agent',
    id: `retainer-agent:${ownerKey}`,
    name: `Retainer agent for ${name || 'this workspace'}`,
  };
}

export const accessLost = () =>
  new AppError(
    403,
    'role',
    'The person this chat works for no longer has access to this workspace, or their credential ended.',
  );

/**
 * The caller a turn acts as, re-derived from its credential now (§7.3): a
 * removed person, an ended CLI login or a revoked key stops the agent at
 * once. Its writes are the agent's, at agent rank, within the person's role.
 */
export async function agentCaller(
  sql: Sql | Tx,
  workspaceId: string,
  access: AgentAccess,
  binding?: AgentBinding,
): Promise<Caller> {
  if (access.kind === 'key') {
    const [key] = await sql<
      {
        workspace_id: string;
        scopes: ApiKeyScope[];
        actor: Actor;
        acts_for_user: string | null;
        acts_for_name: string | null;
      }[]
    >`select * from retainer_lookup_api_key(${access.hash})`;
    if (!key || key.workspace_id !== workspaceId) throw accessLost();
    const owner = key.acts_for_user ? key.acts_for_user : `key:${key.actor.id}`;
    return {
      workspaceId,
      actor: agentActor(owner, key.acts_for_name ?? key.actor.name ?? key.actor.id),
      scopes: agentScopes(key.scopes),
      ...(key.acts_for_user
        ? {
            person: {
              id: key.acts_for_user,
              name: key.acts_for_name ?? '',
              check: { kind: 'key' as const, hash: access.hash },
            },
          }
        : {}),
      ...(binding ? { agent: binding } : {}),
    };
  }
  const [row] = await sql<{ user_name: string; role: WorkspaceRole | null }[]>`
    select user_name, role from retainer_agent_access(${access.userId}::uuid, ${workspaceId}::uuid,
      ${access.kind === 'cli' ? access.loginId : null}::uuid)`;
  if (!row?.role) throw accessLost();
  const cli =
    access.kind === 'cli' ? { loginId: access.loginId, userId: access.userId } : undefined;
  return {
    workspaceId,
    actor: agentActor(access.userId, row.user_name),
    scopes: agentScopes(WORKSPACE_ROLE_SCOPES[row.role]),
    person: {
      id: access.userId,
      name: row.user_name,
      check: cli ? { kind: 'cli', ...cli } : { kind: 'agent', userId: access.userId },
    },
    ...(binding ? { agent: { ...binding, ...(cli ? { cli } : {}) } } : {}),
  };
}
