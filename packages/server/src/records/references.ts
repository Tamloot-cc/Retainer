import type { RecordReference } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import type { CompiledSchema } from '../schema/compiled.js';
import type { PresentedRecord } from './read.js';

/**
 * Labels of records a response mentions: relation targets, conflict holders,
 * linked records (ARCHITECTURE.md 7.2, rule 3). Every such
 * label goes through here, so a per-record visibility check has one place to
 * go. The records a response is about (search hits, the record under review)
 * come from their own RLS-bound queries. A missing or deleted record, and
 * one of a deleted or hidden object (6.4), is absent from the result.
 */
export async function references(
  tx: Tx,
  schema: CompiledSchema,
  ids: string[],
): Promise<Record<string, RecordReference>> {
  if (!ids.length) return {};
  const rows = await tx<
    { id: string; label: string | null; object_type_id: string }[]
  >`select id, label, object_type_id from records where id = any(${ids}::uuid[]) and deleted_at is null
    and object_type_id = any(${schema.visibleObjectIds}::uuid[])`;
  return Object.fromEntries(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        label: r.label,
        object: schema.objectsById.get(r.object_type_id)?.name ?? 'unknown',
      },
    ]),
  );
}

/**
 * Labels for every record a page names: relation values and, for events,
 * participants, their candidates and `about` records.
 */
export async function relationReferences(
  tx: Tx,
  schema: CompiledSchema,
  records: PresentedRecord[],
) {
  const ids = records.flatMap((r) => {
    const object = schema.objectsByName.get(r.object);
    const related = (object?.activeFields.filter((f) => f.type === 'relation') ?? []).flatMap(
      (f) => {
        const value = r.fields[f.name];
        return typeof value === 'string'
          ? [value]
          : Array.isArray(value)
            ? (value as string[])
            : [];
      },
    );
    const event = r.event;
    return event
      ? [
          ...related,
          ...event.participants.matched.map((p) => p.recordId),
          ...event.participants.unmatched.flatMap((p) => p.candidates ?? []),
          ...event.about,
        ]
      : related;
  });
  return references(tx, schema, [...new Set(ids)]);
}
