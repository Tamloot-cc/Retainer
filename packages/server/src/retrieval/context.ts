import type {
  Actor,
  ContextFact,
  ContextField,
  ContextPack,
  EventItem,
  ProfileContextPack,
} from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import {
  countEventHistory,
  currentFact,
  eventHistory,
  type HistoryRow,
  viaOf,
} from '../memory/events.js';
import { type Profile, type ProfileContext, profileLabel } from '../memory/profiles.js';
import { linkedRecordPage } from '../reads/linked.js';
import { getRecord } from '../records/read.js';
import { type CompiledSchema, eventText } from '../schema/compiled.js';
import {
  CHARS_PER_TOKEN,
  fitLinkedRecords,
  fitSections,
  jsonLength,
  measurePack,
} from './budget.js';

/**
 * Context packs (5, 6.2): what an agent needs about one record, assembled by
 * fixed rules and fitted to a token budget. Nothing is summarized; that is
 * the agent's job.
 */

export const DEFAULT_TOKEN_BUDGET = 2_000;
export const MAX_TOKEN_BUDGET = 16_000;

export const contextInputSchema = z.strictObject({
  tokenBudget: z.number().int().min(1).max(MAX_TOKEN_BUDGET).default(DEFAULT_TOKEN_BUDGET),
});
export type ContextInput = z.infer<typeof contextInputSchema>;

/**
 * The shortest JSON any section item can have: `{"id":"<uuid>"}`. A budget
 * of `n` characters never fits more than `n / MIN_ITEM_CHARS` items, so
 * reading that many rows per section lets the budget, not a row limit, decide
 * what is left out.
 */
const MIN_ITEM_CHARS = 45;

export async function contextPack(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  input: ContextInput,
): Promise<ContextPack> {
  const budgetChars = input.tokenBudget * CHARS_PER_TOKEN;
  const rows = Math.floor(budgetChars / MIN_ITEM_CHARS) + 1;
  // Resolves merged IDs and refuses deleted records, like get_record.
  const record = await getRecord(tx, workspaceId, schema, recordId);
  const [fields, linked, facts, events] = await Promise.all([
    currentFields(tx, workspaceId, schema, record.id, record.fields),
    linkedRecordPage(tx, { workspaceId, schema, recordId: record.id }, { limit: rows }),
    currentFacts(tx, workspaceId, schema, record.id, rows),
    recentEvents(tx, workspaceId, schema, record.id, rows),
  ]);

  // The record's values are always included. The sections get what is left
  // after the whole pack around them: the record, the keys and brackets, and
  // `omitted` and `tokenEstimate` at their largest (every item omitted, an
  // estimate as long as the budget). So a pack whose values fit never
  // serializes to more than the budget.
  const head = { id: record.id, object: record.object, label: record.label, fields };
  const linkedTotal = Object.values(linked.totals).reduce((sum, total) => sum + total, 0);
  const frame: ContextPack = {
    record: head,
    linkedRecords: [],
    facts: [],
    recentEvents: [],
    omitted: { linkedRecords: linkedTotal, facts: facts.total, recentEvents: events.total },
    tokenEstimate: input.tokenBudget,
  };
  const available = Math.max(0, budgetChars - jsonLength(frame));
  const linkedFit = fitLinkedRecords(linked, available);
  const { included } = fitSections(
    { facts: facts.items, recentEvents: events.items },
    available - linkedFit.used,
  );

  const pack: ContextPack = {
    record: head,
    linkedRecords: linkedFit.groups,
    ...included,
    omitted: {
      linkedRecords: linkedTotal - linkedFit.count,
      facts: facts.total - included.facts.length,
      recentEvents: events.total - included.recentEvents.length,
    },
    tokenEstimate: input.tokenBudget,
  };
  return measurePack(pack);
}

/**
 * A profile's context pack (personal memory spec 4.4): its current facts,
 * newest first, fitted to the budget, each with who wrote it and its
 * sources. `me` before any write is empty.
 */
export async function profileContextPack(
  tx: Tx,
  context: ProfileContext,
  profile: Profile,
  input: ContextInput,
): Promise<ProfileContextPack> {
  const budgetChars = input.tokenBudget * CHARS_PER_TOKEN;
  const rows = Math.floor(budgetChars / MIN_ITEM_CHARS) + 1;
  const [label, facts] = await Promise.all([
    profileLabel(tx, context, profile),
    profile.id
      ? currentFacts(tx, context.workspaceId, context.schema, profile.id, rows)
      : { items: [], total: 0 },
  ]);
  const frame: ProfileContextPack = {
    profile: profile.alias,
    label,
    facts: [],
    omitted: { facts: facts.total },
    tokenEstimate: input.tokenBudget,
  };
  const { included } = fitSections(
    { facts: facts.items },
    Math.max(0, budgetChars - jsonLength(frame)),
  );
  const pack: ProfileContextPack = {
    profile: profile.alias,
    label,
    facts: included.facts,
    omitted: { facts: facts.total - included.facts.length },
    tokenEstimate: input.tokenBudget,
  };
  return measurePack(pack);
}

type Section<T> = { items: T[]; total: number };

/**
 * The record's values with the assertion that won each (rule 2.4), so a
 * value is never mistaken for a stated fact. Read-only inverse relations
 * have no assertion of their own. Related records appear in linkedRecords.
 */
async function currentFields(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  values: Record<string, unknown>,
): Promise<Record<string, ContextField>> {
  const winners = await tx<{ field_id: string; actor: Actor; observed_at: Date }[]>`
    select field_id, actor, observed_at from field_assertions
    where workspace_id = ${workspaceId} and record_id = ${recordId} and status = 'active'`;
  const byName = new Map<string, { actor: Actor; observed_at: Date }>();
  for (const winner of winners) {
    const field = schema.fieldOwners.get(winner.field_id)?.fieldsById.get(winner.field_id);
    if (field?.status === 'active') byName.set(field.name, winner);
  }
  const fields: Record<string, ContextField> = {};
  for (const [name, value] of Object.entries(values)) {
    const winner = byName.get(name);
    if (!winner) continue;
    fields[name] = {
      value,
      writtenBy: winner.actor,
      observedAt: winner.observed_at.toISOString(),
    };
  }
  return fields;
}

/** Current facts, newest `validFrom` first, as `GET /v1/records/:id/facts` lists them. */
async function currentFacts(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  limit: number,
): Promise<Section<ContextFact>> {
  const rows = await tx<
    {
      id: string;
      content: string;
      valid_from: Date;
      actor: Actor;
      sources: { id: string; type: string }[];
      total: string;
    }[]
  >`
    select f.id, f.content, f.valid_from, f.actor,
      coalesce((
        select json_agg(json_build_object('id', src.id, 'type', src.object_type_id)
          order by e.occurred_at, s.id)
        from fact_sources s
        join records src on src.id = s.source_record_id and src.deleted_at is null
        join event_records e on e.record_id = src.id
        where s.fact_id = f.id), '[]'::json) as sources,
      count(*) over () as total
    from facts f
    where f.workspace_id = ${workspaceId} and f.record_id = ${recordId}
      and ${currentFact(tx)}
    order by f.valid_from desc, f.created_at desc, f.id
    limit ${limit}`;
  return {
    items: rows.map((row) => {
      // An internal note has no ID a caller can read (6.4): it is marked.
      const internal = row.sources.some((s) => schema.objectsById.get(s.type)?.hidden);
      return {
        id: row.id,
        content: row.content,
        validFrom: row.valid_from.toISOString(),
        writtenBy: row.actor,
        sources: row.sources
          .filter((s) => !schema.objectsById.get(s.type)?.hidden)
          .map((s) => s.id),
        ...(internal ? { internal: true as const } : {}),
      };
    }),
    total: Number(rows[0]?.total ?? 0),
  };
}

/**
 * The record's event history (7.1, 7.2), newest first, each event once with
 * how it is attached (`via`: participant, about, one of the event's own
 * relation fields, then rolled up from a record pointing at this one).
 * Internal notes are never listed: their text is the fact's, already in
 * `facts`.
 */
async function recentEvents(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  limit: number,
): Promise<Section<EventItem>> {
  const rows = await tx<
    (HistoryRow & { id: string; object_type_id: string; data: Record<string, unknown> })[]
  >`
    select r.id, r.object_type_id, r.data, h.occurred_at, h.rank, h.field_id, h.via_record_id
    from ${eventHistory(tx, schema, workspaceId, recordId, { limit })} h
    join records r on r.id = h.event_id
    order by h.occurred_at desc, h.event_id desc
    limit ${limit}`;
  // Counted over the deduplicated history, so `omitted` never counts an
  // event twice (7.2).
  const total =
    rows.length < limit ? rows.length : await countEventHistory(tx, schema, workspaceId, recordId);
  return {
    items: rows.map((row) => {
      const object = schema.objectsById.get(row.object_type_id);
      return {
        id: row.id,
        type: object?.name ?? 'unknown',
        occurredAt: row.occurred_at.toISOString(),
        ...eventText(object, row.data),
        via: viaOf(schema, row),
      };
    }),
    total,
  };
}
