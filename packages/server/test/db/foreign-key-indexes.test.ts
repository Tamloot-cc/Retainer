import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../helpers/db.js';

// Deleting a row runs each foreign key's ON DELETE action as one lookup in the
// referencing table. Without an index for that lookup, every deleted row
// scans the table, and purging a large workspace (accounts spec 4.5) or
// deleting many records slows to a crawl: a self-reference on records alone
// kept a 360,000-record purge running past the control function's 300
// seconds.

const db = useTestDatabase();

/**
 * Foreign keys left without an index, and why that is cheap: the referenced
 * rows are few, or each delete fires the lookup once per workspace or user.
 */
const UNINDEXED = new Set([
  // A workspace has tens of fields and object types, not thousands.
  'object_types(workspace_id, label_field_id) -> fields',
  'record_links(workspace_id, field_id) -> fields',
  'record_identifiers(workspace_id, field_id) -> fields',
  'event_moves(workspace_id, to_object_type_id) -> object_types',
  'event_moves(workspace_id, from_object_type_id) -> object_types',
  // Once per deleted person.
  'api_keys(created_by_user) -> users',
  'invitations(invited_by) -> users',
  // Once per person removed from an organization, over its few workspaces.
  'workspace_members(organization_id, user_id) -> organization_members',
  // Once per purged workspace.
  'comments(workspace_id) -> workspaces',
  'fact_sources(workspace_id) -> workspaces',
  'oauth_access_tokens(reference_id) -> workspaces',
]);

describe('foreign keys', () => {
  it('each have an index their ON DELETE lookup can use', async () => {
    // An index serves the lookup when it starts with the column that points at
    // the referenced row's id (not the tenant column most keys also carry), or
    // with all the key's columns. A partial index serves it only when its
    // condition is that column being not null, which the lookup's equality
    // implies; any other condition leaves rows the lookup must still find.
    const rows = await db.owner<{ key: string }[]>`
      with fk as (
        select c.conrelid, c.confrelid, c.conkey,
          array(
            select k.attnum from unnest(c.conkey, c.confkey) k(attnum, ref)
            join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.ref
            where a.attname = 'id'
          ) as own,
          (select string_agg(a.attname, ', ' order by k.ord)
            from unnest(c.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as columns
        from pg_constraint c join pg_namespace n on n.oid = c.connamespace
        where c.contype = 'f' and n.nspname = 'public'
      ),
      ix as (
        select i.indrelid, i.indkey::int2[] as cols, i.indkey[0] as lead,
          case
            when i.indpred is null then 'all'
            when pg_get_expr(i.indpred, i.indrelid) = format('(%s IS NOT NULL)', quote_ident(a.attname))
              then 'lead not null'
          end as rows
        from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      )
      select format('%s(%s) -> %s', fk.conrelid::regclass, fk.columns, fk.confrelid::regclass) as key
      from fk
      where not exists (
        select 1 from ix
        where ix.indrelid = fk.conrelid and (
          (ix.lead = any(fk.own) and ix.rows is not null)
          or (ix.rows = 'all'
            and (select array_agg(x order by x) from unnest(ix.cols[0:cardinality(fk.conkey) - 1]) x)
              = (select array_agg(x order by x) from unnest(fk.conkey) x))
        )
      )`;
    const missing = rows.map((r) => r.key).filter((key) => !UNINDEXED.has(key));
    expect(missing).toEqual([]);
  });
});
