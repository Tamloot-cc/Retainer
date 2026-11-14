import type { ExtensionManifest } from '@retainer/extension';
import type { FieldState, ObjectState, SchemaState } from '../schema/types.js';

export type ContributionRow = {
  kind: string;
  universal_id: string;
  element_id: string;
  definition: Record<string, unknown>;
};

/**
 * Universal IDs of this installation's contributions that were deleted before
 * the schema engine refused it: a deprecated or missing object or field it
 * owns, and any new field of such an object. Plans treat them as absent: they
 * are not recreated, views over them are skipped and a trigger on such an
 * object never fires (a trigger skips any missing watched field), so a
 * deletion can't block upgrade or enable forever.
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
