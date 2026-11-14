import { BASE_FIELD_IDS_BY_NAME, isInverseRelation } from './schema.js';

/**
 * A field as the mapping rule sees it. The server's schema state names it by
 * `universalId`; the schema API (`FieldView`) keeps universal IDs internal
 * and says only which base field it is, and whether it is `readOnly`.
 */
export type MappingField = {
  type: string;
  universalId?: string;
  baseField?: string;
  readOnly?: boolean;
  settings?: { isInverse?: boolean };
};

/** Why a field can't take a mapped output. */
export type MappingFieldIssue = 'lookup_field' | 'read_only' | 'incompatible_type';

/**
 * Why a field can't take a mapped output, or undefined when it can: the field
 * the extension looks records up by is never a destination, a read-only field
 * (the inverse side of a relation) takes no values, and the field's type must
 * be one the output accepts.
 */
export function mappingFieldIssue(
  field: MappingField,
  output: { types: readonly string[] },
  lookupFieldId?: string,
): MappingFieldIssue | undefined {
  const universalId =
    field.universalId ??
    (field.baseField && (BASE_FIELD_IDS_BY_NAME as Record<string, string>)[field.baseField]);
  if (lookupFieldId && universalId === lookupFieldId) return 'lookup_field';
  if (field.readOnly || (field.settings && isInverseRelation({ settings: field.settings })))
    return 'read_only';
  if (!output.types.includes(field.type)) return 'incompatible_type';
  return undefined;
}

/** The fields a mapped output can be written to, in their order. */
export function compatibleFields<F extends MappingField>(
  fields: readonly F[],
  output: { types: readonly string[] },
  lookupFieldId?: string,
): F[] {
  return fields.filter((field) => !mappingFieldIssue(field, output, lookupFieldId));
}
