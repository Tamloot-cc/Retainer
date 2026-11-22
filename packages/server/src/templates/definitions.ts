import { createHash } from 'node:crypto';
import { PROTECTED_OBJECT_IDS } from '../schema-engine/protection.js';
import { INTERNAL_OPERATIONS } from './base.js';

const definitions = {
  operations: INTERNAL_OPERATIONS,
  digest: createHash('sha256')
    .update(JSON.stringify([INTERNAL_OPERATIONS, [...PROTECTED_OBJECT_IDS].sort()]))
    .digest('hex'),
};

export function definitionsFor() {
  return definitions;
}
