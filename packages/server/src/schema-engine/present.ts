import {
  BASE_EVENT_TYPE_IDS,
  BASE_FIELD_IDS_BY_NAME,
  BASE_OBJECT_IDS,
  EVENT_COLUMNS,
  FIELD_TYPES,
  FIELD_VALUE_FORMATS,
  type FieldSettings,
  type FieldType,
  type ObjectView,
  type SchemaDescription,
  type SchemaDiffOperation,
} from '@retainer/shared';
import type { CompiledSchema } from '../schema/compiled.js';
import type { DiffOp, FieldState, SchemaState, StoredFieldSettings } from '../schema/types.js';
import { PROTECTED_OPTIONS } from './protection.js';

export type { FieldView, ObjectView } from '@retainer/shared';

type BaseObject = NonNullable<ObjectView['baseObject']>;
type BaseField = NonNullable<ObjectView['fields'][number]['baseField']>;

/** Base objects and base event types by universal ID, so clients find them after a rename. */
const BASE_OBJECT_NAMES = new Map<string, BaseObject>(
  Object.entries({ ...BASE_OBJECT_IDS, ...BASE_EVENT_TYPE_IDS }).map(([name, id]) => [
    id,
    name as BaseObject,
  ]),
);
const BASE_FIELD_NAMES = new Map<string, BaseField>(
  Object.entries(BASE_FIELD_IDS_BY_NAME).map(([name, id]) => [id, name as BaseField]),
);

/**
 * Stored field settings with universal IDs turned back into API names.
 * `objectName` and `fieldName` resolve a universal ID; an unknown one is
 * left out rather than shown as an ID.
 */
function settingsByName(
  stored: StoredFieldSettings,
  objectName: (id: string) => string | undefined,
  inverseName: (targetId: string, fieldId: string) => string | undefined,
): FieldSettings {
  const { targetObjectId, targetObjectIds, inverseFieldId, ...rest } = stored;
  const settings: FieldSettings = { ...rest };
  if (targetObjectIds)
    settings.targetObjects = targetObjectIds.flatMap((id) => objectName(id) ?? []);
  if (targetObjectId) {
    const target = objectName(targetObjectId);
    if (target) settings.targetObject = target;
    const inverse = inverseFieldId && inverseName(targetObjectId, inverseFieldId);
    if (inverse) settings.inverseField = inverse;
  }
  return settings;
}

/** Field settings with universal IDs turned back into API names. */
function presentSettings(schema: CompiledSchema, field: FieldState): FieldSettings {
  return settingsByName(
    field.settings,
    (id) => schema.objectsByUniversalId.get(id)?.name,
    (targetId, fieldId) => {
      const inverse = schema.objectsByUniversalId
        .get(targetId)
        ?.state.fields.find((f) => f.universalId === fieldId);
      return inverse?.status === 'active' ? inverse.name : undefined;
    },
  );
}

/**
 * A change's diff as the API shows it: the engine stores labels fields and
 * relation targets by universal ID, and clients know objects and fields by
 * API name. Names are the ones after the change, so they come from `state`
 * (every object and field, deprecated ones too) overlaid with what the
 * change itself creates and renames.
 */
export function presentDiff(ops: readonly DiffOp[], state: SchemaState): SchemaDiffOperation[] {
  const objects = new Map(state.objects.map((o) => [o.universalId, o.nameSingular]));
  const fields = new Map(
    state.objects.flatMap((o) => o.fields.map((f) => [f.universalId, f.name] as const)),
  );
  for (const op of ops) {
    if (op.kind === 'create_object') objects.set(op.object.universalId, op.object.nameSingular);
    if (op.kind === 'rename_object') objects.set(op.objectId, op.to.nameSingular);
    if (op.kind === 'create_field') fields.set(op.field.universalId, op.field.name);
    if (op.kind === 'rename_field') fields.set(op.fieldId, op.to);
  }
  const field = (id: string | null) => (id ? (fields.get(id) ?? null) : null);
  return ops.map((stored): SchemaDiffOperation => {
    // Every reference by name is rebuilt from its universal ID, so a part
    // renamed by a later change is shown by the name it has now.
    const op = { ...stored } as DiffOp;
    if ('objectId' in op && 'object' in op) op.object = objects.get(op.objectId) ?? op.object;
    if ('fieldId' in op && 'field' in op && typeof op.field === 'string')
      op.field = fields.get(op.fieldId) ?? op.field;
    switch (op.kind) {
      case 'create_object': {
        const { labelFieldId, ...object } = op.object;
        return { kind: op.kind, object: { ...object, labelField: field(labelFieldId) } };
      }
      case 'update_object':
        return op.property === 'labelFieldId'
          ? { ...op, property: 'labelField', from: field(op.from), to: field(op.to) }
          : { ...op, property: op.property };
      case 'create_field': {
        const { key: _key, settings, ...rest } = op.field;
        return {
          ...op,
          field: {
            ...rest,
            settings: settingsByName(
              settings,
              (id) => objects.get(id),
              (_target, id) => fields.get(id),
            ),
          },
        };
      }
      default:
        return op;
    }
  });
}

/** The value format of each field type the objects use, in FIELD_TYPES order. */
export function presentValueFormats(objects: ObjectView[]): SchemaDescription['valueFormats'] {
  const used = new Set<FieldType>(objects.flatMap((o) => o.fields.map((f) => f.type)));
  return Object.fromEntries(
    FIELD_TYPES.filter((type) => used.has(type)).map((type) => [type, FIELD_VALUE_FORMATS[type]]),
  );
}

/** The active schema as describe_schema and GET /v1/schema show it (5). */
export function presentSchema(schema: CompiledSchema): ObjectView[] {
  return [...schema.objectsByName.values()].map((object) => ({
    nameSingular: object.state.nameSingular,
    namePlural: object.state.namePlural,
    labelSingular: object.state.labelSingular,
    labelPlural: object.state.labelPlural,
    description: object.state.description,
    labelField: object.labelField?.name ?? null,
    owner: object.state.owner,
    isProtected: object.state.isProtected,
    class: object.state.class,
    ...(object.state.class === 'event' ? { eventColumns: [...EVENT_COLUMNS] } : {}),
    ...(BASE_OBJECT_NAMES.has(object.state.universalId)
      ? { baseObject: BASE_OBJECT_NAMES.get(object.state.universalId) }
      : {}),
    fields: object.activeFields.map((field) => ({
      name: field.name,
      label: field.label,
      description: field.description,
      type: field.type,
      settings: presentSettings(schema, field),
      isNullable: field.isNullable,
      isUnique: field.isUnique,
      isFilterable: field.isFilterable,
      isSearchable: field.isSearchable,
      readOnly: field.settings.isInverse === true,
      owner: field.owner,
      isProtected: field.isProtected,
      ...(PROTECTED_OPTIONS.has(field.universalId)
        ? { protectedOptions: [...(PROTECTED_OPTIONS.get(field.universalId) ?? [])] }
        : {}),
      ...(BASE_FIELD_NAMES.has(field.universalId)
        ? { baseField: BASE_FIELD_NAMES.get(field.universalId) }
        : {}),
      ...(field.coreRole ? { coreRole: field.coreRole } : {}),
    })),
  }));
}
