import type { Caller } from '../caller.js';
import { changeCursor, changePosition, overtaken, retainedFloor } from '../db/change-cursor.js';
import type { Sql } from '../db/client.js';
import type { Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import { withRead } from '../records/service.js';
import type { CompiledSchema } from '../schema/compiled.js';
import type { ChangeOperation } from './collect.js';

export type ChangeRow = {
  position: string;
  record_id: string;
  object_type_id: string;
  operation: ChangeOperation;
  field_keys: string[];
  related_record_ids: string[];
  origin_installation_id: string | null;
  cause: string[];
  merged_into_id: string | null;
};
export type FeedHead = { current: string; after: string };

/**
 * The committed head and the reader's start, read without locking the
 * counter, so a long feed read never blocks a writer. Writers allocate
 * positions under the counter's row lock and commit while holding it, so
 * every position at or below a committed head is already committed.
 */
export async function readHead(tx: Tx, workspace: string, cursor?: string): Promise<FeedHead> {
  const [counter] = await tx<
    { position: string; retained_after: string }[]
  >`select position::text,retained_after::text from change_counters where workspace_id=${workspace}`;
  const current = counter?.position ?? '0',
    floor = await retainedFloor(tx, workspace, current, counter?.retained_after ?? '0');
  const after = cursor !== undefined ? changePosition(workspace, cursor) : floor;
  if (BigInt(after) < BigInt(floor)) throw cursorExpired();
  if (BigInt(after) > BigInt(current))
    throw new AppError(400, 'invalid_cursor', 'change cursor is ahead of this workspace feed');
  return { current, after };
}

const cursorExpired = () =>
  new AppError(
    410,
    'cursor_expired',
    'change cursor expired; capture headCursor from a fresh feed page, rescan current records, then replay after that headCursor',
    { rescan: true },
  );

export class Changes {
  constructor(private readonly sql: Sql) {}
  private async present(tx: Tx, schema: CompiledSchema, workspace: string, rows: ChangeRow[]) {
    const named = [
      ...new Set(
        rows.flatMap((r) => [
          r.record_id,
          ...r.related_record_ids,
          ...(r.merged_into_id ? [r.merged_into_id] : []),
        ]),
      ),
    ];
    const records = named.length
      ? await tx<
          { id: string; object_type_id: string }[]
        >`select id,object_type_id from records where id=any(${named}::uuid[]) and private_to_user is null and deleted_at is null and merged_into_id is null and object_type_id=any(${schema.visibleObjectIds}::uuid[])`
      : [];
    const visible = new Set(records.map((r) => r.id));
    const changes = rows
      .filter(
        (r) =>
          (schema.visibleObjectIds.includes(r.object_type_id) ||
            (['delete', 'merge', 'retract', 'forget'].includes(r.operation) &&
              schema.objectsById.has(r.object_type_id) &&
              !schema.objectsById.get(r.object_type_id)?.hidden)) &&
          (visible.has(r.record_id) ||
            ['delete', 'merge', 'retract', 'forget'].includes(r.operation)),
      )
      .map((r) => ({
        cursor: changeCursor(workspace, r.position),
        recordId: r.record_id,
        objectTypeId: r.object_type_id,
        operation: r.operation,
        changedKeys: r.field_keys,
        originInstallationId: r.origin_installation_id,
        cause: r.cause,
        relatedRecordIds: r.related_record_ids.filter((id) => visible.has(id)),
        mergedIntoId: r.merged_into_id && visible.has(r.merged_into_id) ? r.merged_into_id : null,
      }));
    return changes;
  }
  /**
   * One page after `head.after`, rechecked against retention once read.
   * The recheck relies on READ COMMITTED (`inWorkspace`'s default): each
   * statement takes a fresh snapshot, so the recheck sees any prune whose
   * deletions the page read saw. Under a single snapshot (REPEATABLE READ)
   * the head and page would instead agree with each other, which is safe
   * too; only mixing snapshots between the page and the recheck is not.
   */
  async page(tx: Tx, schema: CompiledSchema, workspace: string, head: FeedHead, limit: number) {
    const { current, after } = head;
    const raw = await tx<
      ChangeRow[]
    >`select position::text,record_id,object_type_id,operation,field_keys,related_record_ids,origin_installation_id,cause,merged_into_id
    from record_changes where workspace_id=${workspace} and position>${after}::bigint and position<=${current}::bigint order by position limit ${limit + 1}`;
    if (await overtaken(tx, workspace, after)) throw cursorExpired();
    const page = raw.slice(0, limit),
      changes = await this.present(tx, schema, workspace, page);
    return {
      changes,
      nextCursor: changeCursor(workspace, page.at(-1)?.position ?? after),
      headCursor: changeCursor(workspace, current),
      hasMore: raw.length > limit,
    };
  }
  async at(caller: Caller, position: string) {
    if (!/^[1-9][0-9]{0,18}$/.test(position) || BigInt(position) > 9223372036854775807n)
      throw new AppError(
        400,
        'invalid_change_position',
        'changePosition must be a positive bigint',
      );
    if (!caller.scopes.includes('read') && !caller.scopes.includes('admin'))
      throw new AppError(403, 'forbidden', 'read scope required');
    if (caller.run) {
      const owned = await withRead(
        this.sql,
        caller,
        async (tx, schema) => {
          const [job] = await tx<
            { change_snapshot: ChangeRow | null }[]
          >`select change_snapshot from extension_jobs where id=${caller.run?.jobId ?? null} and input->>'changePosition'=${position}`;
          if (!job?.change_snapshot) return undefined;
          const [item] = await this.present(tx, schema, caller.workspaceId, [job.change_snapshot]);
          if (!item) throw notFound('record change');
          return item;
        },
        { privacy: true, schema: true },
      );
      if (owned) return owned;
    }
    const page = await this.list(caller, {
      after: changeCursor(caller.workspaceId, (BigInt(position) - 1n).toString()),
      limit: 1,
    });
    const item = page.changes.find(
      (change) => change.cursor === changeCursor(caller.workspaceId, position),
    );
    if (!item) throw notFound('record change');
    return item;
  }
  async list(caller: Caller, input: { after?: string; limit?: number } = {}) {
    if (!caller.scopes.includes('read') && !caller.scopes.includes('admin'))
      throw new AppError(403, 'forbidden', 'read scope required');
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new AppError(400, 'invalid_limit', 'limit must be 1–1000');
    return withRead(
      this.sql,
      caller,
      async (tx, schema) => {
        const head = await readHead(tx, caller.workspaceId, input.after);
        return this.page(tx, schema, caller.workspaceId, head, limit);
      },
      { privacy: true, schema: true },
    );
  }
}
