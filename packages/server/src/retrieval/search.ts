import type { EventHit, FactHit, RecordHit, SearchResult } from '@retainer/shared';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { currentFact } from '../memory/events.js';
import { factPlace } from '../memory/profiles.js';
import { exactQuery, prefixQuery } from '../records/search-sql.js';
import { type CompiledSchema, eventText } from '../schema/compiled.js';

/**
 * Keyword search across records, events and facts (5.1). Postgres
 * parses the query (`websearch_to_tsquery`: quoted phrases, `OR`, `-word`)
 * with the `simple` configuration the stored vectors use, accents folded.
 * Every word also matches as a prefix ("Dan" finds "Dana"); hits that match
 * the words exactly rank first. Each list is ranked on its own; scores are
 * not comparable across lists, so results stay grouped by type.
 */

export const searchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
});
export type SearchInput = z.infer<typeof searchInputSchema>;

/**
 * Length normalization for `ts_rank_cd`: divide by 1 + log(document
 * length), so a long text does not outrank a short, precise match.
 */
const RANK_NORMALIZATION = 1;

export async function search(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  input: SearchInput,
): Promise<SearchResult> {
  const [records, facts, events] = await Promise.all([
    searchRecords(tx, workspaceId, schema, input),
    searchFacts(tx, workspaceId, schema, input),
    searchEvents(tx, workspaceId, schema, input),
  ]);
  return { records, facts, events };
}

/**
 * Hits match every word as a prefix (`prefixQuery`). Those that match the
 * words as typed rank first, since `ts_rank_cd` scores a prefix match the
 * same as an exact one; each by `ts_rank_cd`.
 */
function rank(tx: Tx, column: 'search' | 'f.search' | 'r.search', text: string) {
  return tx`ts_rank_cd(${tx.unsafe(column)}, ${exactQuery(tx, text)}, ${RANK_NORMALIZATION}) desc,
    ts_rank_cd(${tx.unsafe(column)}, ${prefixQuery(tx, text)}, ${RANK_NORMALIZATION}) desc`;
}

type RecordRow = { id: string; object_type_id: string; label: string | null };

async function searchRecords(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  input: SearchInput,
): Promise<RecordHit[]> {
  const present = (rows: RecordRow[], match: RecordHit['match']) =>
    rows.map((row) => ({
      id: row.id,
      object: schema.objectsById.get(row.object_type_id)?.name ?? 'unknown',
      label: row.label,
      match,
    }));

  const text = await tx<RecordRow[]>`
    select id, object_type_id, label from records
    where workspace_id = ${workspaceId} and deleted_at is null
      and object_type_id = any(${schema.entityTypeIds}::uuid[])
      and search @@ ${prefixQuery(tx, input.query)}
    order by ${rank(tx, 'search', input.query)}, updated_at desc, id
    limit ${input.limit}`;
  if (text.length > 0) return present(text, 'text');

  // Nothing matched, even as a prefix: a misspelled name ("Dana Levy") can
  // still find its record by trigram similarity of the label.
  const similar = await tx<RecordRow[]>`
    select id, object_type_id, label from records
    where workspace_id = ${workspaceId} and deleted_at is null
      and object_type_id = any(${schema.entityTypeIds}::uuid[]) and label % ${input.query}
    order by similarity(label, ${input.query}) desc, updated_at desc, id
    limit ${input.limit}`;
  return present(similar, 'similar_label');
}

/**
 * Current facts only: not retracted, superseded or replaced, on a live
 * record, with a live source (2.1).
 */
async function searchFacts(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  input: SearchInput,
): Promise<FactHit[]> {
  const rows = await tx<
    { id: string; record_id: string; object_type_id: string; content: string; valid_from: Date }[]
  >`
    select f.id, f.record_id, r.object_type_id, f.content, f.valid_from from facts f
    join records r on r.id = f.record_id and r.deleted_at is null
    where f.workspace_id = ${workspaceId} and f.search @@ ${prefixQuery(tx, input.query)}
      and ${currentFact(tx)}
    order by ${rank(tx, 'f.search', input.query)}, f.valid_from desc, f.id
    limit ${input.limit}`;
  // Row-level security shows personal facts to their person only.
  return rows.map((row) => ({
    id: row.id,
    ...factPlace(schema, row.object_type_id, row.record_id),
    content: row.content,
    validFrom: row.valid_from.toISOString(),
  }));
}

/**
 * Live events of visible types, by their searchable fields (title and
 * summary at least). Internal notes are left out: their text is the fact's,
 * found (or hidden) with the fact itself.
 */
async function searchEvents(
  tx: Tx,
  workspaceId: string,
  schema: CompiledSchema,
  input: SearchInput,
): Promise<EventHit[]> {
  const rows = await tx<
    {
      id: string;
      object_type_id: string;
      data: Record<string, unknown>;
      occurred_at: Date;
      records: string[];
    }[]
  >`
    select r.id, r.object_type_id, r.data, e.occurred_at,
      array(
        select l.record_id from event_links l
        join records t on t.id = l.record_id and t.deleted_at is null
          and t.object_type_id = any(${schema.visibleObjectIds}::uuid[])
        where l.event_id = r.id
        order by l.position) as records
    from records r
    join event_records e on e.record_id = r.id
    where r.workspace_id = ${workspaceId} and r.deleted_at is null
      and r.object_type_id = any(${schema.eventTypeIds}::uuid[])
      and r.search @@ ${prefixQuery(tx, input.query)}
    order by ${rank(tx, 'r.search', input.query)}, e.occurred_at desc, r.id
    limit ${input.limit}`;
  return rows.map((row) => {
    const object = schema.objectsById.get(row.object_type_id);
    return {
      id: row.id,
      type: object?.name ?? 'unknown',
      occurredAt: row.occurred_at.toISOString(),
      ...eventText(object, row.data),
      records: [...new Set(row.records)],
    };
  });
}
