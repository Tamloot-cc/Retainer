import type { Fragment } from 'postgres';
import { z } from 'zod';
import type { Tx } from '../db/tx.js';
import { AppError } from '../errors.js';

const count = z.number().int().min(1).max(1000);
const unit = z.enum(['day', 'week', 'month']);
const window = z.union([
  z.strictObject({ last: count, unit }),
  z.strictObject({ next: count, unit }),
]);
const day = z.union([z.strictObject({ ago: count, unit }), z.strictObject({ ahead: count, unit })]);
const named = /^(this|last|next)_(week|month|quarter|year)$/;
const days = new Map([
  ['yesterday', -1],
  ['today', 0],
  ['tomorrow', 1],
]);
const comparisons = new Map([
  ['lt', '<'],
  ['lte', '<='],
  ['gt', '>'],
  ['gte', '>='],
]);

export function workspaceTimeZone(tx: Tx) {
  return tx`coalesce((select settings ->> 'timeZone' from workspaces where id = nullif(current_setting('app.workspace_id', true), '')::uuid), 'UTC')`;
}

/** Resolve against the transaction clock in the same civil time as aggregate buckets. */
export function relativeDate(
  tx: Tx,
  column: Fragment,
  dateOnly: boolean,
  field: string,
  op: string,
  value: unknown,
  clock = tx`now()`,
): Fragment | undefined {
  const local = tx`(${clock} at time zone ${workspaceTimeZone(tx)})`;
  const today = tx`date_trunc('day', ${local})`;
  const boundary = (value: Fragment) =>
    dateOnly ? tx`(${value})::date` : tx`((${value}) at time zone ${workspaceTimeZone(tx)})`;
  const interval = (amount: number, unit: string) =>
    tx`${unit === 'quarter' ? `${amount * 3} month` : `${amount} ${unit}`}::interval`;
  const offset = typeof value === 'string' ? days.get(value) : undefined;
  const comparison = comparisons.get(op);
  if (comparison) {
    const shift = day.safeParse(value);
    if (offset === undefined && !shift.success) return undefined;
    const delta = shift.success
      ? interval('ago' in shift.data ? -shift.data.ago : shift.data.ahead, shift.data.unit)
      : interval(offset ?? 0, 'day');
    return tx`${column} ${tx.unsafe(comparison)} ${boundary(tx`${today} + ${delta}`)}`;
  }
  if (op !== 'within') return undefined;

  const period = typeof value === 'string' ? named.exec(value) : null;
  if (period || offset !== undefined) {
    const unit = period?.[2] ?? 'day';
    const shift = offset ?? (period?.[1] === 'last' ? -1 : period?.[1] === 'next' ? 1 : 0);
    const start = tx`date_trunc(${unit}::text, ${local}) + ${interval(shift, unit)}`;
    return tx`(${column} >= ${boundary(start)}
      and ${column} < ${boundary(tx`${start} + ${interval(1, unit)}`)})`;
  }
  const rolling = window.safeParse(value);
  if (!rolling.success)
    throw new AppError(
      422,
      'invalid_filter',
      `${field}.within requires a named or rolling period`,
      { field },
    );
  const current = dateOnly ? today : local;
  const { data } = rolling;
  // Keep the current instant itself as an absolute timestamp, including during a DST fold.
  const now = dateOnly ? boundary(today) : clock;
  const start = 'last' in data ? boundary(tx`${current} - ${interval(data.last, data.unit)}`) : now;
  const end = 'next' in data ? boundary(tx`${current} + ${interval(data.next, data.unit)}`) : now;
  return tx`(${column} >= ${start} and ${column} <= ${end})`;
}
