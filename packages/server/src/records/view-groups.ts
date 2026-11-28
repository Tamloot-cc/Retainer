import type { Actor } from '@retainer/shared';
import type { Tx } from '../db/tx.js';

/** A deleted target can no longer be hidden as a relation group. */
export async function pruneHiddenViewGroups(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  actor: Actor,
) {
  if (!ids.length) return;
  await tx`
    update views v set
      config = jsonb_set(v.config, '{hiddenGroups}', (
        select coalesce(jsonb_agg(g.value order by g.ordinality), '[]'::jsonb)
        from jsonb_array_elements(v.config -> 'hiddenGroups') with ordinality as g(value, ordinality)
        where g.value = 'null'::jsonb or g.value #>> '{}' <> all(${[...ids]}::text[])
      )),
      updated_by = ${tx.json(actor)},
      updated_at = greatest(clock_timestamp(), v.updated_at + interval '1 millisecond')
    where v.workspace_id = ${workspaceId}
      and (v.config -> 'hiddenGroups') ?| ${[...ids]}::text[]
      and exists (
        select 1 from fields f where f.object_type_id = v.object_type_id
          and f.key = v.config ->> 'groupBy' and f.type = 'relation'
      )`;
}
