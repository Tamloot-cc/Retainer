import {
  FieldValueError,
  isCollectionRelation,
  type ValueError,
  validateFieldValue,
  valueError,
} from '@retainer/shared';

export { normalizeFieldValue } from '@retainer/shared';

import { AppError } from '../errors.js';
import type { CompiledObject } from '../schema/compiled.js';
import type { FieldState } from '../schema/types.js';

/**
 * Validates a request's values against one object, keyed by field name.
 * Returns the writes keyed by field, or throws one error that lists every
 * problem, each naming the field and, where it helps, the allowed values.
 */
export function prepareValues(
  object: CompiledObject,
  values: Record<string, unknown>,
  mode: 'create' | 'update',
): Map<FieldState, unknown> {
  const errors: ValueError[] = [];
  const writes = new Map<FieldState, unknown>();

  for (const [name, value] of Object.entries(values)) {
    const field = object.fieldsByName.get(name);
    if (!field) {
      errors.push({
        field: name,
        message: `unknown field on ${object.name}`,
        allowed: object.activeFields.filter((f) => !f.settings.isInverse).map((f) => f.name),
      });
      continue;
    }
    if (value === undefined) continue;
    if (value === null && !isCollectionRelation(field)) {
      if (!field.isNullable)
        errors.push({ field: name, message: 'is required and cannot be null' });
      else writes.set(field, null);
      continue;
    }
    try {
      writes.set(field, validateFieldValue(field, value));
    } catch (error) {
      if (!(error instanceof FieldValueError)) throw error;
      errors.push(valueError(name, field.type, error));
    }
  }

  if (mode === 'create') {
    for (const field of object.activeFields) {
      if (!field.isNullable && !writes.has(field) && !errors.some((e) => e.field === field.name)) {
        errors.push({ field: field.name, message: 'is required' });
      }
    }
  }

  if (errors.length > 0) {
    throw new AppError(422, 'invalid_values', `invalid values for ${object.name}`, { errors });
  }
  return writes;
}
