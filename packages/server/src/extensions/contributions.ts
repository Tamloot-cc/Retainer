import type { ExtensionManifest, SchemaContribution } from '@retainer/extension';
import { AppError } from '../errors.js';
import { type ContributionRow, retiredContributions } from '../extension-runtime/retired.js';
import type { FieldState, ObjectState, SchemaState } from '../schema/types.js';
import type { SchemaOperation } from '../schema-engine/operations.js';
import { stableJson } from '../stable-json.js';

export { type ContributionRow, retiredContributions };

function conflict(id: string, properties: string[], code = 'upgrade_conflict'): never {
  throw new AppError(409, code, 'extension contribution conflicts with retained schema', {
    universalId: id,
    properties,
  });
}

/**
 * Presentation properties a workspace may override, like Twenty's overridable
 * label, description and icon (`WORKSPACE_LOCAL_STATE_PROPERTIES` plus the
 * `isOverridable` entity properties). They change how an element reads, never
 * what it stores, so a workspace edit and a publisher edit never conflict.
 * Names, types, settings (options) and constraints are structural.
 */
export const OVERRIDABLE = {
  object: ['labelSingular', 'labelPlural', 'description'],
  field: ['label', 'description'],
} as const;

/**
 * Additive releases preserve local names, deprecation and omitted elements.
 * Each owned contribution's stored definition is the publisher base it was
 * last applied from. A presentation property the workspace changed (live
 * differs from the base) keeps the workspace value and only the base moves to
 * the new release; an unchanged one takes the publisher's new value.
 */
export function contributionOperations(
  current: SchemaState,
  manifest: ExtensionManifest,
  owned: ContributionRow[],
): { operations: SchemaOperation[]; notices: string[] } {
  const operations: SchemaOperation[] = [];
  const notices: string[] = [];
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
    const changes: Record<string, unknown> = {};
    for (const key of OVERRIDABLE[kind]) {
      const previous = before[key] ?? null,
        next = desired[key] ?? null;
      if (previous === next) continue;
      const actual = (live as unknown as Record<string, unknown>)[key] ?? null;
      if (actual === next) continue;
      if (actual !== previous) {
        // The workspace overrode it: its value wins; the base still moves on.
        const what = key === 'description' ? 'description' : 'label';
        const name =
          kind === 'object' ? (live as ObjectState).nameSingular : (live as FieldState).name;
        notices.push(
          `${kind === 'object' ? 'Object' : 'Field'} ${name} keeps the ${what} set in this workspace; this release changes the publisher's ${what} to "${String(next ?? '')}".`,
        );
        continue;
      }
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
  return { operations, notices };
}
