import type { Actor } from '@retainer/shared';
import { ChangeCollector } from '../changes/collect.js';
import type { Tx } from '../db/tx.js';
import { identifiersFor } from '../records/derive.js';
import { rewriteSearchText } from '../records/rebuild-search.js';
import { deleteEventsOfType } from '../records/service.js';
import { compileSchema } from '../schema/compiled.js';
import { loadSchemaState } from '../schema/load.js';
import type { DiffOp, FieldState, ObjectState, SchemaIssue, SchemaState } from '../schema/types.js';
import { repairViews } from '../views/service.js';

/** A change that validates but conflicts with existing records. */
export class SchemaCheckError extends Error {
  constructor(
    readonly issues: SchemaIssue[],
    readonly recordIds: string[],
  ) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'SchemaCheckError';
  }
}

const SAMPLE_LIMIT = 50;

/**
 * Checks existing records before a change makes a field unique or required
 * or removes an option (3). Runs under the exclusive schema lock, so no
 * record write can slip in between the check and the commit.
 */
export async function checkExistingRecords(
  tx: Tx,
  workspaceId: string,
  current: SchemaState,
  desired: SchemaState,
  ops: DiffOp[],
): Promise<void> {
  const issues: SchemaIssue[] = [];
  const recordIds = new Set<string>();
  const objectOf = (universalId: string) =>
    current.objects.find((o) => o.universalId === universalId);
  const desiredField = (objectId: string, fieldId: string) =>
    desired.objects
      .find((o) => o.universalId === objectId)
      ?.fields.find((f) => f.universalId === fieldId);

  for (const op of ops) {
    const object = 'objectId' in op ? objectOf(op.objectId) : undefined;
    if (!object?.id) continue; // a new object has no records

    if (op.kind === 'create_field' && !op.field.isNullable) {
      const rows = await tx<{ id: string }[]>`
        select id from records
        where workspace_id = ${workspaceId} and object_type_id = ${object.id}
          and deleted_at is null
        limit ${SAMPLE_LIMIT}`;
      if (rows.length > 0) {
        issues.push({
          path: `${op.object}.${op.field.name}`,
          message: 'a required field cannot be added while records lack a value for it',
        });
        for (const row of rows) recordIds.add(row.id);
      }
    }

    if (op.kind === 'update_field' && op.to === true && op.property === 'isUnique') {
      const field = desiredField(op.objectId, op.fieldId);
      if (!field) continue;
      const duplicates = await findDuplicateValues(tx, workspaceId, object.id, field);
      if (duplicates.length > 0) {
        issues.push({
          path: `${op.object}.${op.field}`,
          message: 'records share values, so the field cannot be unique',
        });
        for (const id of duplicates) recordIds.add(id);
      }
    }

    if (op.kind === 'update_field' && op.to === false && op.property === 'isNullable') {
      const field = desiredField(op.objectId, op.fieldId);
      if (!field) continue;
      const rows =
        field.type === 'relation'
          ? await tx<{ id: string }[]>`
              select r.id from records r
              where r.workspace_id = ${workspaceId} and r.object_type_id = ${object.id}
                and r.deleted_at is null
                and not exists (select 1 from record_links l
                  where l.source_record_id = r.id and l.field_id = ${field.id ?? null})
              limit ${SAMPLE_LIMIT}`
          : await tx<{ id: string }[]>`
              select id from records
              where workspace_id = ${workspaceId} and object_type_id = ${object.id}
                and deleted_at is null and coalesce(data -> ${field.key}, 'null') = 'null'
              limit ${SAMPLE_LIMIT}`;
      if (rows.length > 0) {
        issues.push({
          path: `${op.object}.${op.field}`,
          message: 'records have no value, so the field cannot be required',
        });
        for (const row of rows) recordIds.add(row.id);
      }
    }

    if (op.kind === 'remove_option') {
      const field = desiredField(op.objectId, op.fieldId);
      if (!field) continue;
      const probe = field.type === 'multi_select' ? [op.value] : op.value;
      const rows = await tx<{ id: string }[]>`
        select id from records
        where workspace_id = ${workspaceId} and object_type_id = ${object.id}
          and deleted_at is null and data @> ${tx.json({ [field.key]: probe })}
        limit ${SAMPLE_LIMIT}`;
      if (rows.length > 0) {
        issues.push({
          path: `${op.object}.${op.field}`,
          message: `records use option "${op.value}"; change their values before removing it`,
        });
        for (const row of rows) recordIds.add(row.id);
      }
    }
  }

  if (issues.length > 0) throw new SchemaCheckError(issues, [...recordIds]);
}

/** Records (soft-deleted included, since they keep their claims) sharing a value. */
async function findDuplicateValues(
  tx: Tx,
  workspaceId: string,
  objectTypeId: string,
  field: FieldState,
): Promise<string[]> {
  const rows = await tx<{ id: string; value: unknown }[]>`
    select id, data -> ${field.key} as value from records
    where workspace_id = ${workspaceId} and object_type_id = ${objectTypeId}
      and merged_into_id is null and data ? ${field.key}`;
  const holders = new Map<string, string[]>();
  for (const row of rows) {
    for (const identifier of identifiersFor({ ...field, isUnique: true }, row.value)) {
      const list = holders.get(identifier.value) ?? [];
      if (!list.includes(row.id)) list.push(row.id);
      holders.set(identifier.value, list);
    }
  }
  return [...holders.values()].filter((ids) => ids.length > 1).flat();
}

/**
 * Step 6 (apply): writes the desired schema. New objects and fields are
 * inserted, changed ones updated; then uniqueness claims and derived
 * search text follow the change. Returns the new schema version.
 */
export async function persistSchema(
  tx: Tx,
  workspaceId: string,
  current: SchemaState,
  desired: SchemaState,
  ops: DiffOp[],
  actor: Actor,
): Promise<number> {
  const changes = ChangeCollector.forSchema(tx, workspaceId, compileSchema(current, 0));
  const affectedObjects = ops
    .flatMap((op) =>
      'objectId' in op &&
      (op.kind === 'deprecate_object' ||
        op.kind === 'deprecate_field' ||
        (op.kind === 'update_object' && op.property === 'labelFieldId'))
        ? [current.objects.find((object) => object.universalId === op.objectId)?.id]
        : [],
    )
    .filter((id): id is string => id !== undefined);
  if (affectedObjects.length) {
    const records = await tx<
      { id: string }[]
    >`select id from records where workspace_id=${workspaceId} and object_type_id=any(${affectedObjects}::uuid[]) order by id for update`;
    for (const record of records) await changes.capture(tx, record.id);
  }
  const createdBy = tx.json(actor);
  const currentObjects = new Map(current.objects.map((o) => [o.universalId, o]));
  const objectIds = new Map<string, string>();
  const fieldIds = new Map<string, string>();
  for (const object of current.objects) {
    objectIds.set(object.universalId, object.id as string);
    for (const field of object.fields) fieldIds.set(field.universalId, field.id as string);
  }

  // Insert new objects, then new fields (relations may point at new objects).
  for (const object of desired.objects) {
    if (currentObjects.has(object.universalId)) continue;
    const [row] = await tx<{ id: string }[]>`
      insert into object_types (workspace_id, universal_id, owner, status, name_singular,
        name_plural, label_singular, label_plural, description, is_protected, class, created_by,
        created_at, updated_at)
      values (${workspaceId}, ${object.universalId}, ${object.owner}, ${object.status},
        ${object.nameSingular}, ${object.namePlural}, ${object.labelSingular},
        ${object.labelPlural}, ${object.description}, ${object.isProtected}, ${object.class},
        ${createdBy}, clock_timestamp(), clock_timestamp())
      returning id`;
    objectIds.set(object.universalId, row?.id as string);
  }

  for (const object of desired.objects) {
    const before = currentObjects.get(object.universalId);
    const existing = new Set(before?.fields.map((f) => f.universalId));
    for (const field of object.fields) {
      if (existing.has(field.universalId)) continue;
      // clock_timestamp keeps definition order in `order by created_at`.
      const [row] = await tx<{ id: string }[]>`
        insert into fields (workspace_id, object_type_id, universal_id, key, name, label,
          description, type, settings, is_nullable, is_unique, is_filterable, is_searchable,
          is_protected, core_role, owner, status, created_by, created_at, updated_at)
        values (${workspaceId}, ${objectIds.get(object.universalId) as string},
          ${field.universalId}, ${field.key}, ${field.name}, ${field.label}, ${field.description},
          ${field.type}, ${tx.json(field.settings)}, ${field.isNullable}, ${field.isUnique},
          ${field.isFilterable}, ${field.isSearchable}, ${field.isProtected}, ${field.coreRole},
          ${field.owner}, ${field.status}, ${createdBy}, clock_timestamp(), clock_timestamp())
        returning id`;
      fieldIds.set(field.universalId, row?.id as string);
    }
  }

  // Update changed objects and fields.
  for (const object of desired.objects) {
    const before = currentObjects.get(object.universalId);
    const labelFieldId = object.labelFieldId ? (fieldIds.get(object.labelFieldId) ?? null) : null;
    const objectId = objectIds.get(object.universalId) as string;
    if (
      !before ||
      before.nameSingular !== object.nameSingular ||
      before.namePlural !== object.namePlural ||
      before.labelSingular !== object.labelSingular ||
      before.labelPlural !== object.labelPlural ||
      before.description !== object.description ||
      before.labelFieldId !== object.labelFieldId ||
      before.isProtected !== object.isProtected ||
      before.status !== object.status
    ) {
      await tx`
        update object_types set name_singular = ${object.nameSingular},
          name_plural = ${object.namePlural}, label_singular = ${object.labelSingular},
          label_plural = ${object.labelPlural}, description = ${object.description},
          label_field_id = ${labelFieldId}, is_protected = ${object.isProtected},
          status = ${object.status}, updated_at = now()
        where id = ${objectId}`;
    }
    const beforeFields = new Map(before?.fields.map((f) => [f.universalId, f]));
    for (const field of object.fields) {
      const previous = beforeFields.get(field.universalId);
      if (!previous || !fieldChanged(previous, field)) continue;
      await tx`
        update fields set name = ${field.name}, label = ${field.label},
          description = ${field.description}, settings = ${tx.json(field.settings)},
          is_nullable = ${field.isNullable}, is_unique = ${field.isUnique},
          is_filterable = ${field.isFilterable}, is_searchable = ${field.isSearchable},
          is_protected = ${field.isProtected}, status = ${field.status}, updated_at = now()
        where id = ${fieldIds.get(field.universalId) as string}`;
    }
  }

  // Follow-up work on existing records.
  const refreshObjects = new Set<string>();
  // Objects whose saved views may name something this change makes unusable.
  const viewObjects = new Set<string>();
  for (const op of ops) {
    // A deleted object is only deprecated, so its views don't cascade (1.4).
    if (op.kind === 'deprecate_object') {
      await tx`delete from views where object_type_id = ${objectIds.get(op.objectId) as string}`;
      // Deleting an event type deletes its events through the same lifecycle
      // as deleting one event (6.4): what cites them is retracted.
      if (currentObjects.get(op.objectId)?.class === 'event') {
        const [workspace] = await tx<{ schema_version: number }[]>`
          select schema_version from workspaces where id = ${workspaceId}`;
        await deleteEventsOfType(
          tx,
          {
            workspaceId,
            actor,
            schema: compileSchema(current, workspace?.schema_version ?? 0),
            confidenceThreshold: 1,
            changes,
          },
          objectIds.get(op.objectId) as string,
        );
      }
    }
    if (
      op.kind === 'deprecate_field' ||
      op.kind === 'remove_option' ||
      (op.kind === 'update_field' && op.property === 'isFilterable' && op.to === false)
    ) {
      viewObjects.add(op.objectId);
    }
    if (op.kind === 'update_field' && op.property === 'isUnique') {
      const fieldId = fieldIds.get(op.fieldId) as string;
      if (op.to === true) {
        const field = findField(desired, op.objectId, op.fieldId);
        if (field) await claimExistingValues(tx, workspaceId, fieldId, field);
      } else {
        await releaseClaims(tx, fieldId);
      }
    }
    if (
      (op.kind === 'update_object' && op.property === 'labelFieldId') ||
      (op.kind === 'update_field' && op.property === 'isSearchable') ||
      op.kind === 'deprecate_field' ||
      op.kind === 'update_option'
    ) {
      refreshObjects.add(op.objectId);
    }
  }
  for (const universalId of refreshObjects) {
    const object = desired.objects.find((o) => o.universalId === universalId);
    if (object && object.status === 'active') {
      await refreshSearchText(tx, workspaceId, objectIds.get(universalId) as string, object);
    }
  }

  const [workspace] = await tx<{ schema_version: number }[]>`
    update workspaces set schema_version = schema_version + 1, updated_at = now()
    where id = ${workspaceId} returning schema_version`;
  const version = workspace?.schema_version as number;
  if (viewObjects.size > 0) {
    // Compiled here, not through the cache: this version isn't committed yet.
    const schema = compileSchema(await loadSchemaState(tx, workspaceId), version);
    await repairViews(
      tx,
      schema,
      [...viewObjects].map((id) => objectIds.get(id) as string),
      actor,
    );
  }
  return version;
}

function findField(state: SchemaState, objectId: string, fieldId: string) {
  return state.objects
    .find((o) => o.universalId === objectId)
    ?.fields.find((f) => f.universalId === fieldId);
}

function fieldChanged(a: FieldState, b: FieldState): boolean {
  return (
    a.name !== b.name ||
    a.label !== b.label ||
    a.description !== b.description ||
    a.isNullable !== b.isNullable ||
    a.isUnique !== b.isUnique ||
    a.isFilterable !== b.isFilterable ||
    a.isSearchable !== b.isSearchable ||
    a.isProtected !== b.isProtected ||
    a.status !== b.status ||
    JSON.stringify(a.settings) !== JSON.stringify(b.settings)
  );
}

/** Populates claims atomically when a field becomes unique (checked beforehand). */
async function claimExistingValues(
  tx: Tx,
  workspaceId: string,
  fieldId: string,
  field: FieldState,
): Promise<void> {
  const records = await tx<{ id: string; value: unknown }[]>`
    select r.id, r.data -> ${field.key} as value from records r
    join fields f on f.id = ${fieldId}
    where r.workspace_id = ${workspaceId} and r.object_type_id = f.object_type_id
      and r.merged_into_id is null and r.data ? ${field.key}`;
  await tx`delete from record_identifiers where field_id = ${fieldId}`;
  for (const record of records) {
    for (const identifier of identifiersFor(field, record.value)) {
      await tx`
        insert into record_identifiers (workspace_id, record_id, field_id, kind, value, is_claim)
        values (${workspaceId}, ${record.id}, ${fieldId}, ${identifier.kind}, ${identifier.value},
          true)`;
    }
  }
}

/** A field that stops being unique keeps its email/phone/domain rows, but not as claims. */
async function releaseClaims(tx: Tx, fieldId: string): Promise<void> {
  await tx`delete from record_identifiers where field_id = ${fieldId} and kind = 'value'`;
  await tx`update record_identifiers set is_claim = false where field_id = ${fieldId}`;
}

/** Recomputes label and search text after the label field or searchable set changed. */
async function refreshSearchText(
  tx: Tx,
  workspaceId: string,
  objectTypeId: string,
  object: ObjectState,
): Promise<void> {
  const labelField = object.fields.find((f) => f.universalId === object.labelFieldId);
  const records = await tx<{ id: string; data: Record<string, unknown> }[]>`
    select id, data from records
    where workspace_id = ${workspaceId} and object_type_id = ${objectTypeId}`;
  await rewriteSearchText(tx, object.fields, labelField, records);
}
