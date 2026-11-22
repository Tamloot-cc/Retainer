import {
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
import {
  type DiffOp,
  type FieldState,
  type ObjectState,
  relationTargetIds,
  type SchemaState,
  type StoredFieldSettings,
} from '../schema/types.js';
import { PROTECTED_OPTIONS } from './protection.js';

export type { FieldView, ObjectView } from '@retainer/shared';

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
 * name and read labels, so each step is shown with both, found by ID as the
 * change leaves them: what the change creates, renames or relabels comes
 * from the diff, everything else from `state` (every object and field,
 * deprecated ones too; for an applied change, today's schema). So no client
 * matches names against its own copy of the schema.
 */
export function presentDiff(ops: readonly DiffOp[], state: SchemaState): SchemaDiffOperation[] {
  const objects = new Map(state.objects.map((o) => [o.universalId, o]));
  const fields = new Map(state.objects.flatMap((o) => o.fields.map((f) => [f.universalId, f])));
  // What the change itself gives a part, over what `state` has.
  const objectsAfter = new Map<string, Partial<ObjectState>>();
  const fieldsAfter = new Map<string, Partial<FieldState>>();
  const set = <T>(map: Map<string, Partial<T>>, id: string, values: Partial<T>) =>
    map.set(id, { ...map.get(id), ...values });
  for (const op of ops) {
    if (op.kind === 'create_object') set(objectsAfter, op.object.universalId, op.object);
    if (op.kind === 'rename_object') set(objectsAfter, op.objectId, op.to);
    if (
      op.kind === 'update_object' &&
      (op.property === 'labelSingular' || op.property === 'labelPlural')
    )
      set(objectsAfter, op.objectId, { [op.property]: op.to ?? '' });
    if (op.kind === 'create_field') set(fieldsAfter, op.field.universalId, op.field);
    if (op.kind === 'rename_field') set(fieldsAfter, op.fieldId, { name: op.to });
    if (op.kind === 'update_field' && op.property === 'label' && typeof op.to === 'string')
      set(fieldsAfter, op.fieldId, { label: op.to });
  }
  const object = (id: string) => ({ ...objects.get(id), ...objectsAfter.get(id) });
  const field = (id: string) => ({ ...fields.get(id), ...fieldsAfter.get(id) });
  const fieldName = (id: string | null) => (id ? (field(id).name ?? null) : null);
  const fieldLabel = (id: string | null) => (id ? (field(id).label ?? null) : null);

  const objectRef = (op: { objectId: string; object: string }) => {
    const o = object(op.objectId);
    return {
      object: o.nameSingular ?? op.object,
      objectLabel: o.labelSingular ?? op.object,
      objectClass: o.class ?? 'entity',
    };
  };
  const fieldRef = (op: { objectId: string; object: string; fieldId: string; field: string }) => {
    const f = field(op.fieldId);
    return {
      ...objectRef(op),
      field: f.name ?? op.field,
      fieldLabel: f.label ?? op.field,
      fieldType: f.type ?? null,
    };
  };
  return ops.map((op): SchemaDiffOperation => {
    switch (op.kind) {
      case 'create_object': {
        const { labelFieldId, ...rest } = op.object;
        return {
          kind: op.kind,
          object: {
            ...rest,
            labelField: fieldName(labelFieldId),
            labelFieldLabel: fieldLabel(labelFieldId),
          },
        };
      }
      case 'update_object':
        return op.property === 'labelFieldId'
          ? {
              ...op,
              ...objectRef(op),
              property: 'labelField',
              from: fieldName(op.from),
              to: fieldName(op.to),
              fromLabel: fieldLabel(op.from),
              toLabel: fieldLabel(op.to),
            }
          : { ...op, ...objectRef(op), property: op.property };
      case 'rename_object':
        return { ...op, ...objectRef({ objectId: op.objectId, object: op.to.nameSingular }) };
      case 'create_field': {
        const { key: _key, settings, ...rest } = op.field;
        const targets = relationTargetIds(settings);
        return {
          ...op,
          ...objectRef(op),
          field: {
            ...rest,
            settings: settingsByName(
              settings,
              (id) => object(id).nameSingular,
              (_target, id) => field(id).name,
            ),
          },
          ...(targets.length
            ? {
                targetLabels: targets.map((id) => {
                  const o = object(id);
                  return { singular: o.labelSingular ?? id, plural: o.labelPlural ?? id };
                }),
              }
            : {}),
        };
      }
      case 'rename_field':
        return { ...op, ...fieldRef({ ...op, field: op.to }) };
      case 'remove_option': {
        const { label, ...rest } = op;
        return { ...rest, ...fieldRef(op), optionLabel: label };
      }
      case 'deprecate_object':
      case 'protect_object':
        return { ...op, ...objectRef(op) };
      default:
        // Every other field step: the same shape, plus its labels.
        return { ...op, ...fieldRef(op) };
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

/**
 * The active schema as describe_schema and GET /v1/schema show it (5).
 * `readOnlyFields` are the IDs of installation-owned fields the caller may
 * not write (extensions spec 8).
 */
export function presentSchema(
  schema: CompiledSchema,
  readOnlyFields: ReadonlySet<string> = new Set(),
): ObjectView[] {
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
      readOnly: field.settings.isInverse === true || readOnlyFields.has(field.id as string),
      owner: field.owner,
      isProtected: field.isProtected,
      ...(PROTECTED_OPTIONS.has(field.universalId)
        ? { protectedOptions: [...(PROTECTED_OPTIONS.get(field.universalId) ?? [])] }
        : {}),
      ...(field.coreRole ? { coreRole: field.coreRole } : {}),
    })),
  }));
}
