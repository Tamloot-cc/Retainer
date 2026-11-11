/** UTC numeric/wildcard cron supported by manifest v1. Day-of-month/day-of-week use cron's OR rule. */
export function nextOccurrence(cron: string, after: Date): Date {
  if (!Number.isFinite(after.getTime())) throw new Error('invalid scheduling time');
  const parts = cron.split(' '),
    max = [59, 23, 31, 12, 6];
  if (
    parts.length !== 5 ||
    parts.some(
      (part, i) =>
        part !== '*' &&
        (!/^\d+$/.test(part) ||
          Number(part) > (max[i] ?? -1) ||
          Number(part) < (i === 2 || i === 3 ? 1 : 0)),
    )
  )
    throw new Error('invalid UTC cron');
  const values = parts.map((p) => (p === '*' ? null : Number(p)));
  const [minute, hour, day, month, weekday] = values;
  const date = new Date(after);
  date.setUTCHours(0, 0, 0, 0);
  for (let n = 0; n <= 366 * 8 + 1; n++, date.setUTCDate(date.getUTCDate() + 1)) {
    if (month !== null && month !== undefined && month !== date.getUTCMonth() + 1) continue;
    const dom = day === null || day === date.getUTCDate(),
      dow = weekday === null || weekday === date.getUTCDay();
    if (!(day !== null && weekday !== null ? dom || dow : dom && dow)) continue;
    for (let h = 0; h < 24; h++) {
      if (hour !== null && hour !== undefined && h !== hour) continue;
      for (let m = 0; m < 60; m++) {
        if (minute !== null && minute !== undefined && m !== minute) continue;
        const next = new Date(date);
        next.setUTCHours(h, m, 0, 0);
        if (next > after) return next;
      }
    }
  }
  throw new Error('cron has no occurrence in the next eight years');
}
