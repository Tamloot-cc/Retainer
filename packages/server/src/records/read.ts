import { type Actor, isCollectionRelation, type PresentedRecord } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { AppError, notFound, profileNotSupported } from '../errors.js';
import { eventDetails } from '../memory/event-links.js';
import type { CompiledSchema } from '../schema/compiled.js';
import { resolveRecordId } from './write.js';

export type { PresentedRecord } from '@retainer/shared';

export type RecordRow = {
  id: string;
  workspace_id: string;
  object_type_id: string;
  data: Record<string, unknown>;
  label: string | null;
  created_at: Date;
  updated_at: Date;
  created_by: Actor;
  updated_by: Actor;
};

export const RECORD_COLUMNS = [
  'id',
  'workspace_id',
  'object_type_id',
  'data',
  'label',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
] as const;

const INVERSE_LIMIT = 100;

/**
 * Presents rows of any objects, reading their relations in two queries and,
 * for event records, their built-in columns and links in two more.
 */
export async function presentRecords(
  tx: Tx,
  schema: CompiledSchema,
  rows: RecordRow[],
): Promise<PresentedRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const workspaceId = rows[0]?.workspace_id;
  const events =
    workspaceId === undefined
      ? new Map()
      : await eventDetails(
          tx,
          workspaceId,
          schema,
          rows.filter((r) => schema.objectsById.get(r.object_type_id)?.isEvent),
        );

  // Links whose other end is deleted no longer resolve (set_null on delete).
  const [outgoing, incoming] = await Promise.all([
    tx<{ record_id: string; field_id: string; other_id: string }[]>`
      select l.source_record_id as record_id, l.field_id, l.target_record_id as other_id
      from record_links l
      join records t on t.id = l.target_record_id and t.deleted_at is null
      where l.source_record_id = any(${ids}::uuid[])
      order by l.target_record_id`,
    tx<{ record_id: string; field_id: string; other_id: string }[]>`
      select l.target_record_id as record_id, l.field_id, l.source_record_id as other_id
      from record_links l
      join records s on s.id = l.source_record_id and s.deleted_at is null
      where l.target_record_id = any(${ids}::uuid[])
      order by s.created_at, s.id`,
  ]);

  const values = new Map<string, Record<string, unknown>>(ids.map((id) => [id, {}]));
  for (const link of outgoing) {
    const field = schema.fieldOwners.get(link.field_id)?.fieldsById.get(link.field_id);
    if (field?.status !== 'active') continue;
    const record = values.get(link.record_id) as Record<string, unknown>;
    if (isCollectionRelation(field)) {
      // A set, in ID order; members that were deleted no longer resolve.
      record[field.name] = [...((record[field.name] as string[] | undefined) ?? []), link.other_id];
    } else record[field.name] = link.other_id;
  }
  for (const link of incoming) {
    // The edge belongs to the many_to_one field; show it on that field's inverse.
    const manyToOne = schema.fieldOwners.get(link.field_id)?.fieldsById.get(link.field_id);
    const inverseId = manyToOne?.settings.inverseFieldId;
    const targetObject = schema.objectsByUniversalId.get(manyToOne?.settings.targetObjectId ?? '');
    const inverse = targetObject?.state.fields.find((f) => f.universalId === inverseId);
    if (inverse?.status !== 'active') continue;
    const record = values.get(link.record_id) as Record<string, unknown>;
    const list = (record[inverse.name] as string[] | undefined) ?? [];
    if (list.length < INVERSE_LIMIT) list.push(link.other_id);
    record[inverse.name] = list;
  }

  return rows.map((row) => {
    const object = schema.objectsById.get(row.object_type_id);
    const fields: Record<string, unknown> = {};
    for (const field of object?.activeFields ?? []) {
      if (field.type !== 'relation' && Object.hasOwn(row.data, field.key)) {
        fields[field.name] = row.data[field.key];
      }
      // An empty set reads as [], not as a missing value.
      if (isCollectionRelation(field) && !field.settings.isInverse) fields[field.name] = [];
    }
    Object.assign(fields, values.get(row.id));
    const event = events.get(row.id);
    return {
      id: row.id,
      object: object?.name ?? 'unknown',
      label: row.label,
      fields,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      ...(event ? { event } : {}),
    };
  });
}

/**
 * One live record. A merged ID resolves to the surviving record (4.2); a
 * deleted record, and a record of the hidden internal-note type (6.4), are
 * not found.
 */
export async function getRecord(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  id: string,
): Promise<PresentedRecord> {
  const row = await findLiveRecord(tx, workspaceId, schema, id);
  const [presented] = await presentRecords(tx, schema, [row]);
  return presented as PresentedRecord;
}

/**
 * The live, visible record an ID names, after merges, unpresented: for
 * routes that need only its ID and object. Refuses what `getRecord` refuses.
 */
export async function findLiveRecord(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  id: string,
): Promise<RecordRow> {
  const canonical = await resolveRecordId(tx, workspaceId, id);
  const [row] = await tx<(RecordRow & { deleted_at: Date | null })[]>`
    select ${tx(RECORD_COLUMNS)}, deleted_at from records
    where id = ${canonical} and workspace_id = ${workspaceId}`;
  const object = row && schema.objectsById.get(row.object_type_id);
  if (object?.profile) throw profileNotSupported(id);
  if (!row || object?.hidden) throw notFound('record', { id });
  if (row.deleted_at) {
    throw new AppError(404, 'record_deleted', `record ${canonical} was deleted`, {
      recordId: canonical,
    });
  }
  return row;
}
