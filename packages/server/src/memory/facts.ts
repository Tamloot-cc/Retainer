import type { Actor, FactSource, PresentedFact, ProfileAlias } from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError, invalid, notFound } from '../errors.js';
import { requestHash } from '../idempotency.js';
import { textVector } from '../records/search-sql.js';
import {
  insertRecord,
  lockRecord,
  objectOf,
  resolveRecordId,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import type { CompiledSchema } from '../schema/compiled.js';
import { type CitedSource, liveFactSource, lockSource, NOTE_CHANNEL } from './events.js';
import {
  lockPerson,
  type Profile,
  type ProfileContext,
  resolveTarget,
  type Target,
} from './profiles.js';

/**
 * Facts (1.3): plain-language claims about a record, each citing the event
 * it rests on (rule 2.1). Valid from the source's `occurred_at` (rule 2.6).
 * A fact is current while it is not retracted or superseded and at least
 * one of its sources is live (2.1).
 */

export const rememberInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(5_000),
  source: z.uuid().optional(),
  quote: z.string().trim().min(1).max(5_000).optional(),
  /**
   * A current fact the new one replaces (personal memory spec 4.9). On the
   * same record it corrects it; on another record it moves it there.
   */
  supersedes: z.uuid().optional(),
});
export type RememberInput = z.infer<typeof rememberInputSchema>;

export type { PresentedFact } from '@retainer/shared';

/** What `remember` returns (6.2). */
export type RememberResult = { fact: PresentedFact };

type FactRow = {
  id: string;
  record_id: string;
  content: string;
  kind: 'stated' | 'inferred';
  valid_from: Date;
  valid_to: Date | null;
  actor: Actor;
};

/** A fact `supersedes` names, as the caller can see it. */
type OldFact = FactRow & {
  private_to_user: string | null;
  deleted_at: Date | null;
  superseded_by: string | null;
  replaced_at: Date | null;
};

/**
 * What a `remember` call resolves to before anything is written or an
 * idempotency key is claimed (personal memory spec 4.2): the destination,
 * after aliases, membership and access are checked, and the fact it
 * supersedes.
 */
export type RememberPlan = {
  target: Target;
  /** The resolved destination, as the request hash binds it. */
  destination: string;
  old: OldFact | null;
  /** The call reads or changes private facts: its stored response is private too. */
  private: boolean;
};

/** The hash a `remember` idempotency key is bound to: the resolved destination and the input. */
export function rememberRequestHash(plan: RememberPlan, input: RememberInput): string {
  return requestHash({
    record: plan.destination,
    text: input.text,
    source: input.source ?? null,
    quote: input.quote ?? null,
    supersedes: input.supersedes ?? null,
  });
}

/**
 * Resolves a `remember` call (4.2, 4.3): `workspace` and `me` become their
 * profiles (created on the first write), `me` and a superseded personal fact
 * take the person's membership lock and re-check it, and the superseded
 * fact must be one the caller can see.
 */
export async function planRemember(
  tx: Tx,
  context: WriteContext,
  ref: string,
  input: RememberInput,
): Promise<RememberPlan> {
  const target = await resolveTarget(tx, context, ref, { create: true });
  let old: OldFact | null = null;
  if (input.supersedes) {
    const [row] = await tx<OldFact[]>`
      select id, record_id, content, kind, valid_from, valid_to, actor, private_to_user,
        deleted_at, superseded_by, replaced_at
      from facts where id = ${input.supersedes} and workspace_id = ${context.workspaceId}`;
    if (!row) throw notFound('fact', { id: input.supersedes });
    old = row;
    // A personal fact moved out of `me` is a write of personal memory too.
    const intoMe = target.kind === 'profile' && target.profile.alias === 'me';
    if (old.private_to_user && !intoMe) await lockPerson(tx, context);
  }
  const destination =
    target.kind === 'profile'
      ? `profile:${target.profile.alias}`
      : await resolveRecordId(tx, context.workspaceId, target.id);
  const isPrivate =
    (target.kind === 'profile' && target.profile.privateTo !== null) ||
    old?.private_to_user != null;
  return { target, destination, old, private: isPrivate };
}

/**
 * Creates the internal note `remember` cites when it is given no source
 * (6.4): an event of the hidden internal-note type, with channel `retainer`,
 * the fact's text as its summary and the record as its one `about` link.
 * Nothing but this lifecycle reads, edits or deletes it. A note for
 * personal memory is private to its person (personal memory 4.5); a moved
 * fact's note is copied with its original time (4.9).
 */
async function createInternalNote(
  tx: Tx,
  context: WriteContext,
  recordId: string,
  text: string,
  { privateTo = null, occurredAt }: { privateTo?: string | null; occurredAt?: Date } = {},
): Promise<CitedSource> {
  const object = context.schema.internalNote;
  if (!object?.core) {
    throw new AppError(500, 'internal', 'this workspace has no internal-note type');
  }
  const note = await insertRecord(tx, context, object, privateTo);
  const [created] = await tx<{ occurred_at: Date }[]>`
    insert into event_records (workspace_id, record_id, occurred_at, channel)
    values (${context.workspaceId}, ${note.id},
      ${occurredAt ? tx`${occurredAt}` : tx`clock_timestamp()`}, ${NOTE_CHANNEL})
    returning occurred_at`;
  const noteTime = (created as { occurred_at: Date }).occurred_at;
  await writeFields(tx, context, object, note, new Map([[object.core.summary, text]]), {
    sourceRecordId: note.id,
    observedAt: noteTime,
    isInitial: true,
  });
  await tx`
    insert into event_links (workspace_id, event_id, position, record_id, link)
    values (${context.workspaceId}, ${note.id}, 0, ${recordId}, 'about')`;
  return { id: note.id, occurredAt: noteTime };
}

/** The record a fact is written to: a locked record of the workspace's types, or a profile. */
type Destination = { id: string; profile: Profile | null };

/**
 * Locks the destination of a fact without `supersedes`. A record of the
 * workspace's own types must be one a caller may write; a profile is
 * hidden and written only here.
 */
async function lockDestination(
  tx: Tx,
  context: WriteContext,
  target: Target,
): Promise<Destination> {
  if (target.kind === 'profile') {
    const id = target.profile.id as string;
    await lockRecord(tx, context.workspaceId, id);
    return { id, profile: target.profile };
  }
  const record = await lockRecord(tx, context.workspaceId, target.id);
  objectOf(context.schema, record);
  return { id: record.id, profile: null };
}

async function insertFact(
  tx: Tx,
  context: WriteContext,
  recordId: string,
  values: {
    content: string;
    kind: 'stated' | 'inferred';
    validFrom: Date;
    validTo?: Date | null;
  },
): Promise<FactRow> {
  const [inserted] = await tx<FactRow[]>`
    insert into facts
      (workspace_id, record_id, content, kind, valid_from, valid_to, search, actor)
    values (${context.workspaceId}, ${recordId}, ${values.content}, ${values.kind},
      ${values.validFrom}, ${values.validTo ?? null}, ${textVector(tx, values.content)},
      ${tx.json(context.actor)})
    returning id, record_id, content, kind, valid_from, valid_to, actor`;
  return inserted as FactRow;
}

/**
 * Writes one `stated` fact about a record or a profile (6.2). With `source`,
 * the fact cites that event and is valid from its `occurred_at`. Without
 * one, an internal note is created for it to cite, and it is valid from the
 * write time. Lock order matches deletion: the source, then the record. With
 * `supersedes`, the new fact replaces that one (4.9).
 */
export async function rememberFact(
  tx: Tx,
  context: WriteContext,
  plan: RememberPlan,
  input: RememberInput,
): Promise<RememberResult> {
  if (input.quote !== undefined && input.source === undefined) {
    throw invalid('quote needs a source: pass the event the quote comes from');
  }
  if (plan.old) return supersedeFact(tx, context, plan, plan.old, input);

  let source: CitedSource | undefined;
  if (input.source) source = await lockSource(tx, context, input.source);
  const destination = await lockDestination(tx, context, plan.target);
  const { fact, sources } = await writeStatedFact(tx, context, destination, input, source);
  return { fact: presentFact(fact, sources, destination.profile?.alias) };
}

/** Inserts a stated fact and its one source: the cited event, or a new internal note. */
async function writeStatedFact(
  tx: Tx,
  context: WriteContext,
  destination: Destination,
  input: RememberInput,
  cited: CitedSource | undefined,
): Promise<{ fact: FactRow; sources: FactSource[] }> {
  const source =
    cited ??
    (await createInternalNote(tx, context, destination.id, input.text, {
      privateTo: destination.profile?.privateTo ?? null,
    }));
  const fact = await insertFact(tx, context, destination.id, {
    content: input.text,
    kind: 'stated',
    validFrom: source.occurredAt,
  });
  await tx`
    insert into fact_sources (workspace_id, fact_id, source_record_id, quote)
    values (${context.workspaceId}, ${fact.id}, ${source.id}, ${input.quote ?? null})`;
  return {
    fact,
    sources: [
      cited
        ? { event: source.id, quote: input.quote ?? null }
        : { event: null, internal: true, quote: null },
    ],
  };
}

/** Whether a fact is current (2.1, 4.9): not retracted, replaced, superseded or ended. */
function isCurrent(fact: OldFact): boolean {
  return !fact.deleted_at && !fact.replaced_at && !fact.superseded_by && !fact.valid_to;
}

const notCurrent = (id: string) =>
  new AppError(
    409,
    'fact_not_current',
    `fact ${id} is not current: it was retracted, replaced or lost its sources; read the ` +
      'record again and supersede the fact that replaced it',
    { id },
  );

/** A live source of a fact: an event, or an internal note with its text and time. */
type LiveSource = {
  source_record_id: string;
  object_type_id: string;
  occurred_at: Date;
  quote: string | null;
  data: Record<string, unknown>;
};

async function liveSourcesOf(tx: Tx, factId: string): Promise<LiveSource[]> {
  return tx<LiveSource[]>`
    select s.source_record_id, src.object_type_id, e.occurred_at, s.quote, src.data
    from fact_sources s
    join records src on src.id = s.source_record_id and src.deleted_at is null
    join event_records e on e.record_id = src.id
    where s.fact_id = ${factId}
    order by e.occurred_at, s.id`;
}

/** How many times a move re-reads a fact a concurrent merge moved to another record. */
const MOVE_ATTEMPTS = 3;

/**
 * `remember` with `supersedes` (4.9). On the fact's own record it corrects
 * the fact: `source` and `quote` keep their meaning, and without a source
 * the correction gets its own internal note. On another record it moves
 * the fact there, with the same text and the same evidence: every live
 * event citation and its quote is copied, an internal note is copied with
 * the destination's privacy, and the validity dates are kept. Either way
 * the old fact gets `superseded_by` and a permanent `replaced_at`, and
 * stays in history.
 *
 * Locks: the sources first (`FOR KEY SHARE`), then the records in sorted ID
 * order, then the old fact `FOR UPDATE`, whose eligibility is checked again
 * under the locks; a concurrent supersede of the same fact then sees it
 * replaced.
 */
async function supersedeFact(
  tx: Tx,
  context: WriteContext,
  plan: RememberPlan,
  first: OldFact,
  input: RememberInput,
): Promise<RememberResult> {
  const destinationPrivate = plan.target.kind === 'profile' && plan.target.profile.privateTo;
  if (!first.private_to_user && destinationPrivate) {
    throw new AppError(
      422,
      'private_replacement',
      'a shared fact cannot be replaced by one in me: colleagues would lose the fact and not ' +
        'see what replaced it. Remember the personal part in me without supersedes',
      { id: first.id },
    );
  }
  if (
    context.actor.type === 'agent' &&
    (first.actor.type === 'user' || first.actor.type === 'integration')
  ) {
    throw new AppError(
      403,
      'supersedes_person',
      `fact ${first.id} was written by a ${first.actor.type}, and agents never overwrite people: ` +
        'remember the new fact without supersedes and tell your user, who can remove the old one',
      { id: first.id },
    );
  }

  for (let attempt = 1; ; attempt++) {
    const oldRecord = first.record_id;
    const destinationId =
      plan.target.kind === 'profile'
        ? (plan.target.profile.id as string)
        : await resolveRecordId(tx, context.workspaceId, plan.target.id);
    const moving = destinationId !== oldRecord;

    if (moving) {
      if (input.source !== undefined || input.quote !== undefined) {
        throw new AppError(
          422,
          'invalid_move',
          'moving a fact keeps its evidence: omit source and quote, and Retainer copies its ' +
            'citations to the new record',
          { id: first.id },
        );
      }
      if (input.text !== first.content.trim()) {
        throw new AppError(
          422,
          'invalid_move',
          'moving a fact keeps its text: pass the same text to move it, or correct it on its ' +
            'own record first and then move the correction',
          { id: first.id },
        );
      }
    }

    // Sources before records, as deletion takes them (2.1).
    let cited: CitedSource | undefined;
    if (!moving && input.source) cited = await lockSource(tx, context, input.source);
    const inherited = moving ? await liveSourcesOf(tx, first.id) : [];
    const sourceIds = [...new Set(inherited.map((s) => s.source_record_id))].sort();
    if (sourceIds.length > 0) {
      await tx`
        select id from records where id = any(${sourceIds}::uuid[]) and workspace_id = ${context.workspaceId}
        order by id for key share`;
    }

    // Then the records, in sorted ID order (2.5).
    const lockedIds = [...new Set([oldRecord, destinationId])].sort();
    const locked = new Map<string, Awaited<ReturnType<typeof lockRecord>>>();
    for (const id of lockedIds) locked.set(id, await lockRecord(tx, context.workspaceId, id));
    const destination = locked.get(destinationId);
    if (destination?.id !== destinationId) {
      // The destination was merged meanwhile: resolve it again.
      if (attempt >= MOVE_ATTEMPTS) throw notCurrent(first.id);
      continue;
    }
    if (plan.target.kind === 'record') objectOf(context.schema, destination);

    // Then the fact, re-read under the locks.
    const [old] = await tx<OldFact[]>`
      select id, record_id, content, kind, valid_from, valid_to, actor, private_to_user,
        deleted_at, superseded_by, replaced_at
      from facts where id = ${first.id} and workspace_id = ${context.workspaceId}
      for update`;
    if (!old || !isCurrent(old)) throw notCurrent(first.id);
    if (old.record_id !== oldRecord) {
      // A merge moved it to the survivor meanwhile: start again from there.
      if (attempt >= MOVE_ATTEMPTS) throw notCurrent(first.id);
      first = old;
      continue;
    }
    const live = await liveSourcesOf(tx, old.id);
    if (live.length === 0) throw notCurrent(first.id);
    if (moving && live.some((s) => !sourceIds.includes(s.source_record_id))) {
      if (attempt >= MOVE_ATTEMPTS) throw notCurrent(first.id);
      continue;
    }

    const target: Destination = {
      id: destinationId,
      profile: plan.target.kind === 'profile' ? plan.target.profile : null,
    };
    let created: { fact: FactRow; sources: FactSource[] };
    if (!moving) {
      created = await writeStatedFact(tx, context, target, input, cited);
    } else {
      created = await copyFact(tx, context, target, old, live);
    }
    await tx`
      update facts set superseded_by = ${created.fact.id}, replaced_at = clock_timestamp()
      where id = ${old.id}`;
    return { fact: presentFact(created.fact, created.sources, target.profile?.alias) };
  }
}

/**
 * A moved fact on its new record (4.9): same text, kind and validity, the
 * moving actor, and every live citation. An event citation is copied with
 * its quote, so retracting or erasing the event affects the copy exactly as
 * it would the original. An internal note is copied for the destination,
 * with the same text and time and the destination's privacy, so a shared
 * fact never cites a private note or a note about another record. A move
 * out of `me` publishes that copy, which outlives clearing personal memory.
 */
async function copyFact(
  tx: Tx,
  context: WriteContext,
  destination: Destination,
  old: OldFact,
  live: LiveSource[],
): Promise<{ fact: FactRow; sources: FactSource[] }> {
  const fact = await insertFact(tx, context, destination.id, {
    content: old.content,
    kind: old.kind,
    validFrom: old.valid_from,
    validTo: old.valid_to,
  });
  const sources: FactSource[] = [];
  const summary = context.schema.internalNote?.core?.summary;
  for (const source of live) {
    const note = context.schema.objectsById.get(source.object_type_id)?.hidden;
    let sourceId = source.source_record_id;
    if (note) {
      const text = summary ? source.data[summary.key] : undefined;
      const copy = await createInternalNote(
        tx,
        context,
        destination.id,
        typeof text === 'string' && text.length > 0 ? text : old.content,
        { privateTo: destination.profile?.privateTo ?? null, occurredAt: source.occurred_at },
      );
      sourceId = copy.id;
    }
    await tx`
      insert into fact_sources (workspace_id, fact_id, source_record_id, quote)
      values (${context.workspaceId}, ${fact.id}, ${sourceId}, ${note ? null : source.quote})`;
    sources.push(
      note
        ? { event: null, internal: true, quote: null }
        : { event: source.source_record_id, quote: source.quote },
    );
  }
  return { fact, sources };
}

export function presentFact(
  row: FactRow & { status?: PresentedFact['status'] },
  sources: FactSource[],
  /** A profile's facts name it by alias, never by an ID (personal memory spec 4.4). */
  profile?: ProfileAlias,
): PresentedFact {
  return {
    id: row.id,
    ...(row.status ? { status: row.status } : {}),
    ...(profile ? { profile } : { record: row.record_id }),
    content: row.content,
    kind: row.kind,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null,
    writtenBy: row.actor,
    sources,
  };
}

/**
 * The live sources of facts, in order of occurrence, presented: an event's
 * ID and quote, or an internal note marked as such, never its ID (6.4).
 */
export async function factSources(
  tx: Tx,
  schema: CompiledSchema,
  factIds: readonly string[],
): Promise<Map<string, FactSource[]>> {
  const sources = new Map<string, FactSource[]>(factIds.map((id) => [id, []]));
  if (factIds.length === 0) return sources;
  const rows = await tx<
    { fact_id: string; source_record_id: string; object_type_id: string; quote: string | null }[]
  >`
    select s.fact_id, s.source_record_id, src.object_type_id, s.quote from fact_sources s
    join records src on src.id = s.source_record_id and src.deleted_at is null
    join event_records e on e.record_id = src.id
    where s.fact_id = any(${[...factIds]}::uuid[])
    order by e.occurred_at, s.id`;
  for (const row of rows) {
    const internal = schema.objectsById.get(row.object_type_id)?.hidden;
    sources
      .get(row.fact_id)
      ?.push(
        internal
          ? { event: null, internal: true, quote: null }
          : { event: row.source_record_id, quote: row.quote },
      );
  }
  return sources;
}

export type FactList = (
  | { record: string; profile?: never }
  | { profile: ProfileAlias; record?: never }
) & {
  facts: PresentedFact[];
};

/**
 * A live record's current facts, newest `validFrom` first: not retracted,
 * not superseded or replaced, and resting on at least one live event (2.1,
 * 5). Only live sources are listed. `workspace` and `me` list a profile's
 * facts; `me` before anything was written to it has none.
 */
export async function listFacts(
  tx: Tx,
  context: ProfileContext,
  ref: string,
  limit: number,
): Promise<FactList> {
  const { workspaceId, schema } = context;
  const target = await resolveTarget(tx, context, ref);
  let recordId: string | null;
  if (target.kind === 'profile') {
    recordId = target.profile.id;
  } else {
    const canonical = await resolveRecordId(tx, workspaceId, target.id);
    const [record] = await tx<{ deleted_at: Date | null; object_type_id: string }[]>`
      select deleted_at, object_type_id from records
      where id = ${canonical} and workspace_id = ${workspaceId}`;
    if (!record || schema.objectsById.get(record.object_type_id)?.hidden) {
      throw notFound('record', { id: ref });
    }
    if (record.deleted_at) {
      throw new AppError(404, 'record_deleted', `record ${canonical} was deleted`, {
        recordId: canonical,
      });
    }
    recordId = canonical;
  }
  const rows = recordId
    ? await tx<FactRow[]>`
        select f.id, f.record_id, f.content, f.kind, f.valid_from, f.valid_to, f.actor
        from facts f
        where f.workspace_id = ${workspaceId} and f.record_id = ${recordId}
          and f.deleted_at is null and f.superseded_by is null and f.replaced_at is null
          and f.valid_to is null and exists (${liveFactSource(tx, tx`f.id`)})
        order by f.valid_from desc, f.created_at desc, f.id
        limit ${limit}`
    : [];
  const sources = await factSources(
    tx,
    schema,
    rows.map((r) => r.id),
  );
  const alias = target.kind === 'profile' ? target.profile.alias : undefined;
  const facts = rows.map((row) => presentFact(row, sources.get(row.id) ?? [], alias));
  return alias ? { profile: alias, facts } : { record: recordId as string, facts };
}

/**
 * Retracts a fact (soft delete, 2.1). Its sources and history are kept. A
 * personal fact is a write of personal memory: it takes the person's
 * membership lock and re-checks it (personal memory spec 4.3). Returns
 * whether the fact was the caller's own personal fact.
 */
export async function retractFact(
  tx: Tx,
  context: ProfileContext,
  id: string,
  authorize: (personal: boolean) => void = () => {},
): Promise<{ id: string; deleted: true }> {
  const { workspaceId } = context;
  const [found] = await tx<{ private_to_user: string | null }[]>`
    select private_to_user from facts where id = ${id} and workspace_id = ${workspaceId}`;
  if (!found) throw notFound('fact', { id });
  authorize(found.private_to_user !== null);
  if (found.private_to_user) await lockPerson(tx, context);
  const [row] = await tx<{ deleted_at: Date | null }[]>`
    select deleted_at from facts where id = ${id} and workspace_id = ${workspaceId} for update`;
  if (!row) throw notFound('fact', { id });
  if (row.deleted_at) {
    throw new AppError(409, 'fact_deleted', `fact ${id} is already retracted`, { id });
  }
  await tx`update facts set deleted_at = clock_timestamp() where id = ${id}`;
  return { id, deleted: true };
}
