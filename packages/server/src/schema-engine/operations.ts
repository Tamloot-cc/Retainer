import { FIELD_TYPES, OBJECT_CLASSES } from '@retainer/shared';
import { z } from 'zod';

/**
 * The operations a client can request (POST /v1/schema/changes). Objects
 * are referenced by singular API name, fields by API name. Code-defined
 * schema (base objects, templates) uses the same operations and may also
 * reference objects by universal ID and pin universal IDs.
 */

const optionSchema = z.strictObject({
  value: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
});

const fieldSettingsSchema = z.strictObject({
  options: z.array(optionSchema).optional(),
  /** Singular API name (or universal ID) of the target object. */
  targetObject: z.string().min(1).optional(),
  /** Singular API names (or universal IDs) of the objects a polymorphic relation may target. */
  targetObjects: z.array(z.string().min(1)).min(1).max(20).optional(),
  /** Name of the read-only inverse field created on the target object. */
  inverseField: z.string().min(1).optional(),
  /**
   * The owning side: `many_to_one` (default, one record) or `many_to_many`
   * (a set of records). The inverse is derived and read-only.
   */
  relationCardinality: z.enum(['many_to_one', 'many_to_many']).optional(),
  onDelete: z.enum(['set_null', 'cascade']).optional(),
  /** Events attached to the source also show on the target (7.2). */
  rollUpEvents: z.boolean().optional(),
  maxValues: z.number().int().positive().max(100).optional(),
});

export const fieldDefinitionSchema = z.strictObject({
  universalId: z.uuid().optional(),
  name: z.string().min(1),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  type: z.enum(FIELD_TYPES),
  settings: fieldSettingsSchema.optional(),
  isNullable: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  isFilterable: z.boolean().optional(),
  isSearchable: z.boolean().optional(),
});

export const objectDefinitionSchema = z.strictObject({
  universalId: z.uuid().optional(),
  /** `entity` (default) or `event`. An event type gets core title and summary fields. */
  class: z.enum(OBJECT_CLASSES).optional(),
  nameSingular: z.string().min(1),
  namePlural: z.string().min(1),
  labelSingular: z.string().min(1).max(200),
  labelPlural: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  /**
   * Name of the field shown when a record is referenced. Required for an
   * entity; an event type's label is always its core title field.
   */
  labelField: z.string().min(1).optional(),
  avatarField: z.string().min(1).nullable().optional(),
  fields: z.array(fieldDefinitionSchema).default([]),
});

const objectRef = z.string().min(1);
const fieldRef = z.string().min(1);

export const schemaOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('create_object'), object: objectDefinitionSchema }),
  z.strictObject({
    op: z.literal('update_object'),
    object: objectRef,
    labelSingular: z.string().min(1).max(200).optional(),
    labelPlural: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    labelField: z.string().min(1).optional(),
    avatarField: z.string().min(1).nullable().optional(),
  }),
  z.strictObject({
    op: z.literal('rename_object'),
    object: objectRef,
    nameSingular: z.string().min(1),
    namePlural: z.string().min(1),
  }),
  z.strictObject({ op: z.literal('delete_object'), object: objectRef }),
  z.strictObject({
    op: z.literal('create_field'),
    object: objectRef,
    field: fieldDefinitionSchema,
  }),
  z.strictObject({
    op: z.literal('update_field'),
    object: objectRef,
    field: fieldRef,
    label: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    isNullable: z.boolean().optional(),
    isUnique: z.boolean().optional(),
    isFilterable: z.boolean().optional(),
    isSearchable: z.boolean().optional(),
    /** Turn event rollups through this relation on or off (7.2); never destructive. */
    rollUpEvents: z.boolean().optional(),
    /** Accepted only to explain that type changes are not supported. */
    type: z.enum(FIELD_TYPES).optional(),
  }),
  z.strictObject({
    op: z.literal('rename_field'),
    object: objectRef,
    field: fieldRef,
    name: z.string().min(1),
  }),
  z.strictObject({ op: z.literal('delete_field'), object: objectRef, field: fieldRef }),
  z.strictObject({
    op: z.literal('add_option'),
    object: objectRef,
    field: fieldRef,
    option: optionSchema,
  }),
  z.strictObject({
    op: z.literal('update_option'),
    object: objectRef,
    field: fieldRef,
    value: z.string().min(1),
    label: z.string().min(1).max(200),
  }),
  z.strictObject({
    op: z.literal('remove_option'),
    object: objectRef,
    field: fieldRef,
    value: z.string().min(1),
  }),
]);

export type FieldDefinitionInput = z.infer<typeof fieldDefinitionSchema>;
export type ObjectDefinitionInput = z.infer<typeof objectDefinitionSchema>;
export type SchemaOperation = z.infer<typeof schemaOperationSchema>;

/** API callers cannot pin universal IDs; those belong to code-defined schema. */
export function stripUniversalIds(operations: SchemaOperation[]): SchemaOperation[] {
  return operations.map((operation) => {
    if (operation.op === 'create_object') {
      const { universalId: _object, ...object } = operation.object;
      return {
        ...operation,
        object: { ...object, fields: object.fields.map(({ universalId: _f, ...f }) => f) },
      };
    }
    if (operation.op === 'create_field') {
      const { universalId: _field, ...field } = operation.field;
      return { ...operation, field };
    }
    return operation;
  });
}
