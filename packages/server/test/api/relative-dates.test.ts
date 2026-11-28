import { expect, it } from 'vitest';
import { RUNTIME_ROLE } from '../../src/db/client.js';
import { inWorkspace } from '../../src/db/tx.js';
import { relativeDate } from '../../src/records/relative-date.js';
import { startTestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

const db = useTestDatabase();

it('uses workspace calendar boundaries across a year and daylight-saving changes', async () => {
  const api = startTestApp(db);
  const { workspace } = await api.setupWorkspace(
    { name: 'Calendar boundaries', template: 'sales' },
    {},
  );
  await db.owner`update workspaces set settings = '{"timeZone":"America/New_York"}' where id = ${workspace.id}`;
  await inWorkspace(db.connect({ role: RUNTIME_ROLE }), workspace.id, async (tx) => {
    const assert = async (
      now: string,
      op: string,
      value: unknown,
      start: string,
      end: string,
      dateOnly = false,
      closed = false,
    ) => {
      const cast = dateOnly ? tx`date` : tx`timestamptz`;
      const tick = dateOnly ? '1 day' : '1 second';
      const condition = relativeDate(
        tx,
        tx`r.at`,
        dateOnly,
        'closeDate',
        op,
        value,
        tx`${now}::timestamptz`,
      );
      if (!condition) throw new Error(`Unsupported relative date: ${JSON.stringify(value)}`);
      const [result] = await tx<{ matched: boolean[] }[]>`
        select array_agg(coalesce(${condition}, false) order by r.n) as matched
        from (values
          (${workspace.id}::uuid, (${start}::${cast} - ${tick}::interval)::${cast}, 1),
          (${workspace.id}::uuid, ${start}::${cast}, 2),
          (${workspace.id}::uuid, ${end}::${cast}, 3)
        ) as r(workspace_id, at, n)`;
      expect(result?.matched, JSON.stringify(value)).toEqual([false, true, closed]);
    };
    const newYear = '2026-01-01T22:00:00Z';
    for (const [unit, boundaries] of [
      ['week', ['2025-12-22', '2025-12-29', '2026-01-05', '2026-01-12']],
      ['month', ['2025-12-01', '2026-01-01', '2026-02-01', '2026-03-01']],
      ['quarter', ['2025-10-01', '2026-01-01', '2026-04-01', '2026-07-01']],
      ['year', ['2025-01-01', '2026-01-01', '2027-01-01', '2028-01-01']],
    ] as const) {
      const [last, current, next, afterNext] = boundaries;
      await assert(newYear, 'within', `last_${unit}`, last, current, true);
      await assert(newYear, 'within', `this_${unit}`, current, next, true);
      await assert(newYear, 'within', `next_${unit}`, next, afterNext, true);
    }
    const dst = '2026-03-08T16:00:00Z';
    await assert(dst, 'within', 'today', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z');
    await assert(dst, 'within', 'yesterday', '2026-03-07T05:00:00Z', '2026-03-08T05:00:00Z');
    await assert(dst, 'within', 'tomorrow', '2026-03-09T04:00:00Z', '2026-03-10T04:00:00Z');
    for (const [unit, before, after] of [
      ['day', '2026-03-07T17:00:00Z', '2026-03-09T16:00:00Z'],
      ['week', '2026-03-01T17:00:00Z', '2026-03-15T16:00:00Z'],
      ['month', '2026-02-08T17:00:00Z', '2026-04-08T16:00:00Z'],
    ] as const) {
      await assert(dst, 'within', { last: 1, unit }, before, dst, false, true);
      await assert(dst, 'within', { next: 1, unit }, dst, after, false, true);
    }
    for (const [relative, boundary] of [
      ['yesterday', '2026-03-07T05:00:00Z'],
      ['today', '2026-03-08T05:00:00Z'],
      ['tomorrow', '2026-03-09T04:00:00Z'],
      [{ ago: 1, unit: 'week' }, '2026-03-01T05:00:00Z'],
      [{ ahead: 1, unit: 'month' }, '2026-04-08T04:00:00Z'],
    ] as const)
      await assert(dst, 'gte', relative, boundary, dst, false, boundary <= dst);
    await assert(dst, 'within', { last: 1, unit: 'day' }, '2026-03-07', '2026-03-08', true, true);
    await assert(dst, 'within', { next: 1, unit: 'day' }, '2026-03-08', '2026-03-09', true, true);
  });
});
