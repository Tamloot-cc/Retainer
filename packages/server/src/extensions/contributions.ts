import type { ExtensionManifest, SchemaContribution } from '@retainer/extension';
import { AppError } from '../errors.js';
import type { FieldState, ObjectState, SchemaState } from '../schema/types.js';
import type { SchemaOperation } from '../schema-engine/operations.js';
import { stableJson } from '../stable-json.js';

export type ContributionRow = {
  kind: string;
  universal_id: string;
  element_id: string;
  definition: Record<string, unknown>;
};
function conflict(id: string, properties: string[], code = 'upgrade_conflict'): never {
  throw new AppError(409, code, 'extension contribution conflicts with retained schema', {
    universalId: id,
    properties,
  });
}

/**
 * Universal IDs of this installation's contributions that were deleted before
 * the schema engine refused it: a deprecated or missing object or field it
 * owns, and any new field of such an object. Plans treat them as absent: they
 * are not recreated, views over them are skipped and triggers on them never
 * fire, so a deletion can't block upgrade or enable forever.
 */
export function retiredContributions(
  current: SchemaState,
  manifest: ExtensionManifest,
  owned: ContributionRow[],
): Set<string> {
  const retired = new Set<string>();
  const elements = new Map<string, ObjectState | FieldState>();
  for (const o of current.objects) {
    if (o.id) elements.set(o.id, o);
    for (const f of o.fields) if (f.id) elements.set(f.id, f);
  }
  for (const c of owned) {
    if (c.kind !== 'object' && c.kind !== 'field') continue;
    const live = elements.get(c.element_id);
    if (live?.status !== 'active') retired.add(c.universal_id);
  }
  const fieldsOf = (objectId: string, ids: string[]) => {
    if (!retired.has(objectId)) return;
    const object = current.objects.find((o) => o.universalId === objectId);
    for (const id of ids)
      if (!object?.fields.some((f) => f.universalId === id && f.status === 'active'))
        retired.add(id);
  };
  for (const c of manifest.schema)
    if (c.kind === 'field') fieldsOf(c.objectId, [c.definition.universalId]);
    else
      fieldsOf(
        c.definition.universalId,
        c.definition.fields.map((f) => f.universalId),
      );
  return retired;
}

/** Additive releases preserve local names, labels, deprecation and omitted elements. */
export function contributionOperations(
  current: SchemaState,
  manifest: ExtensionManifest,
  owned: ContributionRow[],
): SchemaOperation[] {
  const operations: SchemaOperation[] = [];
  const retired = retiredContributions(current, manifest, owned);
  const owner = (kind: string, id: string) =>
    owned.find((c) => c.kind === kind && c.universal_id === id);
  const presentation = (
    kind: 'object' | 'field',
    id: string,
    before: Record<string, unknown>,
    desired: Record<string, unknown>,
    live: ObjectState | FieldState,
    objectId: string,
  ) => {
    const keys =
      kind === 'object'
        ? ['labelSingular', 'labelPlural', 'description']
        : ['label', 'description'];
    const changes: Record<string, unknown> = {};
    for (const key of keys) {
      const previous = before[key] ?? null,
        next = desired[key] ?? null;
      if (previous === next) continue;
      const actual = (live as unknown as Record<string, unknown>)[key] ?? null;
      if (actual !== previous && actual !== next) conflict(id, [key]);
      changes[key] = next;
    }
    if (Object.keys(changes).length && live.status === 'active') {
      operations.push(
        kind === 'object'
          ? { op: 'update_object', object: id, ...changes }
          : { op: 'update_field', object: objectId, field: id, ...changes },
      );
    }
  };
  const field = (
    objectId: string,
    definition: Extract<SchemaContribution, { kind: 'field' }>['definition'],
  ) => {
    const object = current.objects.find((o) => o.universalId === objectId);
    const live = object?.fields.find((f) => f.universalId === definition.universalId);
    const anyLive = current.objects
      .flatMap((o) => o.fields)
      .find((f) => f.universalId === definition.universalId);
    const prior = owner('field', definition.universalId);
    if (anyLive && (!live || !prior || prior.element_id !== live.id))
      conflict(definition.universalId, ['ownership', 'objectId'], 'schema_binding_conflict');
    if (!live) {
      // Deleted before deletion was refused, or new on a deleted object: stays absent.
      if (retired.has(definition.universalId)) return;
      if (object?.status === 'deprecated') conflict(objectId, ['status']);
      operations.push({ op: 'create_field', object: objectId, field: definition });
      return;
    }
    if (!prior) conflict(definition.universalId, ['ownership'], 'schema_binding_conflict');
    const structural = [
      'name',
      'type',
      'settings',
      'isNullable',
      'isUnique',
      'isFilterable',
      'isSearchable',
    ];
    const changed = structural.filter(
      (k) =>
        stableJson(prior.definition[k]) !== stableJson((definition as Record<string, unknown>)[k]),
    );
    if (changed.length) conflict(definition.universalId, changed);
    presentation('field', definition.universalId, prior.definition, definition, live, objectId);
  };
  for (const c of manifest.schema) {
    if (c.kind === 'field') {
      field(c.objectId, c.definition);
      continue;
    }
    const definition = c.definition;
    const live = current.objects.find((o) => o.universalId === definition.universalId);
    const prior = owner('object', definition.universalId);
    if (!live) {
      if (prior) continue;
      // Do not silently adopt a field already used by another object.
      for (const f of definition.fields)
        if (
          current.objects.some((o) =>
            o.fields.some((existing) => existing.universalId === f.universalId),
          )
        )
          conflict(f.universalId, ['ownership'], 'schema_binding_conflict');
      operations.push({ op: 'create_object', object: definition });
      continue;
    }
    if (!prior || prior.element_id !== live.id)
      conflict(definition.universalId, ['ownership'], 'schema_binding_conflict');
    const changed = ['class', 'nameSingular', 'namePlural', 'labelField'].filter(
      (k) =>
        stableJson(prior.definition[k]) !== stableJson((definition as Record<string, unknown>)[k]),
    );
    if (changed.length) conflict(definition.universalId, changed);
    presentation(
      'object',
      definition.universalId,
      prior.definition,
      definition,
      live,
      definition.universalId,
    );
    for (const f of definition.fields) field(definition.universalId, f);
  }
  return operations;
}
