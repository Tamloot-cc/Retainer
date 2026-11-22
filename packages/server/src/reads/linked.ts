import type { LinkedRecord, LinkedRecordPage } from '@retainer/shared';
import type { Fragment } from 'postgres';
import { after, page } from '../db/pagination.js';
import type { Tx } from '../db/tx.js';
import { invalid, notFound } from '../errors.js';
import { references } from '../records/references.js';
import { type CompiledSchema, objectNamed } from '../schema/compiled.js';

type Target = { workspaceId: string; schema: CompiledSchema; recordId: string };

function linkedRows(
  tx: Tx,
  { workspaceId, schema, recordId }: Target,
  objectIds = schema.entityTypeIds,
) {
  const fieldIds = [...schema.fieldOwners].flatMap(([id, owner]) => {
    const field = owner.fieldsById.get(id);
    return field?.status === 'active' && field.type === 'relation' ? [id] : [];
  });

  // The two branches use the outgoing and incoming record_links indexes.
  // Joining records under RLS also gates which edges can contribute to counts.
  return tx`
    from (
      select target_record_id as id, field_id, true as on_anchor from record_links
      where workspace_id = ${workspaceId} and source_record_id = ${recordId}
        and field_id = any(${fieldIds}::uuid[])
      union all
      select source_record_id as id, field_id, false as on_anchor from record_links
      where workspace_id = ${workspaceId} and target_record_id = ${recordId}
        and field_id = any(${fieldIds}::uuid[])
    ) links
    join records r on r.id = links.id
    where r.workspace_id = ${workspaceId} and r.id <> ${recordId}
      and r.deleted_at is null and r.merged_into_id is null and r.private_to_user is null
      and r.object_type_id = any(${objectIds}::uuid[])`;
}

type LinkedCount = { object_type_id: string; total: number };
type LinkedRow = {
  id: string;
  stamp: string;
  field_id: string;
  on_anchor: boolean;
  selects: LinkedRecord['selects'];
};

function countQuery(tx: Tx, links: Fragment) {
  return tx`
    select r.object_type_id, count(distinct r.id)::int as total
    ${links}
    group by r.object_type_id`;
}

function totalsByObject(schema: CompiledSchema, counts: LinkedCount[]) {
  return Object.fromEntries(
    counts.map(({ object_type_id, total }) => {
      const object = schema.objectsById.get(object_type_id);
      if (!object) throw new Error('Linked count returned an object outside the compiled schema');
      return [object.name, total];
    }),
  );
}

export async function countLinkedRecords(tx: Tx, target: Target) {
  const counts = await tx<LinkedCount[]>`${countQuery(tx, linkedRows(tx, target))}`;
  return counts.reduce((sum, { total }) => sum + total, 0);
}

/** One page for an already resolved, visible anchor record. */
export async function linkedRecordPage(
  tx: Tx,
  target: Target,
  { limit, object, cursor }: { limit: number; object?: string; cursor?: string },
): Promise<LinkedRecordPage> {
  const { schema } = target;
  const filter = object === undefined ? undefined : objectNamed(schema, object);
  if (object !== undefined && !filter) throw notFound('object', { object });
  if (filter?.isEvent)
    throw invalid('linked records can only be filtered by an entity object', { object });
  const links = linkedRows(tx, target, filter ? [filter.id] : undefined);
  // Separate aggregations at the same snapshot. Counts need no record values
  // or cursor, and only the requested page contributes row payloads.
  const [result] = await tx<[{ rows: LinkedRow[]; counts: LinkedCount[] }]>`
    select
      coalesce((select json_agg(counts) from (${countQuery(tx, links)}) counts), '[]') as counts,
      coalesce((
        select json_agg(json_build_object(
          'id', candidate.id, 'stamp', candidate.updated_at::text,
          'field_id', candidate.field_id, 'on_anchor', candidate.on_anchor,
          'selects', coalesce((
            select jsonb_object_agg(f.name, r.data -> f.key)
            from fields f
            where f.workspace_id = r.workspace_id and f.object_type_id = r.object_type_id
              and f.status = 'active' and f.type in ('select', 'multi_select') and r.data ? f.key
          ), '{}'::jsonb)
        ) order by candidate.updated_at desc, candidate.id desc)
        from (
          select * from (
            select distinct on (r.id) r.id, r.updated_at, links.field_id, links.on_anchor
            ${links}
            and ${after(tx, tx`r.updated_at`, tx`r.id`, cursor, true)}
            order by r.id, links.field_id, links.on_anchor desc
          ) deduplicated
          order by updated_at desc, id desc
          limit ${limit + 1}
        ) candidate
        join records r on r.id = candidate.id
      ), '[]') as rows`;
  const paged = page(result.rows, limit);
  const refs = await references(
    tx,
    schema,
    paged.items.map((row) => row.id),
  );
  return {
    items: paged.items.flatMap((row) => {
      const ref = refs[row.id];
      const via = schema.fieldOwners.get(row.field_id)?.fieldsById.get(row.field_id);
      if (!ref || !via) return [];
      return [
        {
          id: row.id,
          title: ref.label,
          object: ref.object,
          via: { field: via.name, on: row.on_anchor ? 'anchor' : 'linked' },
          selects: row.selects,
        },
      ];
    }),
    nextCursor: paged.nextCursor,
    totals: totalsByObject(schema, result.counts),
  };
}
