import {
  BASE_EVENT_TYPE_IDS,
  BASE_FIELD_IDS_BY_NAME,
  BASE_OBJECT_IDS,
  EVENT_COLUMNS,
  FIELD_TYPES,
  FIELD_VALUE_FORMATS,
  type FieldSettings,
  type FieldType,
  type ObjectClass,
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
 * A change's diff as the API shows it. The engine stores label fields and
 * relation targets by universal ID; clients know objects and fields by API
 * name, so every reference is rebuilt from its ID: parts the change creates
 * or renames get the names it gives them, any other part its name in
 * `state` (every object and field, deprecated ones too). Each step also
 * carries the labels a client shows, found the same way, so no client has
 * to match names against its own copy of the schema.
 */
export function presentDiff(ops: readonly DiffOp[], state: SchemaState): SchemaDiffOperation[] {
  const objectsNow = new Map(state.objects.map((o) => [o.universalId, o]));
  const fieldsNow = new Map(state.objects.flatMap((o) => o.fields.map((f) => [f.universalId, f])));
  const names = new Map([...objectsNow].map(([id, o]) => [id, o.nameSingular]));
  const fieldNames = new Map([...fieldsNow].map(([id, f]) => [id, f.name]));
  const created = new Map<string, { labelSingular: string; class: ObjectClass }>();
  // Labels as the change leaves them, for the parts it names as its result.
  const labelsAfter = new Map(
    state.objects.map((o) => [o.universalId, { singular: o.labelSingular, plural: o.labelPlural }]),
  );
  const fieldLabelsAfter = new Map([...fieldsNow].map(([id, f]) => [id, f.label]));
  for (const op of ops) {
    if (op.kind === 'create_object') {
      const o = op.object;
      names.set(o.universalId, o.nameSingular);
      created.set(o.universalId, o);
      labelsAfter.set(o.universalId, { singular: o.labelSingular, plural: o.labelPlural });
    }
    if (op.kind === 'rename_object') names.set(op.objectId, op.to.nameSingular);
    if (op.kind === 'update_object' && typeof op.to === 'string') {
      const labels = labelsAfter.get(op.objectId);
      if (labels && op.property === 'labelSingular') labels.singular = op.to;
      if (labels && op.property === 'labelPlural') labels.plural = op.to;
    }
    if (op.kind === 'create_field') {
      fieldNames.set(op.field.universalId, op.field.name);
      fieldLabelsAfter.set(op.field.universalId, op.field.label);
    }
    if (op.kind === 'rename_field') fieldNames.set(op.fieldId, op.to);
    if (op.kind === 'update_field' && op.property === 'label' && typeof op.to === 'string')
      fieldLabelsAfter.set(op.fieldId, op.to);
  }
  const fieldName = (id: string | null) => (id ? (fieldNames.get(id) ?? null) : null);
  const fieldLabel = (id: string | null) => (id ? (fieldLabelsAfter.get(id) ?? null) : null);
  const objectRef = (id: string, name: string) => {
    const o = objectsNow.get(id) ?? created.get(id);
    return {
      objectId: id,
      object: names.get(id) ?? name,
      objectLabel: o?.labelSingular ?? name,
      objectClass: o?.class ?? 'entity',
    };
  };
  const fieldRef = (op: { objectId: string; object: string; fieldId: string; field: string }) => {
    const f = fieldsNow.get(op.fieldId);
    return {
      ...objectRef(op.objectId, op.object),
      fieldId: op.fieldId,
      field: fieldNames.get(op.fieldId) ?? op.field,
      fieldLabel: f?.label ?? op.field,
      fieldType: f?.type ?? null,
    };
  };
  return ops.map((op): SchemaDiffOperation => {
    switch (op.kind) {
      case 'create_object': {
        const { labelFieldId, ...object } = op.object;
        return {
          kind: op.kind,
          object: {
            ...object,
            labelField: fieldName(labelFieldId),
            labelFieldLabel: fieldLabel(labelFieldId),
          },
        };
      }
      case 'update_object': {
        const ref = objectRef(op.objectId, op.object);
        return op.property === 'labelFieldId'
          ? {
              ...ref,
              kind: op.kind,
              property: 'labelField',
              from: fieldName(op.from),
              to: fieldName(op.to),
              // The old one as it reads now; the new one as the change leaves it.
              fromLabel: op.from ? (fieldsNow.get(op.from)?.label ?? null) : null,
              toLabel: fieldLabel(op.to),
            }
          : { ...ref, kind: op.kind, property: op.property, from: op.from, to: op.to };
      }
      case 'rename_object': {
        const { object: _name, ...ref } = objectRef(op.objectId, op.to.nameSingular);
        return { ...ref, kind: op.kind, from: op.from, to: op.to };
      }
      case 'deprecate_object':
      case 'protect_object':
        return { ...objectRef(op.objectId, op.object), kind: op.kind };
      case 'create_field': {
        const { key: _key, settings, ...rest } = op.field;
        const targets =
          settings.targetObjectIds ?? (settings.targetObjectId ? [settings.targetObjectId] : []);
        return {
          ...objectRef(op.objectId, op.object),
          kind: op.kind,
          field: {
            ...rest,
            settings: settingsByName(
              settings,
              (id) => names.get(id),
              (_target, id) => fieldNames.get(id),
            ),
          },
          targetLabels: targets.map(
            (id) =>
              labelsAfter.get(id) ?? { singular: names.get(id) ?? id, plural: names.get(id) ?? id },
          ),
        };
      }
      case 'rename_field': {
        const { field: _name, ...ref } = fieldRef({ ...op, field: op.to });
        return { ...ref, kind: op.kind, from: op.from, to: op.to };
      }
      case 'update_field':
        return { ...fieldRef(op), kind: op.kind, property: op.property, from: op.from, to: op.to };
      case 'deprecate_field':
      case 'protect_field':
        return { ...fieldRef(op), kind: op.kind };
      case 'add_option':
        return { ...fieldRef(op), kind: op.kind, option: op.option };
      case 'update_option':
        return { ...fieldRef(op), kind: op.kind, value: op.value, from: op.from, to: op.to };
      case 'remove_option':
        return {
          ...fieldRef(op),
          kind: op.kind,
          value: op.value,
          optionLabel:
            fieldsNow.get(op.fieldId)?.settings.options?.find((o) => o.value === op.value)?.label ??
            null,
        };
      default:
        return op satisfies never;
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
