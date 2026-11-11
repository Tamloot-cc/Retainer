import type { ForgetResult } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { requireUser } from '../errors.js';
import { collectFileErasure, eraseFileReferences } from '../files/erasure.js';
import { liveFactSource } from '../memory/events.js';
import { type Handle, parseHandle } from '../memory/handles.js';
import { inboundRelationFields } from '../records/merge.js';
import { phraseQuery } from '../records/search-sql.js';
import {
  lockRecordsForUpdate,
  type RemovedClaim,
  releaseAndRecompute,
  resolveRecordId,
  type WriteContext,
} from '../records/write.js';
import type { CompiledSchema } from '../schema/compiled.js';
import { prepareSourceErasure } from '../sources/erasure.js';
import {
  requireSuppressionKey,
  suppress,
  suppressibleHandles,
  tombstoneEventIdentity,
} from './suppression.js';

/** How many review candidates of each kind `forget` returns. */
const CANDIDATE_LIMIT = 100;

/**
 * `forget` (2.1): the hard delete for privacy requests. The caller holds
 * the privacy lock exclusively, so no other write runs in the workspace
 * until this commits, and every later write checks the suppression list.
 * Logging takes the same lock in shared mode, so an erasure and a logging
 * of the same event identity never interleave (6.4).
 *
 * Everything is collected first, before cascades or `SET NULL` can erase
 * the dependencies:
 *
 * - the record and every record merged into it;
 * - its emails and phones, from current identifiers, every past email or
 *   phone claim, and the handles of events it was matched in;
 * - the events it took part in, by record or by handle, and the internal
 *   notes `remember` wrote about it (events only `about` it stay, without
 *   the link);
 * - candidates for human review: other live records, facts and events that
 *   mention its name or handles.
 *
 * Then, in this one transaction: claims on other records that cite those
 * events are deleted (facts only once no live source remains) and inbound
 * relation claims are deleted; the affected records are recomputed; the
 * events and the records are hard-deleted, with their assertions, facts,
 * comments, links and identifiers; an erased event's identity, and that of a
 * surviving event whose initial values were erased, is replaced by a keyed
 * tombstone; stored idempotent responses that mention them are deleted; the
 * handles are suppressed by keyed HMAC; and an audit row records who and
 * how many, never what.
 */
export async function forgetRecord(
  tx: Tx,
  context: WriteContext,
  id: string,
): Promise<ForgetResult> {
  requireUser(context.actor, 'forget a record');
  requireSuppressionKey();
  const { workspaceId, schema } = context;
  const root = await resolveRecordId(tx, workspaceId, id);

  const chain = await tx<{ id: string; label: string | null; object_type_id: string }[]>`
    with recursive chain (id) as (
      select ${root}::uuid
      union
      select r.id from records r join chain c on r.merged_into_id = c.id
      where r.workspace_id = ${workspaceId}
    )
    select r.id, r.label, r.object_type_id from records r join chain c on c.id = r.id
    order by r.id`;
  const recordIds = chain.map((r) => r.id);

  // Handles: current identifiers, past claims, and matched participants.
  const handles = new Map<string, Handle>();
  const addHandle = (handle: Handle | null) => {
    if (handle) handles.set(`${handle.kind}:${handle.value}`, handle);
  };
  const identifiers = await tx<{ kind: 'email' | 'phone'; value: string }[]>`
    select distinct kind, value from record_identifiers
    where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])
      and kind in ('email', 'phone')`;
  for (const row of identifiers) addHandle(row);
  const claims = await tx<{ field_id: string; value: unknown }[]>`
    select field_id, value from field_assertions
    where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])
      and value is not null`;
  for (const claim of claims) {
    const field = schema.fieldOwners.get(claim.field_id)?.fieldsById.get(claim.field_id);
    if (field) for (const handle of suppressibleHandles(field, claim.value)) addHandle(handle);
  }
  const matched = await tx<{ handle: string }[]>`
    select distinct handle from event_links
    where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])
      and handle is not null`;
  for (const row of matched) addHandle(parseHandle(row.handle));
  const handleValues = [...handles.values()].map((h) => h.value);

  // Events the record took part in, and the internal notes remember wrote
  // about it. An event that is only `about` the record (a meeting about a
  // company) is someone else's: it stays, without the link. A forgotten
  // record that is itself an event is erased as one.
  const events = await tx<{ id: string }[]>`
    select distinct l.event_id as id from event_links l
    join records ev on ev.id = l.event_id
    where l.workspace_id = ${workspaceId}
      and ((l.link = 'participant'
          and (l.record_id = any(${recordIds}::uuid[]) or l.handle = any(${handleValues}::text[])))
        or (l.link = 'about' and l.record_id = any(${recordIds}::uuid[])
          and ev.object_type_id = ${schema.internalNote?.id ?? null}::uuid))
    union
    select r.id from records r
    where r.id = any(${recordIds}::uuid[])
      and r.object_type_id = any(${schema.eventTypeIds}::uuid[])
    order by 1`;
  const sourceErasure = await prepareSourceErasure(
    tx,
    workspaceId,
    events.map((r) => r.id),
    handleValues,
  );
  const eventIds = sourceErasure.eventIds;
  const erased = [...new Set([...recordIds, ...eventIds])];
  const fileErasure = await collectFileErasure(tx, erased, eventIds, sourceErasure.fileIds);

  const reviewCandidates = await findMentions(
    tx,
    workspaceId,
    schema,
    erased,
    chain.flatMap((r) => (r.label?.trim() ? [r.label.trim()] : [])),
    handleValues,
  );

  // Claims on other records that cite those events or point at the record.
  const object = schema.objectsById.get(chain[0]?.object_type_id ?? '');
  const relationFieldIds = object ? inboundRelationFields(schema, object) : [];
  const pointsAtRecord = tx`field_id = any(${relationFieldIds}::uuid[])
    and value = any(array(select to_jsonb(x::text) from unnest(${recordIds}::uuid[]) x))`;
  // A set (many_to_many) that holds the record, in any assertion, current
  // or historical: the record is removed from it, so no recomputation can
  // bring it back (5.3).
  const holdsRecord = tx`field_id = any(${relationFieldIds}::uuid[])
    and jsonb_typeof(value) = 'array' and value ?| ${recordIds}::text[]`;
  const elsewhere = tx`workspace_id = ${workspaceId} and record_id <> all(${erased}::uuid[])`;
  const affected = await tx<{ record_id: string }[]>`
    select distinct record_id from field_assertions
    where ${elsewhere}
      and (source_record_id = any(${eventIds}::uuid[]) or (${pointsAtRecord})
        or (${holdsRecord}))`;
  const locked = await lockRecordsForUpdate(tx, workspaceId, [
    ...new Set([...erased, ...affected.map((r) => r.record_id), ...fileErasure.recordIds]),
  ]);

  const fileRemoval = await eraseFileReferences(tx, context, fileErasure.fileIds, locked);

  // Surviving events whose initial values are erased below lose their raw
  // identity (6.4): the caller-chosen channel and external ID may identify.
  const initialErased = await tx<{ record_id: string }[]>`
    select distinct record_id from field_assertions
    where ${elsewhere} and is_initial and ((${pointsAtRecord}) or (${holdsRecord}))`;
  const identities = await tx<{ record_id: string; channel: string; external_id: string }[]>`
    select record_id, channel, external_id from event_records
    where workspace_id = ${workspaceId} and external_id is not null and channel is not null
      and record_id = any(${[...eventIds, ...initialErased.map((r) => r.record_id)]}::uuid[])`;

  const [counted] = await tx<{ assertions: number }[]>`
    select count(*)::int as assertions from field_assertions
    where workspace_id = ${workspaceId} and record_id = any(${erased}::uuid[])`;
  const ownFacts = await tx<{ id: string }[]>`
    select id from facts where workspace_id = ${workspaceId} and record_id = any(${erased}::uuid[])`;
  // Deleted ones too: their text is still stored until this removes it.
  const comments = await tx<{ id: string }[]>`
    delete from comments where workspace_id = ${workspaceId} and record_id = any(${erased}::uuid[])
    returning id`;

  const cited = await tx<RemovedClaim[]>`
    delete from field_assertions
    where ${elsewhere} and source_record_id = any(${eventIds}::uuid[])
    returning record_id, field_id, status`;
  const inboundRelations = await tx<RemovedClaim[]>`
    delete from field_assertions where ${elsewhere} and ${pointsAtRecord}
    returning record_id, field_id, status`;
  const trimmed = await tx<RemovedClaim[]>`
    update field_assertions set value = (
      select coalesce(jsonb_agg(v order by v collate "C"), '[]'::jsonb)
      from jsonb_array_elements_text(value) v
      where v <> all(${recordIds}::text[]))
    where ${elsewhere} and ${holdsRecord}
    returning record_id, field_id, status`;
  const recomputed = await releaseAndRecompute(
    tx,
    context,
    locked.filter((r) => !erased.includes(r.id)),
    [...cited, ...inboundRelations, ...trimmed],
  );

  // Facts on other records: drop the deleted sources, then any fact left
  // without a live source.
  const unsourced = await tx<{ fact_id: string }[]>`
    delete from fact_sources
    where workspace_id = ${workspaceId} and source_record_id = any(${eventIds}::uuid[])
    returning fact_id`;
  const orphaned = await tx<{ id: string }[]>`
    delete from facts f
    where f.workspace_id = ${workspaceId}
      and f.id = any(${[...new Set(unsourced.map((s) => s.fact_id))]}::uuid[])
      and f.record_id <> all(${erased}::uuid[])
      and not exists (${liveFactSource(tx, tx`f.id`)})
    returning f.id`;

  // Other people's private facts and quotes resting on what is erased,
  // before the foreign keys below clear their citations (personal memory
  // spec 4.6). Nothing comes back: not even a count.
  await tx`select retainer_erase_private_derivatives(${workspaceId}::uuid, ${erased}::uuid[])`;

  await tombstoneEventIdentity(
    tx,
    workspaceId,
    identities.map((i) => ({ channel: i.channel, externalId: i.external_id })),
  );
  await tx`
    update event_records set channel = null, external_id = null
    where workspace_id = ${workspaceId}
      and record_id = any(${initialErased.map((r) => r.record_id)}::uuid[])`;
  await tx`
    delete from event_links
    where workspace_id = ${workspaceId} and record_id = any(${recordIds}::uuid[])`;
  await tx`delete from records where id = any(${erased}::uuid[])`;

  // Stored responses mentioning any erased row are erased too.
  const orphanedIds = new Set(orphaned.map((f) => f.id));
  const erasedIds = [
    ...erased,
    ...orphanedIds,
    ...ownFacts.map((f) => f.id),
    ...comments.map((c) => c.id),
  ];
  await tx`
    delete from idempotency_keys k
    where k.workspace_id = ${workspaceId} and k.result is not null
      and exists (select 1 from unnest(${erasedIds}::text[]) x
        where strpos(k.result::text, x) > 0)`;

  const suppressedHandles = await suppress(tx, workspaceId, [...handles.values()]);
  const counts: ForgetResult['counts'] = {
    records: recordIds.length,
    events: eventIds.filter((id) => !recordIds.includes(id)).length,
    facts: ownFacts.length + orphaned.length,
    assertions: (counted?.assertions ?? 0) + cited.length,
    inboundRelations: inboundRelations.length + trimmed.length,
    suppressedHandles,
    comments: comments.length,
    ...(fileErasure.fileIds.length ? { files: fileErasure.fileIds.length } : {}),
    ...(sourceErasure.count ? { sourceItems: sourceErasure.count } : {}),
  };
  await tx`
    insert into deletion_audit_log (workspace_id, actor_type, actor_id, counts)
    values (${workspaceId}, ${context.actor.type}, ${context.actor.id}, ${tx.json(counts)})`;

  return {
    id: root,
    forgotten: true,
    counts,
    recomputedRecordIds: [...new Set([...recomputed, ...fileRemoval.recomputedRecordIds])],
    ...(fileRemoval.deletionIds.length
      ? {
          storage: {
            pending: fileRemoval.deletionIds.length,
            deletionIds: fileRemoval.deletionIds,
          },
        }
      : {}),
    // Candidates already exclude the erased records and events; only
    // facts orphaned by the deletion can have gone since.
    reviewCandidates: {
      ...reviewCandidates,
      facts: reviewCandidates.facts.filter((f) => !orphanedIds.has(f)),
    },
  };
}

/**
 * Live rows outside the deletion that may mention the person: by the name
 * (a phrase match on the search vectors) or by a handle in the text, and
 * other records sharing a handle. A best-effort list for a person to check.
 */
async function findMentions(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  recordIds: readonly string[],
  names: readonly string[],
  handles: readonly string[],
): Promise<ForgetResult['reviewCandidates']> {
  const patterns = handles.map((h) => `%${h.replace(/[\\%_]/g, '\\$&')}%`);
  const nameQuery =
    names.length === 0
      ? tx`false`
      : tx`exists (select 1 from unnest(${names as string[]}::text[]) n
          where search @@ ${phraseQuery(tx, tx`n`)})`;
  const records = await tx<{ id: string }[]>`
    select id from records
    where workspace_id = ${workspaceId} and deleted_at is null
      and object_type_id = any(${schema.entityTypeIds}::uuid[])
      and id <> all(${recordIds as string[]}::uuid[])
      and (${nameQuery}
        or id in (select record_id from record_identifiers
          where workspace_id = ${workspaceId} and value = any(${handles as string[]}::text[])))
    order by id limit ${CANDIDATE_LIMIT}`;
  const facts = await tx<{ id: string }[]>`
    select id from facts
    where workspace_id = ${workspaceId} and deleted_at is null
      and record_id <> all(${recordIds as string[]}::uuid[])
      and (${nameQuery} or content ilike any(${patterns}::text[]))
    order by id limit ${CANDIDATE_LIMIT}`;
  const events = await tx<{ id: string }[]>`
    select id from records
    where workspace_id = ${workspaceId} and deleted_at is null
      and object_type_id = any(${schema.eventTypeIds}::uuid[])
      and id <> all(${recordIds as string[]}::uuid[])
      and (${nameQuery} or data::text ilike any(${patterns}::text[]))
    order by id limit ${CANDIDATE_LIMIT}`;
  return {
    records: records.map((r) => r.id),
    facts: facts.map((r) => r.id),
    events: events.map((r) => r.id),
  };
}
