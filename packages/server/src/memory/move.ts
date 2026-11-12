import { isCollectionRelation, type MoveEventsResult } from '@retainer/shared';
import type { Fragment } from 'postgres';
import { z } from 'zod';
import { jsonValue, type Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { emptyValue } from '../records/query.js';
import { normalizeFieldValue, prepareValues } from '../records/values.js';
import {
  type LockedRecord,
  recomputeFields,
  relationTargets,
  type WriteContext,
  writeFields,
} from '../records/write.js';
import type { CompiledObject } from '../schema/compiled.js';
import { type FieldState, relationTargetIds } from '../schema/types.js';
import { requireEventType } from './events.js';

/**
 * Moving events between types (1.3, spec 7 question 2). An event keeps its
 * record ID, its `event_records` row (time and identity), its participants
 * and `about` links, and every claim and fact that cites it: only its type
 * changes. Its field assertions move to the target type's fields, mapped by
 * name or by the caller's mapping, and `records.data`, links, identifiers,
 * label and search are recomputed from them, never written directly.
 *
 * The caller holds the workspace schema lock exclusively, so no write runs
 * against a type or field these events are leaving, and the whole move,
 * one event or every event of a type, commits or fails as one.
 */

/** Most events a move may name explicitly; moving a whole type has no limit. */
export const MAX_MOVE_EVENTS = 1000;

const fieldName = z.string().trim().min(1).max(100);

export const moveEventsInputSchema = z.strictObject({
  from: fieldName.describe('The event type the events have now (API name), e.g. "meeting".'),
  to: fieldName.describe('The event type they move to (API name), e.g. "conversation".'),
  events: z
    .array(z.uuid())
    .min(1)
    .max(MAX_MOVE_EVENTS)
    .optional()
    .describe(
      `Only these events, all of type from (at most ${MAX_MOVE_EVENTS}). Without it, every ` +
        'live event of from moves.',
    ),
  fields: z
    .record(fieldName, fieldName)
    .default({})
    .describe(
      'Source field name to target field name, for fields named differently, e.g. ' +
        '{ "agenda": "topic" }. Other fields map by name; title and summary always map to ' +
        "the target's own.",
    ),
  drop: z
    .array(fieldName)
    .max(200)
    .default([])
    .describe(
      'Source fields whose values you agree to delete because the target has no field for ' +
        'them. Without it, a move that would lose values is refused with the list.',
    ),
  defaults: z
    .record(z.string(), z.unknown())
    .default({})
    .describe(
      'Target field values for moved events that have no value for that field, written as ' +
        'if logged with the event, e.g. { "medium": "meeting" } when moving meetings to ' +
        'conversation.',
    ),
  dryRun: z
    .boolean()
    .default(false)
    .describe('Check the move and report what it would do, changing nothing.'),
});
export type MoveEventsInput = z.infer<typeof moveEventsInputSchema>;

type MovedEvent = LockedRecord & { occurred_at: Date };

type AssertionRow = {
  id: string;
  record_id: string;
  field_id: string;
  value: unknown;
  status: string;
};

/** A source field that cannot move, and why; listed in the refusal. */
type Unmovable = { field: string; reason: string; events: number; assertions: number };

/** How many moved events, and how many of their assertions, some assertions span. */
const counts = (rows: readonly AssertionRow[]) => ({
  events: new Set(rows.map((a) => a.record_id)).size,
  assertions: rows.length,
});

/**
 * The fields of `source` that a move carries, by its plan: core fields to
 * the target's core fields by role, dropped fields, and the rest by the
 * caller's mapping or by name. A field the target cannot hold is `reason`.
 */
type FieldPlan = {
  mapped: { from: FieldState; to: FieldState }[];
  dropped: FieldState[];
  unmapped: { from: FieldState; reason: string }[];
};

const invalidMove = (message: string, details?: Record<string, unknown>) =>
  new AppError(422, 'invalid_move', message, details);

/** Fields a move reads and writes: active, and never the read-only side of a relation. */
const movable = (object: CompiledObject) =>
  object.activeFields.filter((f) => !f.settings.isInverse);

function planFields(
  source: CompiledObject,
  target: CompiledObject,
  input: Pick<MoveEventsInput, 'fields' | 'drop'>,
): FieldPlan {
  const sourceFields = movable(source);
  const targetFields = new Map(movable(target).map((f) => [f.name, f]));
  const plain = (fields: FieldState[]) => fields.filter((f) => !f.coreRole).map((f) => f.name);
  const named = (name: string, what: string) => {
    const field = sourceFields.find((f) => f.name === name);
    if (!field) {
      throw invalidMove(`${source.name} has no field "${name}" to ${what}`, {
        field: name,
        allowed: plain(sourceFields),
      });
    }
    if (field.coreRole) {
      throw invalidMove(
        `${name} is ${source.name}'s core ${field.coreRole}; it always moves to ` +
          `${target.name}'s ${field.coreRole}`,
        { field: name },
      );
    }
    return field;
  };

  const drop = new Set(input.drop.map((name) => named(name, 'drop')));
  const explicit = new Map<FieldState, FieldState>();
  for (const [from, to] of Object.entries(input.fields)) {
    const field = named(from, 'map');
    if (drop.has(field)) {
      throw invalidMove(`${from} is both mapped and dropped; choose one`, { field: from });
    }
    const destination = targetFields.get(to);
    if (!destination || destination.coreRole) {
      throw invalidMove(`${target.name} has no field "${to}" to map ${from} to`, {
        field: from,
        allowed: plain([...targetFields.values()]),
      });
    }
    explicit.set(field, destination);
  }

  const plan: FieldPlan = { mapped: [], dropped: [], unmapped: [] };
  for (const from of sourceFields) {
    if (drop.has(from)) {
      plan.dropped.push(from);
      continue;
    }
    const core = from.coreRole && target.core ? target.core[from.coreRole] : undefined;
    const to = core ?? explicit.get(from) ?? targetFields.get(from.name);
    if (!to || (to.coreRole && !from.coreRole)) {
      plan.unmapped.push({ from, reason: `${target.name} has no field named ${from.name}` });
      continue;
    }
    const mismatch = shapeMismatch(from, to);
    if (mismatch) plan.unmapped.push({ from, reason: mismatch });
    else plan.mapped.push({ from, to });
  }

  // Two fields into one would make one field's claims compete with another's.
  const seen = new Map<FieldState, FieldState>();
  for (const { from, to } of plan.mapped) {
    const other = seen.get(to);
    if (other) {
      throw invalidMove(
        `${other.name} and ${from.name} would both move to ${target.name}.${to.name}`,
        { field: from.name },
      );
    }
    seen.set(to, from);
  }
  return plan;
}

/** Why `to` cannot hold `from`'s values, if it cannot. */
function shapeMismatch(from: FieldState, to: FieldState): string | undefined {
  if (from.type !== to.type) {
    return `${to.name} is a ${to.type} field and ${from.name} is ${from.type}`;
  }
  if (from.type === 'relation' && isCollectionRelation(from) !== isCollectionRelation(to)) {
    return `${to.name} holds ${isCollectionRelation(to) ? 'a set of records' : 'one record'} and ${from.name} does not`;
  }
  return undefined;
}

/**
 * Locks the events to move `FOR UPDATE`, in ID order: the named ones,
 * which must all be live events of `source`, or every live event of it.
 */
async function lockEvents(
  tx: Tx,
  context: WriteContext,
  source: CompiledObject,
  ids: string[] | undefined,
): Promise<MovedEvent[]> {
  const { workspaceId, schema } = context;
  const select = (where: Fragment) => tx<MovedEvent[]>`
    select r.id, r.object_type_id, r.data, r.updated_at, r.deleted_at, r.merged_into_id,
      e.occurred_at
    from records r join event_records e on e.record_id = r.id
    where r.workspace_id = ${workspaceId} and ${where}
    order by r.id for update of r`;
  if (!ids) {
    return select(tx`r.object_type_id = ${source.id} and r.deleted_at is null`);
  }
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  const rows = new Map((await select(tx`r.id = any(${wanted}::uuid[])`)).map((r) => [r.id, r]));
  for (const id of wanted) {
    const row = rows.get(id);
    const object = row && schema.objectsById.get(row.object_type_id);
    // The hidden internal notes, and inactive types, are not found, as on every route.
    if (!row || !object || object.hidden || object.state.status !== 'active') {
      throw notFound('event', { id });
    }
    if (row.deleted_at) throw new AppError(409, 'event_deleted', `event ${id} was deleted`, { id });
    if (row.object_type_id !== source.id) {
      throw new AppError(
        422,
        'wrong_event_type',
        `event ${id} is a ${object.name}, not a ${source.name}`,
        {
          id,
          type: object.name,
        },
      );
    }
  }
  return wanted.map((id) => rows.get(id) as MovedEvent);
}

/** Moves events from one event type to another. See the module comment. */
export async function moveEvents(
  tx: Tx,
  context: WriteContext,
  input: MoveEventsInput,
): Promise<MoveEventsResult> {
  const { workspaceId, schema } = context;
  const source = requireEventType(schema, input.from);
  const target = requireEventType(schema, input.to);
  if (source.id === target.id) {
    throw invalidMove(`the events are already ${target.name}s`, {
      from: source.name,
      to: target.name,
    });
  }
  const plan = planFields(source, target, input);
  const defaults = prepareDefaults(target, input.defaults);
  const events = await lockEvents(tx, context, source, input.events);
  const ids = events.map((e) => e.id);
  const [managed] =
    await tx`select event_id from source_revisions where event_id=any(${ids}::uuid[]) limit 1`;
  if (managed)
    throw new AppError(
      409,
      'immutable_source_revision',
      'managed evidence cannot move between event types; import a new revision',
    );
  const result: MoveEventsResult = {
    id: null,
    dryRun: input.dryRun,
    from: source.name,
    to: target.name,
    eventIds: ids,
    fields: [],
    dropped: [],
    defaults: [],
  };
  if (ids.length === 0) return result;

  const assertions = await tx<AssertionRow[]>`
    select id, record_id, field_id, value, status from field_assertions
    where workspace_id = ${workspaceId} and record_id = any(${ids}::uuid[])`;
  const grouped = new Map<string, AssertionRow[]>();
  for (const a of assertions) {
    const rows = grouped.get(a.field_id);
    if (rows) rows.push(a);
    else grouped.set(a.field_id, [a]);
  }
  const byField = (field: FieldState) => grouped.get(field.id as string) ?? [];

  // Values the target has nowhere to keep never vanish silently: the caller
  // maps them, or lists them in drop.
  const unmovable: Unmovable[] = [];
  for (const { from, reason } of plan.unmapped) {
    const rows = byField(from);
    if (rows.length > 0) unmovable.push({ field: from.name, reason, ...counts(rows) });
  }
  unmovable.push(...(await checkValues(tx, context, target, plan, byField, new Set(ids))));
  if (unmovable.length > 0) {
    throw new AppError(
      422,
      'unmapped_fields',
      `cannot move ${source.name} events to ${target.name} without losing values of: ` +
        `${unmovable.map((u) => `${u.field} (${u.events} events: ${u.reason})`).join('; ')}. ` +
        'Map each to a field that fits with fields, or list it in drop to delete its values',
      { fields: unmovable },
    );
  }
  await checkInboundRelations(tx, context, target, ids);

  for (const event of events) await context.changes?.capture(tx, event.id);
  // From here on, the move itself. Every derived row is rebuilt from the
  // assertions once they belong to the target's fields.
  await tx`
    update records set object_type_id = ${target.id}, data = '{}'::jsonb,
      updated_at = clock_timestamp(), updated_by = ${tx.json(context.actor)}
    where id = any(${ids}::uuid[])`;
  if (plan.mapped.length > 0) {
    await tx`
      update field_assertions a set field_id = m.to_id
      from unnest(${plan.mapped.map((m) => m.from.id as string)}::uuid[],
        ${plan.mapped.map((m) => m.to.id as string)}::uuid[]) as m(from_id, to_id)
      where a.workspace_id = ${workspaceId} and a.record_id = any(${ids}::uuid[])
        and a.field_id = m.from_id`;
  }
  if (plan.dropped.length > 0) {
    await tx`
      delete from field_assertions
      where workspace_id = ${workspaceId} and record_id = any(${ids}::uuid[])
        and field_id = any(${plan.dropped.map((f) => f.id as string)}::uuid[])`;
  }
  await tx`delete from record_links
    where workspace_id = ${workspaceId} and source_record_id = any(${ids}::uuid[])`;
  await tx`delete from record_identifiers
    where workspace_id = ${workspaceId} and record_id = any(${ids}::uuid[])`;

  // A unique value another record claims fails the move, rather than going
  // to review as it would after a retraction (rule 2.4): no value is lost.
  const targetFieldIds = movable(target).map((f) => f.id as string);
  for (const event of events) {
    event.object_type_id = target.id;
    event.data = {};
    await recomputeFields(tx, context, target, event, targetFieldIds, {
      onUniqueConflict: 'refuse',
    });
  }

  result.defaults = await writeDefaults(tx, context, target, events, defaults);
  await requireTargetValues(tx, target, ids);

  result.fields = plan.mapped.map(({ from, to }) => ({
    from: from.name,
    to: to.name,
    events: counts(byField(from)).events,
  }));
  result.dropped = plan.dropped.map((field) => ({ field: field.name, ...counts(byField(field)) }));
  const [logged] = await tx<{ id: string }[]>`
    insert into event_moves (workspace_id, actor, from_object_type_id, to_object_type_id,
      event_ids, fields)
    values (${workspaceId}, ${tx.json(context.actor)}, ${source.id}, ${target.id},
      ${ids}::uuid[], ${tx.json(
        jsonValue({
          mapped: plan.mapped.map(({ from, to }) => ({
            from: { id: from.id, name: from.name },
            to: { id: to.id, name: to.name },
          })),
          dropped: plan.dropped.map((f) => ({ id: f.id, name: f.name })),
          defaults: [...defaults.keys()].map((f) => ({ id: f.id, name: f.name })),
        }),
      )})
    returning id`;
  result.id = input.dryRun ? null : (logged?.id ?? null);
  return result;
}

/** `defaults`, validated against the target like any write; a default needs a value. */
function prepareDefaults(
  target: CompiledObject,
  values: Record<string, unknown>,
): Map<FieldState, unknown> {
  const prepared = prepareValues(target, values, 'update');
  const empty = [...prepared].filter(([, value]) => value === null);
  if (empty.length > 0) {
    throw new AppError(422, 'invalid_values', `invalid defaults for ${target.name}`, {
      errors: empty.map(([field]) => ({
        field: field.name,
        message: 'a default needs a value; leave the field out instead',
      })),
    });
  }
  return prepared;
}

/**
 * Values that would not fit the field they move to: an option the target
 * lacks, a value past its limits, or a relation to a record of an object
 * it cannot point at. Only claims that count now or may count later
 * (active, superseded and pending review) are checked; rejected and
 * retracted ones move as history.
 */
async function checkValues(
  tx: Tx,
  context: WriteContext,
  target: CompiledObject,
  plan: FieldPlan,
  byField: (field: FieldState) => AssertionRow[],
  moving: ReadonlySet<string>,
): Promise<Unmovable[]> {
  const live = (a: AssertionRow) =>
    a.value !== null && ['active', 'superseded', 'pending_review'].includes(a.status);
  const relationIds = plan.mapped
    .filter(({ to }) => to.type === 'relation')
    .flatMap(({ from }) => byField(from).filter(live))
    .flatMap((a) => (Array.isArray(a.value) ? (a.value as string[]) : [a.value as string]));
  // Moved events count as the target type, so links among them stay valid.
  const typeOf = new Map<string, string>();
  if (relationIds.length > 0) {
    const rows = await tx<{ id: string; object_type_id: string }[]>`
      select id, object_type_id from records
      where workspace_id = ${context.workspaceId} and id = any(${[...new Set(relationIds)]}::uuid[])`;
    for (const r of rows) typeOf.set(r.id, moving.has(r.id) ? target.id : r.object_type_id);
  }

  const problems: Unmovable[] = [];
  for (const { from, to } of plan.mapped) {
    const allowed = new Set(relationTargets(context.schema, to).map((o) => o.id));
    const rows: AssertionRow[] = [];
    const reasons = new Set<string>();
    for (const a of byField(from).filter(live)) {
      const reason = valueProblem(context, to, a.value, typeOf, allowed);
      if (!reason) continue;
      rows.push(a);
      reasons.add(reason);
    }
    if (rows.length === 0) continue;
    problems.push({
      field: from.name,
      reason: `${[...reasons].slice(0, 3).join('; ')} (as ${target.name}.${to.name})`,
      ...counts(rows),
    });
  }
  return problems;
}

function valueProblem(
  context: WriteContext,
  to: FieldState,
  value: unknown,
  typeOf: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (to.type === 'relation') {
    const ids = Array.isArray(value) ? (value as string[]) : [value as string];
    const wrong = ids.find((id) => {
      const type = typeOf.get(id);
      return type !== undefined && !allowed.has(type);
    });
    if (!wrong) return undefined;
    const object = context.schema.objectsById.get(typeOf.get(wrong) as string);
    return `points at a ${object?.name ?? 'record'}, which ${to.name} cannot`;
  }
  try {
    normalizeFieldValue(to, value);
    return undefined;
  } catch (error) {
    return `${JSON.stringify(value).slice(0, 80)} does not fit: ${(error as Error).message}`;
  }
}

/**
 * Other records whose relation values point at the events through a field
 * that cannot point at the target type. Its targets are fixed once created
 * (1.1), so such a value would break the field. Current values count, and so
 * do superseded ones: a retraction recomputes a field from its remaining
 * claims (rule 2.4) without checking targets again, so an earlier value can
 * come back. Only active fields of active objects count, since a deleted
 * field is never read or recomputed; deleted records, likewise.
 */
async function checkInboundRelations(
  tx: Tx,
  context: WriteContext,
  target: CompiledObject,
  ids: string[],
): Promise<void> {
  const fields = context.schema.state.objects
    .filter((o) => o.status === 'active')
    .flatMap((o) => o.fields)
    .filter(
      (f) =>
        f.status === 'active' &&
        f.type === 'relation' &&
        !f.settings.isInverse &&
        !relationTargetIds(f.settings).includes(target.state.universalId),
    );
  if (fields.length === 0) return;
  // `?|` matches a string value, or a member of a set, equal to any of the IDs.
  const rows = await tx<{ field_id: string; records: number; current: number }[]>`
    select a.field_id, count(distinct a.record_id)::int as records,
      count(distinct a.record_id) filter (where a.status = 'active')::int as current
    from field_assertions a
    join records s on s.id = a.record_id and s.deleted_at is null
    where a.workspace_id = ${context.workspaceId}
      and a.field_id = any(${fields.map((f) => f.id as string)}::uuid[])
      and a.status in ('active', 'superseded')
      and a.record_id <> all(${ids}::uuid[])
      and a.value ?| ${ids}::text[]
    group by a.field_id`;
  const blocked = rows.flatMap((row) => {
    const owner = context.schema.fieldOwners.get(row.field_id);
    const field = owner?.fieldsById.get(row.field_id);
    return owner && field
      ? [{ object: owner.name, field: field.name, records: row.records, current: row.current }]
      : [];
  });
  if (blocked.length > 0) {
    throw new AppError(
      409,
      'referenced_by_relations',
      `records point at these events through relation fields that cannot point at a ` +
        `${target.name}: ${blocked.map((b) => `${b.object}.${b.field} (${b.records} records)`).join(', ')}. ` +
        "A relation's targets cannot change. Clear the current values (current counts " +
        'them); earlier values the field held count too, since a retraction could restore ' +
        'them, so if any remain, replace the field with one that can point at both types',
      { relations: blocked },
    );
  }
}

/**
 * Writes each default to the moved events with no claim for its field, as
 * the event's own initial value: citing the event, observed when it
 * happened, written by the caller. A later re-log that includes the value
 * then matches (1.3), as if the source had been logged with it.
 */
async function writeDefaults(
  tx: Tx,
  context: WriteContext,
  target: CompiledObject,
  events: MovedEvent[],
  defaults: Map<FieldState, unknown>,
): Promise<MoveEventsResult['defaults']> {
  if (defaults.size === 0) return [];
  const claimed = await tx<{ record_id: string; field_id: string }[]>`
    select distinct record_id, field_id from field_assertions
    where workspace_id = ${context.workspaceId}
      and record_id = any(${events.map((e) => e.id)}::uuid[])
      and field_id = any(${[...defaults.keys()].map((f) => f.id as string)}::uuid[])
      and status in ('active', 'superseded')`;
  const has = new Set(claimed.map((c) => `${c.record_id}:${c.field_id}`));
  const counts = new Map<FieldState, number>([...defaults.keys()].map((f) => [f, 0]));
  for (const event of events) {
    const writes = new Map([...defaults].filter(([field]) => !has.has(`${event.id}:${field.id}`)));
    if (writes.size === 0) continue;
    await writeFields(tx, context, target, event, writes, {
      sourceRecordId: event.id,
      observedAt: event.occurred_at,
      isInitial: true,
    });
    for (const field of writes.keys()) counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  return [...counts].map(([field, events]) => ({ field: field.name, events }));
}

/** Every required field of the target has a value on every moved event. */
async function requireTargetValues(tx: Tx, target: CompiledObject, ids: string[]): Promise<void> {
  const required = movable(target).filter((f) => !f.isNullable);
  if (required.length === 0) return;
  // One pass over the moved events, a count per required field.
  const [row] = await tx<Record<string, number>[]>`
    select ${required
      .map(
        (field, i) => tx`count(*) filter (where ${emptyValue(tx, field)})::int as ${tx(`f${i}`)}`,
      )
      .reduce((a, b) => tx`${a}, ${b}`)}
    from records r where r.id = any(${ids}::uuid[])`;
  const errors = required.flatMap((field, i) => {
    const missing = row?.[`f${i}`] ?? 0;
    return missing > 0
      ? [
          {
            field: field.name,
            message: `is required on ${target.name}, and ${missing} moved events have no value: give one in defaults`,
          },
        ]
      : [];
  });
  if (errors.length > 0) {
    throw new AppError(422, 'invalid_values', `moved events lack required ${target.name} fields`, {
      errors,
    });
  }
}
