import { HIDDEN_TYPE_IDS } from '@retainer/shared';
import type { SchemaState } from '../schema/types.js';

/**
 * Schema elements server code depends on (ARCHITECTURE.md 1.1). Protection
 * is set by the engine when the element is created, from these lists, and
 * no client operation can assign or clear it. Any new server dependency on
 * a schema element adds it here in the same change. An event type's core
 * fields are protected by the engine when it creates them.
 */
export const PROTECTED_OBJECT_IDS: ReadonlySet<string> = HIDDEN_TYPE_IDS;
export const PROTECTED_FIELD_IDS: ReadonlySet<string> = new Set();
export const PROTECTED_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map();

/** Flags a protected field keeps: changing any of them reshapes the field. */
export const PROTECTED_FIELD_FLAGS = [
  'isNullable',
  'isUnique',
  'isFilterable',
  'isSearchable',
] as const;

/**
 * Protects every element of `state` that the lists above name, in place.
 * Only the engine's trusted path calls it, so a workspace created before an
 * element was protected gets the protection on upgrade (3). Protection is
 * never cleared.
 */
export function applyProtection(state: SchemaState): void {
  for (const object of state.objects) {
    if (PROTECTED_OBJECT_IDS.has(object.universalId)) object.isProtected = true;
    for (const field of object.fields) {
      if (PROTECTED_FIELD_IDS.has(field.universalId)) field.isProtected = true;
    }
  }
}
