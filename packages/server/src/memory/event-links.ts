import type { AddedLinks, EventDetails, Participants } from '@retainer/shared';
import { z } from 'zod';
import type { EventLink, UnmatchedReason } from '../db/schema.js';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { isSuppressed, suppressedOf } from '../privacy/suppression.js';
import { lockTargets, MAX_MERGE_HOPS } from '../records/write.js';
import { type CompiledSchema, eventText } from '../schema/compiled.js';
import { type Handle, parseHandle } from './handles.js';

/**
 * Event links (1.3): who took part in an event and which records it is
 * about. They are not relation field values: a participant may be an
 * unresolved handle, re-logging adds links rather than replacing a ranked
 * value, and only a person removes them (5.4). Participants are matched
 * synchronously against unique identifiers; Retainer never creates records
 * for the ones it cannot match.
 */

export const MAX_PARTICIPANTS = 200;
/** How many records an event can be `about` in one write. */
const MAX_ABOUT = 200;

export const participantInputSchema = z.strictObject({
  handle: z.string().trim().min(1).max(320).optional(),
  recordId: z.uuid().optional(),
  role: z.string().trim().min(1).max(100).optional(),
});
type ParticipantInput = z.infer<typeof participantInputSchema>;

export const linksInputSchema = z.strictObject({
  participants: z.array(participantInputSchema).max(MAX_PARTICIPANTS).default([]),
  about: z.array(z.uuid()).max(MAX_ABOUT).default([]),
});

/** `POST /v1/events/:id/links`: links to add to a logged event. */
export const addLinksInputSchema = linksInputSchema.refine(
  (input) => input.participants.length > 0 || input.about.length > 0,
  { message: 'give participants, about, or both' },
);
export type AddLinksInput = z.infer<typeof addLinksInputSchema>;

type NormalizedParticipant = {
  handle: Handle | null;
  recordId: string | null;
  role: string | null;
};

type LinkRow = {
  id: string;
  handle: string | null;
  role: string | null;
  record_id: string | null;
  unmatched_reason: UnmatchedReason | null;
  link: EventLink;
};

type StoredLink = LinkRow & { position: number };

/** Parses every handle, listing all invalid participants in one error. */
export function normalizeParticipants(input: readonly ParticipantInput[]): NormalizedParticipant[] {
  const errors: { index: number; handle?: string; message: string }[] = [];
  const participants = input.map((p, index) => {
    if (p.handle === undefined && p.recordId === undefined) {
      errors.push({ index, message: 'give a handle (email or phone), a recordId, or both' });
    }
    let handle: Handle | null = null;
    if (p.handle !== undefined) {
      handle = parseHandle(p.handle);
      if (!handle) {
        errors.push({ index, handle: p.handle, message: 'not an email address or phone number' });
      }
    }
    return { handle, recordId: p.recordId ?? null, role: p.role ?? null };
  });
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_participants', 'some participants are invalid', { errors });
  }
  return participants;
}

type CanonicalRecord = { id: string; deleted: boolean; isEvent?: boolean };

/**
 * Follows `merged_into_id` from each ID to the surviving record (4.2) and
 * reports whether it is deleted. Unknown IDs, events, and records of hidden
 * or deleted objects are absent from the map: a handle only ever matches an
 * entity (1.3).
 */
async function canonicalRecords(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  ids: readonly string[],
): Promise<Map<string, CanonicalRecord>> {
  const rows = await followMerges(tx, workspaceId, ids);
  const entities = new Set(schema.entityTypeIds);
  return new Map(
    rows
      .filter((r) => entities.has(r.object_type_id))
      .map((r) => [r.start_id, { id: r.id, deleted: r.deleted_at !== null }]),
  );
}

/**
 * Follows `merged_into_id` from each ID to the surviving record (4.2), with
 * its object and whether it is deleted. Unknown IDs are absent.
 */
export async function followMerges(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
): Promise<{ start_id: string; id: string; object_type_id: string; deleted_at: Date | null }[]> {
  if (ids.length === 0) return [];
  return tx<{ start_id: string; id: string; object_type_id: string; deleted_at: Date | null }[]>`
    with recursive chain (start_id, id, merged_into_id, object_type_id, deleted_at, hops) as (
      select r.id, r.id, r.merged_into_id, r.object_type_id, r.deleted_at, 0 from records r
      where r.workspace_id = ${workspaceId} and r.id = any(${ids as string[]}::uuid[])
      union all
      select c.start_id, r.id, r.merged_into_id, r.object_type_id, r.deleted_at, c.hops + 1
      from chain c
      join records r on r.id = c.merged_into_id and r.workspace_id = ${workspaceId}
      where c.hops < ${MAX_MERGE_HOPS}
    )
    select start_id, id, object_type_id, deleted_at from chain where merged_into_id is null`;
}

type EmailMatch = { live: string[]; deleted: string[] };

/**
 * The records whose unique identifiers claim each email (1.2), resolved
 * through merges and split into live and deleted. Only claims count: a
 * non-unique email never selects a record.
 */
async function matchEmails(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  emails: readonly string[],
): Promise<Map<string, EmailMatch>> {
  const matches = new Map<string, EmailMatch>();
  if (emails.length === 0) return matches;
  const claims = await tx<{ value: string; record_id: string }[]>`
    select value, record_id from record_identifiers
    where workspace_id = ${workspaceId} and kind = 'email' and is_claim
      and value = any(${emails as string[]}::text[])`;
  const canonical = await canonicalRecords(
    tx,
    workspaceId,
    schema,
    claims.map((c) => c.record_id),
  );
  for (const claim of claims) {
    const record = canonical.get(claim.record_id);
    if (!record) continue;
    const match = matches.get(claim.value) ?? { live: [], deleted: [] };
    const list = record.deleted ? match.deleted : match.live;
    if (!list.includes(record.id)) list.push(record.id);
    matches.set(claim.value, match);
  }
  for (const match of matches.values()) {
    match.live.sort();
    match.deleted.sort();
  }
  return matches;
}

type Resolution = { recordId: string } | { reason: UnmatchedReason; candidates?: string[] };

/**
 * Resolves participants (4.1). A record ID the agent passes is used as
 * given, after following merges; an unknown or deleted one is an error,
 * since the agent named it explicitly. A handle alone resolves only through
 * a unique email claim: phones never resolve on their own, a handle claimed
 * only by deleted records stays unresolved for review (1.2), and one claimed
 * by several live records is ambiguous rather than matched to the first.
 */
export function resolveParticipants(
  participants: readonly NormalizedParticipant[],
  /** The participants' record IDs, following merges. Unknown IDs are absent. */
  records: Map<string, CanonicalRecord>,
  emailMatches: Map<string, EmailMatch>,
): Resolution[] {
  const errors: { index: number; recordId: string; message: string }[] = [];
  const resolutions = participants.map((p, index): Resolution => {
    if (p.recordId) {
      const record = records.get(p.recordId);
      if (!record) {
        errors.push({ index, recordId: p.recordId, message: 'no record with this ID' });
      } else if (record.isEvent) {
        errors.push({
          index,
          recordId: record.id,
          message: 'an event cannot take part in an event',
        });
      } else if (record.deleted) {
        errors.push({ index, recordId: record.id, message: 'the record is deleted' });
      }
      return { recordId: record?.id ?? p.recordId };
    }
    if (p.handle?.kind !== 'email') return { reason: 'phone_only' };
    const match = emailMatches.get(p.handle.value);
    if (!match) return { reason: 'no_match' };
    // The claims were read before the records were locked: a record deleted
    // or merged since counts as it is now.
    const live = [
      ...new Set(
        match.live.flatMap((id) => {
          const record = records.get(id);
          return record && !record.deleted ? [record.id] : [];
        }),
      ),
    ].sort();
    const [only, ...others] = live;
    if (only && others.length === 0) return { recordId: only };
    if (only) return { reason: 'ambiguous', candidates: live };
    return { reason: 'deleted_record' };
  });
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_participants', 'some participant records cannot be used', {
      errors,
    });
  }
  return resolutions;
}

const ambiguousHandles = (rows: readonly LinkRow[]) =>
  rows.flatMap((r) => (r.unmatched_reason === 'ambiguous' && r.handle ? [r.handle] : []));

/**
 * Splits stored participant rows into matched and unmatched, in logged
 * order (6.2). `about` rows are left out: they are not attendees. A matched
 * participant whose record is no longer live (deleted, or its object
 * deleted) drops out of reads, as links to deleted records do.
 */
function presentParticipants(
  rows: readonly LinkRow[],
  live: ReadonlySet<string>,
  candidates: Map<string, EmailMatch>,
): Participants {
  const participants: Participants = { matched: [], unmatched: [] };
  for (const row of rows) {
    if (row.link !== 'participant') continue;
    if (row.record_id) {
      if (!live.has(row.record_id)) continue;
      participants.matched.push({
        id: row.id,
        handle: row.handle,
        role: row.role,
        recordId: row.record_id,
      });
      continue;
    }
    const reason = row.unmatched_reason ?? 'no_match';
    participants.unmatched.push({
      id: row.id,
      handle: row.handle,
      role: row.role,
      reason,
      ...(reason === 'ambiguous'
        ? { candidates: candidates.get(row.handle ?? '')?.live ?? [] }
        : {}),
    });
  }
  return participants;
}

/** The live records an event is `about`, in logged order. */
function aboutOf(rows: readonly LinkRow[], live: ReadonlySet<string>): string[] {
  return rows.flatMap((r) =>
    r.link === 'about' && r.record_id && live.has(r.record_id) ? [r.record_id] : [],
  );
}

/** Of the records links point at, those that are live and of a visible object. */
async function liveRecords(
  tx: Tx,
  schema: CompiledSchema,
  rows: readonly LinkRow[],
): Promise<Set<string>> {
  const ids = [...new Set(rows.flatMap((r) => (r.record_id ? [r.record_id] : [])))];
  if (ids.length === 0) return new Set();
  const found = await tx<{ id: string }[]>`
    select id from records
    where id = any(${ids}::uuid[]) and deleted_at is null
      and object_type_id = any(${schema.visibleObjectIds}::uuid[])`;
  return new Set(found.map((r) => r.id));
}

/** Links as an event presents them, with what a write `added` among them. */
export async function presentLinks(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  rows: readonly LinkRow[],
  changed: readonly LinkRow[] = [],
): Promise<{ participants: Participants; about: string[]; added: AddedLinks }> {
  const [candidates, live] = await Promise.all([
    matchEmails(tx, workspaceId, schema, ambiguousHandles(rows)),
    liveRecords(tx, schema, rows),
  ]);
  return {
    participants: presentParticipants(rows, live, candidates),
    about: aboutOf(rows, live),
    added: {
      participants: presentParticipants(changed, live, candidates),
      about: aboutOf(changed, live),
    },
  };
}

export async function loadLinks(
  tx: Tx,
  workspaceId: string,
  eventId: string,
): Promise<StoredLink[]> {
  return tx<StoredLink[]>`
    select id, position, handle, role, record_id, unmatched_reason, link
    from event_links
    where workspace_id = ${workspaceId} and event_id = ${eventId}
    order by position`;
}

type EventColumnsRow = {
  record_id: string;
  occurred_at: Date;
  channel: string | null;
  external_id: string | null;
};

/**
 * The built-in columns and links of event records, for a page of them, in
 * one read of each table and one shared candidate lookup.
 */
export async function eventDetails(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  events: readonly { id: string; object_type_id: string; data: Record<string, unknown> }[],
): Promise<Map<string, EventDetails>> {
  if (events.length === 0) return new Map();
  const ids = events.map((e) => e.id);
  const [columns, links] = await Promise.all([
    tx<EventColumnsRow[]>`
      select record_id, occurred_at, channel, external_id from event_records
      where workspace_id = ${workspaceId} and record_id = any(${ids}::uuid[])`,
    tx<(LinkRow & { event_id: string })[]>`
      select event_id, id, handle, role, record_id, unmatched_reason, link from event_links
      where workspace_id = ${workspaceId} and event_id = any(${ids}::uuid[])
      order by event_id, position`,
  ]);
  const [candidates, live] = await Promise.all([
    matchEmails(tx, workspaceId, schema, ambiguousHandles(links)),
    liveRecords(tx, schema, links),
  ]);
  const byEvent = new Map<string, LinkRow[]>(ids.map((id) => [id, []]));
  for (const link of links) byEvent.get(link.event_id)?.push(link);
  const byRecord = new Map(columns.map((c) => [c.record_id, c]));
  const details = new Map<string, EventDetails>();
  for (const event of events) {
    const row = byRecord.get(event.id);
    if (!row) continue;
    const rows = byEvent.get(event.id) ?? [];
    details.set(event.id, {
      occurredAt: row.occurred_at.toISOString(),
      channel: row.channel,
      externalId: row.external_id,
      ...eventText(schema.objectsById.get(event.object_type_id), event.data),
      participants: presentParticipants(rows, live, candidates),
      about: aboutOf(rows, live),
    });
  }
  return details;
}

/**
 * The identity of a participant when a write is compared with what is
 * stored (1.3): the role, and the handle if there is one, else the record
 * (after merges). An erased handle is stored as null, so it is compared as
 * "suppressed" rather than by value.
 */
export function participantKey(
  role: string | null,
  handle: string | null,
  recordId: string | null,
) {
  return JSON.stringify([role, handle ? `h:${handle}` : recordId ? `r:${recordId}` : 's']);
}

/** Only safe unresolved rows may be retried; ambiguous rows need a current candidate. */
export function canRematchParticipant(
  row: Pick<LinkRow, 'record_id' | 'unmatched_reason'>,
  participant: NormalizedParticipant & { erased: boolean },
  candidateIds: readonly string[],
  recordId: string | null,
): boolean {
  if (row.record_id || participant.erased) return false;
  return (
    row.unmatched_reason === 'no_match' ||
    row.unmatched_reason === 'phone_only' ||
    (row.unmatched_reason === 'ambiguous' &&
      participant.recordId !== null &&
      recordId !== null &&
      candidateIds.includes(recordId))
  );
}

/**
 * Locks records `FOR KEY SHARE` in sorted order, following merges (4.2), and
 * reports each one's survivor, whether it is deleted and whether it is an
 * event. Unknown IDs, merge
 * chains too long to follow, and records of hidden or deleted objects are
 * absent: an event links only to records a caller can read.
 */
export async function lockLinkTargets(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  ids: readonly string[],
): Promise<Map<string, CanonicalRecord>> {
  const targets = await lockTargets(tx, workspaceId, [...new Set(ids)]);
  const visible = new Set(schema.visibleObjectIds);
  const events = new Set(schema.eventTypeIds);
  const records = new Map<string, CanonicalRecord>();
  for (const [id, row] of targets) {
    if (row && visible.has(row.object_type_id)) {
      records.set(id, {
        id: row.id,
        deleted: row.deleted_at !== null,
        isEvent: events.has(row.object_type_id),
      });
    }
  }
  return records;
}

/**
 * Adds participants and `about` records to an event whose links are
 * `stored` (1.3). A participant already stored (by handle, or by record when
 * it has none) is not added again. Eligible unmatched rows are re-resolved
 * in place; successful resolutions are reported alongside new links. An
 * `about` record already linked to the event is skipped, and a record added
 * as a participant replaces its `about` link: a record is linked once.
 * `about` names live entities only (C4): a new link to an event is refused
 * with `invalid_link`, even the event itself. A link to an event stored before
 * that rule stays, reads as usual and can be removed, and naming it again in a
 * retry is the no-op a retry always is, so no memory changes under anyone.
 *
 * The caller holds the event's row lock (or has just inserted it), so
 * positions never clash. Every record involved is locked `FOR KEY SHARE`
 * before links are compared or written, as relation writes do: a merge
 * locks the record it removes `FOR UPDATE`, so it either commits first and
 * the link goes to the survivor, or waits and then moves the new link too.
 * Returns the event's links after the write and the rows added or resolved.
 */
export async function addLinks(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  eventId: string,
  stored: readonly StoredLink[],
  input: { participants: readonly NormalizedParticipant[]; about: readonly string[] },
): Promise<{ rows: LinkRow[]; changed: LinkRow[] }> {
  // A handle erased by forget is never stored again (2.1). The caller holds
  // the privacy lock in shared mode, so forget cannot run between this check
  // and the commit.
  const [suppressed, emailMatches] = await Promise.all([
    suppressedOf(
      tx,
      workspaceId,
      input.participants.flatMap((p) => (p.handle ? [p.handle] : [])),
    ),
    matchEmails(tx, workspaceId, schema, [
      ...new Set(
        input.participants.flatMap((p) => (p.handle?.kind === 'email' ? [p.handle.value] : [])),
      ),
    ]),
  ]);
  const kept = input.participants.map((p) =>
    p.handle && isSuppressed(suppressed, p.handle)
      ? { ...p, handle: null, erased: true }
      : { ...p, erased: false },
  );
  const records = await lockLinkTargets(tx, workspaceId, schema, [
    ...kept.flatMap((p) => (p.recordId ? [p.recordId] : [])),
    ...input.about,
    ...stored.flatMap((r) => (r.record_id ? [r.record_id] : [])),
    ...[...emailMatches.values()].flatMap((m) => m.live),
  ]);
  records.delete(eventId);
  const survivor = (id: string | null) => (id ? (records.get(id)?.id ?? id) : null);

  // Consume stored rows one at a time, preserving duplicate-handle counts.
  const remaining = new Map<string, LinkRow[]>();
  for (const row of stored) {
    if (row.link !== 'participant') continue;
    const key = participantKey(row.role, row.handle, survivor(row.record_id));
    const queue = remaining.get(key) ?? [];
    queue.push(row);
    remaining.set(key, queue);
  }
  const newParticipants: (NormalizedParticipant & { erased: boolean })[] = [];
  const retries: { row: LinkRow; participant: NormalizedParticipant & { erased: boolean } }[] = [];
  for (const p of kept) {
    const key = participantKey(p.role, p.handle?.value ?? null, survivor(p.recordId));
    // An erased handle may already be linked by an explicit ID. Prefer that
    // row, then consume an unresolved suppressed row without reviving it.
    const row =
      remaining.get(key)?.shift() ??
      (p.erased ? remaining.get(participantKey(p.role, null, null))?.shift() : undefined);
    if (!row) {
      newParticipants.push(p);
      continue;
    }
    const candidates = (emailMatches.get(p.handle?.value ?? '')?.live ?? []).flatMap((id) => {
      const record = records.get(id);
      return record && !record.deleted ? [record.id] : [];
    });
    if (canRematchParticipant(row, p, candidates, survivor(p.recordId))) {
      retries.push({ row, participant: p });
    }
  }
  const retryResolutions = resolveParticipants(
    retries.map((r) => r.participant),
    records,
    emailMatches,
  );
  const resolved: LinkRow[] = [];
  for (const [index, retry] of retries.entries()) {
    const resolution = retryResolutions[index] as Resolution;
    if (!('recordId' in resolution)) continue;
    const [updated] = await tx<LinkRow[]>`
      update event_links set record_id = ${resolution.recordId}, unmatched_reason = null
      where id = ${retry.row.id}
      returning id, handle, role, record_id, unmatched_reason, link`;
    if (updated) resolved.push(updated);
  }
  const resolutions = resolveParticipants(newParticipants, records, emailMatches);
  const attending = new Set([
    ...resolutions.flatMap((r) => ('recordId' in r ? [r.recordId] : [])),
    ...resolved.flatMap((r) => (r.record_id ? [r.record_id] : [])),
  ]);

  // A record that now takes part loses its about link.
  const replaced = stored.filter(
    (r) => r.link === 'about' && attending.has(survivor(r.record_id) as string),
  );
  if (replaced.length > 0) {
    await tx`delete from event_links where id = any(${replaced.map((r) => r.id)}::uuid[])`;
  }

  // About records: known and live, not linked already, each once.
  const linked = new Set([
    ...stored.flatMap((r) => (r.record_id ? [survivor(r.record_id) as string] : [])),
    ...attending,
  ]);
  const errors: { index: number; recordId: string; message: string }[] = [];
  let toEvent = false;
  const newAbout: string[] = [];
  input.about.forEach((id, index) => {
    if (id === eventId) {
      toEvent = true;
      errors.push({ index, recordId: id, message: 'an event cannot be about itself' });
      return;
    }
    const record = records.get(id);
    if (!record) {
      errors.push({ index, recordId: id, message: 'no record with this ID' });
      return;
    }
    if (linked.has(record.id)) return;
    if (record.isEvent) {
      toEvent = true;
      errors.push({
        index,
        recordId: record.id,
        message: 'an event cannot be linked to another event; link the entities it concerns',
      });
      return;
    }
    if (record.deleted) {
      errors.push({ index, recordId: record.id, message: 'the record is deleted' });
      return;
    }
    linked.add(record.id);
    newAbout.push(record.id);
  });
  if (toEvent) {
    throw new AppError(
      422,
      'invalid_link',
      'about names people, companies and other entities, never an event',
      { errors },
    );
  }
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_about', 'some about records cannot be used', { errors });
  }

  let position = Math.max(-1, ...stored.map((r) => r.position)) + 1;
  const inserts = [
    ...newParticipants.map((p, n) => {
      const resolution = resolutions[n] as Resolution;
      const matched = 'recordId' in resolution;
      return {
        workspace_id: workspaceId,
        event_id: eventId,
        position: position++,
        handle: p.handle?.value ?? null,
        role: p.role,
        record_id: matched ? resolution.recordId : null,
        unmatched_reason: matched ? null : p.erased ? 'suppressed' : resolution.reason,
        link: 'participant',
      };
    }),
    ...newAbout.map((recordId) => ({
      workspace_id: workspaceId,
      event_id: eventId,
      position: position++,
      handle: null,
      role: null,
      record_id: recordId,
      unmatched_reason: null,
      link: 'about',
    })),
  ];
  const changed =
    inserts.length > 0
      ? await tx<LinkRow[]>`
          insert into event_links ${tx(inserts)}
          returning id, handle, role, record_id, unmatched_reason, link`
      : [];
  const gone = new Set(replaced.map((r) => r.id));
  const updated = new Map(resolved.map((r) => [r.id, r]));
  return {
    rows: [...stored.filter((r) => !gone.has(r.id)).map((r) => updated.get(r.id) ?? r), ...changed],
    changed: [...resolved, ...changed],
  };
}
