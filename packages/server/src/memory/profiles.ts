import { isProfileAlias, type ProfileAlias } from '@retainer/shared';
import type { CallerPerson } from '../caller.js';
import { isUuid } from '../db/ids.js';
import { lockMemberShared, lockProfileCreation, type Tx } from '../db/tx.js';
import { AppError, noPerson, notFound } from '../errors.js';
import type { CompiledObject, CompiledSchema } from '../schema/compiled.js';

/**
 * Workspace memory and personal memory (personal memory spec 4.1, 4.3):
 * one profile record per workspace, and one per member per workspace,
 * private to that member. Agents name them `workspace` and `me`; the
 * functions here turn those aliases, or a profile's ID, into the record.
 */

export type ProfileContext = {
  workspaceId: string;
  schema: CompiledSchema;
  person?: CallerPerson | undefined;
};

export type Profile = {
  alias: ProfileAlias;
  object: CompiledObject;
  /** The profile record; null for `me` before anything was written to it. */
  id: string | null;
  /** The person a personal profile is private to; null for the workspace's. */
  privateTo: string | null;
};

/** What a record reference names: a record of the workspace's own types, or a profile. */
export type Target = { kind: 'record'; id: string } | { kind: 'profile'; profile: Profile };

/** The profile type an alias names, seeded with every workspace (4.1). */
function profileObject(schema: CompiledSchema, alias: ProfileAlias): CompiledObject {
  const object = alias === 'workspace' ? schema.workspaceProfile : schema.memberProfile;
  if (!object) {
    throw new AppError(503, 'not_configured', `this workspace has no ${alias} memory yet`);
  }
  return object;
}

/**
 * Re-checks, inside the transaction, that the credential still reaches its
 * person (4.3), through the same `SECURITY DEFINER` function that
 * authenticated it. The caller holds the person's membership lock first,
 * so a removal either committed before this check or waits for the
 * transaction to end.
 */
export async function recheckPerson(
  tx: Tx,
  workspaceId: string,
  person: CallerPerson,
): Promise<void> {
  const { check } = person;
  let ok = false;
  if (check.kind === 'session') {
    const [row] = await tx<{ workspace_id: string | null; role: string | null; user_id: string }[]>`
      select user_id, workspace_id, role from retainer_session_access(${check.token}, ${workspaceId})`;
    ok = row?.user_id === person.id && row.workspace_id === workspaceId && row.role !== null;
  } else if (check.kind === 'oauth') {
    const [row] = await tx<{ workspace_id: string; role: string | null; user_id: string }[]>`
      select user_id, workspace_id, role
      from retainer_token_access(${check.subject}, ${check.workspace}, ${check.client})`;
    ok = row?.user_id === person.id && row.workspace_id === workspaceId && row.role !== null;
  } else {
    const [row] = await tx<{ workspace_id: string; acts_for_user: string | null }[]>`
      select workspace_id, acts_for_user from retainer_lookup_api_key(${check.hash})`;
    ok = row?.acts_for_user === person.id && row.workspace_id === workspaceId;
  }
  if (!ok) {
    throw new AppError(
      403,
      'not_a_member',
      'this credential no longer reaches a member of this workspace, so it has no personal memory here',
    );
  }
}

/**
 * The person `me` means, with their membership lock held in shared mode and
 * their membership re-checked under it (4.3): every read or write of
 * personal memory calls this first.
 */
export async function lockPerson(tx: Tx, context: ProfileContext): Promise<CallerPerson> {
  const { person } = context;
  if (!person) throw noPerson();
  await lockMemberShared(tx, context.workspaceId, person.id);
  await recheckPerson(tx, context.workspaceId, person);
  return person;
}

async function findProfile(
  tx: Tx,
  workspaceId: string,
  object: CompiledObject,
  privateTo: string | null,
): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    select id from records
    where workspace_id = ${workspaceId} and object_type_id = ${object.id}
      and deleted_at is null
      and ${privateTo ? tx`private_to_user = ${privateTo}` : tx`private_to_user is null`}
    order by created_at, id
    limit 1`;
  return row?.id ?? null;
}

/**
 * Creates a profile record unless one exists (4.1). Two first writes both
 * succeed and make one profile: creation takes its own exclusive lock, in a
 * namespace apart from the membership lock (which stays shared), then looks
 * again. A profile has no fields, so its search text is empty from the start.
 */
async function createProfile(
  tx: Tx,
  context: ProfileContext & { actor: unknown },
  object: CompiledObject,
  privateTo: string | null,
): Promise<string> {
  await lockProfileCreation(tx, context.workspaceId, privateTo);
  const existing = await findProfile(tx, context.workspaceId, object, privateTo);
  if (existing) return existing;
  const [row] = await tx<{ id: string }[]>`
    insert into records
      (workspace_id, object_type_id, created_by, updated_by, search, private_to_user)
    values (${context.workspaceId}, ${object.id}, ${tx.json(context.actor as never)},
      ${tx.json(context.actor as never)}, ''::tsvector, ${privateTo})
    returning id`;
  return (row as { id: string }).id;
}

/**
 * The profile an alias names. `me` takes the person's membership lock and
 * re-checks membership; with `create`, a missing profile is created (the
 * first write to `me`, or a workspace from before profiles were seeded).
 * Reading `me` before any write finds no record: an empty memory.
 */
export async function resolveProfile(
  tx: Tx,
  context: ProfileContext & { actor?: unknown },
  alias: ProfileAlias,
  { create = false }: { create?: boolean } = {},
): Promise<Profile> {
  const object = profileObject(context.schema, alias);
  const privateTo = alias === 'me' ? (await lockPerson(tx, context)).id : null;
  let id = await findProfile(tx, context.workspaceId, object, privateTo);
  if (!id && create) {
    id = await createProfile(tx, { ...context, actor: context.actor }, object, privateTo);
  }
  return { alias, object, id, privateTo };
}

/**
 * What a record reference names, for the tools that take profiles (4.4):
 * an alias, a profile's ID (only one's own personal profile is visible), or
 * any other record ID, which is left for the record code to check.
 */
export async function resolveTarget(
  tx: Tx,
  context: ProfileContext & { actor?: unknown },
  ref: string,
  options: { create?: boolean } = {},
): Promise<Target> {
  if (isProfileAlias(ref)) {
    return { kind: 'profile', profile: await resolveProfile(tx, context, ref, options) };
  }
  if (!isUuid(ref)) throw notFound('record', { id: ref });
  const [row] = await tx<{ object_type_id: string }[]>`
    select object_type_id from records where id = ${ref} and workspace_id = ${context.workspaceId}`;
  const alias = row && context.schema.objectsById.get(row.object_type_id)?.profile;
  if (alias) return { kind: 'profile', profile: await resolveProfile(tx, context, alias, options) };
  return { kind: 'record', id: ref };
}

/** The alias of a profile record's type, or undefined for any other record. */
export function profileAliasOf(
  schema: CompiledSchema,
  objectTypeId: string,
): ProfileAlias | undefined {
  return schema.objectsById.get(objectTypeId)?.profile;
}

/** A profile's computed label (4.1): the workspace's name, or the person's. */
export async function profileLabel(
  tx: Tx,
  context: ProfileContext,
  profile: Profile,
): Promise<string | null> {
  if (profile.alias === 'me') return context.person?.name || null;
  const [row] = await tx<{ name: string }[]>`
    select name from workspaces where id = ${context.workspaceId}`;
  return row?.name ?? null;
}
