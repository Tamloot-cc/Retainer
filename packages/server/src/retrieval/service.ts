import type {
  ContextPack,
  ProfileAlias,
  ProfileContextPack,
  SearchResult,
  TimelinePage,
} from '@retainer/shared';
import type { Caller } from '../caller.js';
import type { Sql } from '../db/client.js';
import { resolveTarget } from '../memory/profiles.js';
import { withRead } from '../records/service.js';
import { type ContextInput, contextPack, profileContextPack } from './context.js';
import { type SearchInput, search } from './search.js';
import { type TimelineInput, timelinePage } from './timeline.js';

/** Search and context packs for one caller, shared by REST and MCP (5, 5.1). */

export async function searchFor(
  sql: Sql,
  caller: Caller,
  input: SearchInput,
): Promise<SearchResult> {
  return withRead(sql, caller, (tx, schema) => search(tx, caller.workspaceId, schema, input));
}

/**
 * A record's context pack, or with `workspace` or `me` a profile's
 * (personal memory spec 4.4). Reading `me` takes the person's membership
 * lock and re-checks it. A profile's ID also returns a profile's pack;
 * agents never need one, so the record-ID signature leaves it out.
 */
export async function contextFor(
  sql: Sql,
  caller: Caller,
  profile: ProfileAlias,
  input: ContextInput,
): Promise<ProfileContextPack>;
export async function contextFor(
  sql: Sql,
  caller: Caller,
  recordId: string,
  input: ContextInput,
): Promise<ContextPack>;
export async function contextFor(
  sql: Sql,
  caller: Caller,
  recordId: string,
  input: ContextInput,
): Promise<ContextPack | ProfileContextPack> {
  return withRead(sql, caller, async (tx, schema) => {
    const context = { workspaceId: caller.workspaceId, schema, person: caller.person };
    const target = await resolveTarget(tx, context, recordId);
    return target.kind === 'profile'
      ? profileContextPack(tx, context, target.profile, input)
      : contextPack(tx, caller.workspaceId, schema, target.id, input);
  });
}

/** A record's timeline, or a profile's facts (personal memory spec 4.4). */
export async function timelineFor(
  sql: Sql,
  caller: Caller,
  recordId: string,
  input: TimelineInput,
): Promise<TimelinePage> {
  return withRead(sql, caller, async (tx, schema) => {
    const context = { workspaceId: caller.workspaceId, schema, person: caller.person };
    const target = await resolveTarget(tx, context, recordId);
    return timelinePage(
      tx,
      caller.workspaceId,
      schema,
      target.kind === 'profile' ? target.profile : target.id,
      input,
    );
  });
}
