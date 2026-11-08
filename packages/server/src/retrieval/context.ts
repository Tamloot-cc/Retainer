import type {
  Actor,
  ContextFact,
  ContextField,
  ContextPack,
  EventItem,
  OpenTask,
  ProfileContextPack,
} from '@retainer/shared';
import { BASE_FIELD_IDS, BASE_OBJECT_IDS, TASK_DONE_OPTION } from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import {
  countEventHistory,
  eventHistory,
  type HistoryRow,
  liveFactSource,
  viaOf,
} from '../memory/events.js';
import { type Profile, type ProfileContext, profileLabel } from '../memory/profiles.js';
import { getRecord } from '../records/read.js';
import { references } from '../records/references.js';
import { type CompiledSchema, eventText } from '../schema/compiled.js';
import { CHARS_PER_TOKEN, estimateTokens, fitSections, jsonLength } from './budget.js';

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
  const [fields, tasks, facts, events] = await Promise.all([
    currentFields(tx, workspaceId, schema, record.id, record.fields),
    openTasks(tx, workspaceId, schema, record.id, rows),
    currentFacts(tx, workspaceId, schema, record.id, rows),
    recentEvents(tx, workspaceId, schema, record.id, rows),
  ]);

  // The record's values are always included. The sections get what is left
  // after the whole pack around them: the record, the keys and brackets, and
  // `omitted` and `tokenEstimate` at their largest (every item omitted, an
  // estimate as long as the budget). So a pack whose values fit never
  // serializes to more than the budget.
  const head = { id: record.id, object: record.object, label: record.label, fields };
  const frame: ContextPack = {
    record: head,
    openTasks: [],
    facts: [],
    recentEvents: [],
    omitted: { openTasks: tasks.total, facts: facts.total, recentEvents: events.total },
    tokenEstimate: input.tokenBudget,
  };
  const { included } = fitSections(
    { openTasks: tasks.items, facts: facts.items, recentEvents: events.items },
    Math.max(0, budgetChars - jsonLength(frame)),
  );

  const pack: ContextPack = {
    record: head,
    ...included,
    omitted: {
      openTasks: tasks.total - included.openTasks.length,
      facts: facts.total - included.facts.length,
      recentEvents: events.total - included.recentEvents.length,
    },
    tokenEstimate: input.tokenBudget,
  };
  // The estimate covers the whole response, itself included (sized with the
  // budget in its place).
  pack.tokenEstimate = estimateTokens(pack);
  return pack;
}

/**
 * A profile's context pack (personal memory spec 4.4): its current facts,
 * newest first, fitted to the budget, each with who wrote it and its
 * sources. No fields, tasks or events. `me` before any write is empty.
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
  pack.tokenEstimate = estimateTokens(pack);
  return pack;
}

type Section<T> = { items: T[]; total: number };

/**
 * The record's values with the assertion that won each (rule 2.4), so a
 * value is never mistaken for a stated fact. Read-only inverse relations
 * have no assertion of their own and are left out; open tasks cover the
 * links that matter most.
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

/**
 * IDs of active fields. A deleted relation field keeps its `record_links`
 * rows, and `get_record` hides them; links count only through active fields.
 */
function activeFieldIds(schema: CompiledSchema): string[] {
  return [...schema.fieldOwners]
    .filter(([id, object]) => object.fieldsById.get(id)?.status === 'active')
    .map(([id]) => id);
}

/**
 * Live tasks linked to the record in either direction, through an active
 * relation field, whose status is not `done`: earliest due date first,
 * undated last.
 */
async function openTasks(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  recordId: string,
  limit: number,
): Promise<Section<OpenTask>> {
  const task = schema.objectsByUniversalId.get(BASE_OBJECT_IDS.task);
  if (task?.state.status !== 'active') return { items: [], total: 0 };
  const field = (universalId: string) =>
    task.activeFields.find((f) => f.universalId === universalId);
  const status = field(BASE_FIELD_IDS.taskStatus);
  const dueDate = field(BASE_FIELD_IDS.taskDueDate);
  const statusValue = status ? tx`t.data -> ${status.key}` : tx`null::jsonb`;
  const dueValue = dueDate ? tx`t.data -> ${dueDate.key}` : tx`null::jsonb`;
  const notDone = status
    ? tx`and (t.data ->> ${status.key}) is distinct from ${TASK_DONE_OPTION}`
    : tx``;
  const dueOrder = dueDate ? tx`(t.data ->> ${dueDate.key}) asc nulls last,` : tx``;

  const rows = await tx<{ id: string; status: unknown; due_date: unknown; total: string }[]>`
    select t.id, ${statusValue} as status, ${dueValue} as due_date,
      count(*) over () as total
    from records t
    where t.workspace_id = ${workspaceId} and t.object_type_id = ${task.id}
      and t.deleted_at is null and t.id <> ${recordId}
      and exists (
        select 1 from record_links l
        where l.field_id = any(${activeFieldIds(schema)}::uuid[])
          and ((l.source_record_id = t.id and l.target_record_id = ${recordId})
            or (l.source_record_id = ${recordId} and l.target_record_id = t.id)))
      ${notDone}
    order by ${dueOrder} t.created_at, t.id
    limit ${limit}`;
  // Tasks are other records, so their titles come through references() (7.2).
  const refs = await references(
    tx,
    schema,
    rows.map((row) => row.id),
  );
  return {
    items: rows.flatMap((row) => {
      const ref = refs[row.id];
      if (!ref) return [];
      return [
        {
          id: row.id,
          title: ref.label,
          status: row.status ?? null,
          dueDate: row.due_date ?? null,
        },
      ];
    }),
    total: Number(rows[0]?.total ?? 0),
  };
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
      and f.deleted_at is null and f.superseded_by is null and f.replaced_at is null
      and f.valid_to is null
      and exists (${liveFactSource(tx, tx`f.id`)})
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
