import type { Fragment } from 'postgres';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { Tx } from './tx.js';

/** A full-precision timestamp written as `timestamptz::text`, sent back unchanged by clients. */
export const stampSchema = z
  .string()
  .max(64)
  .regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/)
  .refine((v) => Number.isFinite(Date.parse(v)));
const cursorSchema = z.tuple([stampSchema, z.uuid()]);
export function cursorValue(raw?: string): [string, string] | undefined {
  if (!raw) return undefined;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString()));
  } catch {
    throw new AppError(400, 'invalid_cursor', 'pass nextCursor from the previous page');
  }
}
export const encodeCursor = (stamp: string, id: string) =>
  Buffer.from(JSON.stringify([stamp, id])).toString('base64url');
export function after(
  tx: Tx,
  time: Fragment,
  id: Fragment,
  raw?: string,
  descending = false,
): Fragment {
  const cursor = cursorValue(raw);
  return cursor
    ? tx`(${time}, ${id}) ${tx.unsafe(descending ? '<' : '>')} (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
    : tx`true`;
}
export function page<T extends { stamp: string; id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.stamp, last.id) : null,
  };
}
