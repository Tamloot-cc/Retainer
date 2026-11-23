import { createHash } from 'node:crypto';
import {
  PROTECTED_FIELD_IDS,
  PROTECTED_OBJECT_IDS,
  PROTECTED_OPTIONS,
} from '../schema-engine/protection.js';
import { INTERNAL_OPERATIONS } from './base.js';

export function definitionsDigest(
  fields: ReadonlySet<string>,
  options: ReadonlyMap<string, readonly string[]>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operations: INTERNAL_OPERATIONS,
        protected: {
          objects: [...PROTECTED_OBJECT_IDS].sort(),
          fields: [...fields].sort(),
          options: [...options].sort(([a], [b]) => a.localeCompare(b)),
        },
      }),
    )
    .digest('hex');
}

const definitions = {
  operations: INTERNAL_OPERATIONS,
  digest: definitionsDigest(PROTECTED_FIELD_IDS, PROTECTED_OPTIONS),
};

export function definitionsFor() {
  return definitions;
}
