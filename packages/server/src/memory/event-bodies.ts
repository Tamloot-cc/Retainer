import type { EventContentPage } from '@retainer/shared';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { textVector } from '../records/search-sql.js';

/**
 * The full text behind an event (1.3): an email's body, a meeting's
 * transcript. It lives in `event_bodies`, apart from `records.data`, so a
 * long text never truncates the event's summary, and any source can store
 * one. Events that share a thread read as one conversation.
 */

/** Parts per page of `eventContentPage`. */
const PAGE_SIZE = 5;

export type EventBody = {
  eventId: string;
  /** Events with the same thread read as one conversation; null for a standalone event. */
  threadId: string | null;
  occurredAt: Date;
  /** The date the source itself reported, when it differs from occurredAt. */
  originalDate?: Date;
  body: string;
};

/** Stores an event's body, with its search text. A body is immutable: an existing one is kept. */
export async function storeEventBody(tx: Tx, workspaceId: string, input: EventBody) {
  await tx`insert into event_bodies(workspace_id,event_id,thread_id,occurred_at,original_date,body,search)
    values(${workspaceId},${input.eventId},${input.threadId},${input.occurredAt},
      ${input.originalDate ?? null},${input.body},${textVector(tx, input.body)})
    on conflict (event_id) do nothing`;
}

/** Moves every event of the `from` threads into `to`, when one source joins them. */
export async function joinEventThreads(tx: Tx, workspaceId: string, to: string, from: string[]) {
  if (from.length === 0) return;
  await tx`update event_bodies set thread_id=${to}
    where workspace_id=${workspaceId} and thread_id=any(${from}::uuid[])`;
}

/**
 * The full text of an event, oldest first, five parts per page: one part
 * for a standalone event, every message of its thread for a conversation.
 * Any event of a thread opens the whole thread. `after` is the id of the
 * last part of the previous page.
 */
export async function eventContentPage(
  tx: Tx,
  workspaceId: string,
  eventId: string,
  after: string | null,
  eventTypes: readonly string[],
): Promise<EventContentPage> {
  const [own] = await tx<{ thread_id: string | null }[]>`
    select b.thread_id from event_bodies b
    join records r on r.id=b.event_id and r.workspace_id=b.workspace_id
    where b.workspace_id=${workspaceId} and b.event_id=${eventId} and r.deleted_at is null
      and r.object_type_id=any(${eventTypes}::uuid[])`;
  if (!own) {
    throw new AppError(
      404,
      'not_found',
      `event ${eventId} has no stored content: its title and summary are all there is`,
      { eventId },
    );
  }
  const scope = own.thread_id ? tx`b.thread_id=${own.thread_id}` : tx`b.event_id=${eventId}`;
  if (after) {
    const [cursor] = await tx`select 1 from event_bodies b
      where b.workspace_id=${workspaceId} and b.event_id=${after} and ${scope}`;
    if (!cursor) {
      throw new AppError(404, 'not_found', `after ${after} is not a part of this event's content`, {
        after,
      });
    }
  }
  const rows = await tx<
    { id: string; occurred_at: Date; original_date: Date | null; body: string }[]
  >`
    select b.event_id as id,b.occurred_at,b.original_date,b.body from event_bodies b
    join records r on r.id=b.event_id and r.workspace_id=b.workspace_id
    where b.workspace_id=${workspaceId} and ${scope} and r.deleted_at is null
      and r.object_type_id=any(${eventTypes}::uuid[])
      and (${after}::uuid is null or (b.occurred_at,b.event_id) >
        (select c.occurred_at,c.event_id from event_bodies c where c.event_id=${after}))
    order by b.occurred_at,b.event_id limit ${PAGE_SIZE + 1}`;
  const parts = rows.slice(0, PAGE_SIZE).map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    originalDate: row.original_date?.toISOString() ?? null,
    text: row.body,
  }));
  return {
    parts,
    nextAfter: rows.length > parts.length ? (parts.at(-1)?.id ?? null) : null,
  };
}
