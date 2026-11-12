import { AppError } from '../errors.js';
import type { Tx } from './tx.js';
export const changeCursor = (workspace: string, position: string) =>
  Buffer.from(JSON.stringify({ v: 1, w: workspace, p: position })).toString('base64url');
export function changePosition(workspace: string, cursor: string) {
  try {
    if (cursor.length > 500) throw new Error('cursor too long');
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      v: unknown;
      w: unknown;
      p: unknown;
    };
    if (
      decoded.v !== 1 ||
      decoded.w !== workspace ||
      typeof decoded.p !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(decoded.p)
    )
      throw new Error('invalid cursor');
    return decoded.p;
  } catch {
    throw new AppError(400, 'invalid_cursor', 'pass the change cursor returned for this workspace');
  }
}

/**
 * The last position older than retention, or `stored` when none is. A fresh
 * cursor starts here. Readers call it without locking the counter and
 * recheck `retained_after` after reading; the pruner calls it under the lock.
 */
export async function retainedFloor(tx: Tx, workspace: string, current: string, stored: string) {
  const [row] = await tx<
    { floor: string }[]
  >`select coalesce(max(position),${stored}::bigint)::text as floor
    from record_changes where workspace_id=${workspace} and position>${stored}::bigint and created_at<clock_timestamp()-interval '30 days'
    and position<coalesce((select min(position) from record_changes where workspace_id=${workspace} and position>${stored}::bigint
      and created_at>=clock_timestamp()-interval '30 days'),${current}::bigint+1)`;
  const candidate = row?.floor ?? current;
  return BigInt(candidate) > BigInt(stored) ? candidate : stored;
}

/**
 * Whether pruning has deleted rows after `after`. Pruning commits its
 * deletions and `retained_after` together, so a reader that missed pruned
 * rows always sees the advanced marker when it checks after reading: it
 * refuses the page as expired rather than skip rows silently.
 */
export async function overtaken(tx: Tx, workspace: string, after: string) {
  const [counter] = await tx<
    { retained_after: string }[]
  >`select retained_after::text from change_counters where workspace_id=${workspace}`;
  return BigInt(after) < BigInt(counter?.retained_after ?? '0');
}
