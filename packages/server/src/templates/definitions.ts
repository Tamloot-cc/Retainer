import { createHash } from 'node:crypto';
import type { AppliedTemplate } from '../db/schema.js';
import type { SchemaOperation } from '../schema-engine/operations.js';
import {
  PROTECTED_FIELD_IDS,
  PROTECTED_OBJECT_IDS,
  PROTECTED_OPTIONS,
} from '../schema-engine/protection.js';
import { SEED_OPERATIONS } from './base.js';
import { getTemplate, type Template } from './index.js';

type Definitions = { operations: SchemaOperation[]; digest: string };

/** By sorted template names; the definitions are constant while the process runs. */
const definitionsCache = new Map<string, Definitions>();

/**
 * The code-defined schema a workspace should have (3): the seed operations
 * and those of each template it applied, with a digest that changes when
 * any of them or the protection lists change.
 */
export function definitionsFor(applied: readonly AppliedTemplate[]): Definitions {
  const names = [...new Set(applied.map((t) => t.name))].sort();
  const cacheKey = names.join('\n');
  const cached = definitionsCache.get(cacheKey);
  if (cached) return cached;
  const templates = names.map(getTemplate).filter((t): t is Template => t !== undefined);
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        seed: SEED_OPERATIONS,
        protected: {
          objects: [...PROTECTED_OBJECT_IDS].sort(),
          fields: [...PROTECTED_FIELD_IDS].sort(),
          options: [...PROTECTED_OPTIONS].sort(([a], [b]) => a.localeCompare(b)),
        },
        templates: templates.map((t) => [t.name, t.operations]),
      }),
    )
    .digest('hex');
  const definitions = {
    operations: [...SEED_OPERATIONS, ...templates.flatMap((t) => t.operations)],
    digest,
  };
  definitionsCache.set(cacheKey, definitions);
  return definitions;
}
