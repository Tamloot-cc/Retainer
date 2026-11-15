import type { CoreRole, FieldType, ObjectClass, SchemaOwner, SchemaStatus } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import type { FieldState, ObjectState, SchemaState, StoredFieldSettings } from './types.js';

type ObjectRow = {
  id: string;
  universal_id: string;
  name_singular: string;
  name_plural: string;
  label_singular: string;
  label_plural: string;
  description: string | null;
  label_field_id: string | null;
  avatar_field: { fieldId: string | null } | null;
  is_protected: boolean;
  class: ObjectClass;
  owner: SchemaOwner;
  status: SchemaStatus;
};

type FieldRow = {
  id: string;
  object_type_id: string;
  universal_id: string;
  key: string;
  name: string;
  label: string;
  description: string | null;
  type: FieldType;
  settings: StoredFieldSettings;
  is_nullable: boolean;
  is_unique: boolean;
  is_filterable: boolean;
  is_searchable: boolean;
  is_protected: boolean;
  core_role: CoreRole | null;
  owner: SchemaOwner;
  status: SchemaStatus;
};

/** Step 1 of the engine: a workspace's schema as it is now, deprecated rows included. */
export async function loadSchemaState(tx: Tx, workspaceId: string): Promise<SchemaState> {
  const [objectRows, fieldRows] = await Promise.all([
    tx<ObjectRow[]>`
      select id, universal_id, name_singular, name_plural, label_singular, label_plural,
        description, label_field_id, avatar_field, is_protected, class, owner, status
      from object_types where workspace_id = ${workspaceId}
      order by created_at, id`,
    tx<FieldRow[]>`
      select id, object_type_id, universal_id, key, name, label, description, type, settings,
        is_nullable, is_unique, is_filterable, is_searchable, is_protected, core_role, owner,
        status
      from fields where workspace_id = ${workspaceId}
      order by created_at, id`,
  ]);

  const fieldsByObject = new Map<string, FieldState[]>();
  const universalIdByFieldId = new Map<string, string>();
  for (const row of fieldRows) {
    universalIdByFieldId.set(row.id, row.universal_id);
    const list = fieldsByObject.get(row.object_type_id) ?? [];
    list.push({
      id: row.id,
      universalId: row.universal_id,
      key: row.key,
      name: row.name,
      label: row.label,
      description: row.description,
      type: row.type,
      settings: row.settings,
      isNullable: row.is_nullable,
      isUnique: row.is_unique,
      isFilterable: row.is_filterable,
      isSearchable: row.is_searchable,
      isProtected: row.is_protected,
      coreRole: row.core_role,
      owner: row.owner,
      status: row.status,
    });
    fieldsByObject.set(row.object_type_id, list);
  }

  const objects: ObjectState[] = objectRows.map((row) => ({
    id: row.id,
    universalId: row.universal_id,
    nameSingular: row.name_singular,
    namePlural: row.name_plural,
    labelSingular: row.label_singular,
    labelPlural: row.label_plural,
    description: row.description,
    labelFieldId: row.label_field_id
      ? (universalIdByFieldId.get(row.label_field_id) ?? null)
      : null,
    avatarFieldId: row.avatar_field ? row.avatar_field.fieldId : 'default',
    isProtected: row.is_protected,
    class: row.class,
    owner: row.owner,
    status: row.status,
    fields: fieldsByObject.get(row.id) ?? [],
  }));

  return { objects };
}
