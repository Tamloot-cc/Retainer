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
} from '@retainer/shared';
import type { CompiledSchema } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';
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

/** Field settings with universal IDs turned back into API names. */
function presentSettings(schema: CompiledSchema, field: FieldState): FieldSettings {
  const { targetObjectId, targetObjectIds, inverseFieldId, ...rest } = field.settings;
  const settings: FieldSettings = { ...rest };
  if (targetObjectIds) {
    settings.targetObjects = targetObjectIds.flatMap((id) => {
      const target = schema.objectsByUniversalId.get(id);
      return target ? [target.name] : [];
    });
  }
  if (targetObjectId) {
    const target = schema.objectsByUniversalId.get(targetObjectId);
    if (target) settings.targetObject = target.name;
    const inverse = target?.state.fields.find((f) => f.universalId === inverseFieldId);
    if (inverse?.status === 'active') settings.inverseField = inverse.name;
  }
  return settings;
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
