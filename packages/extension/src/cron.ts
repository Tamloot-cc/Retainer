const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
function field(raw: string, min: number, max: number, names: string[] = []) {
  const text = raw.toUpperCase().replace(/[A-Z]+/g, (name) => {
    const index = names.indexOf(name);
    if (index < 0) throw new Error('invalid UTC cron name');
    return String(index + min);
  });
  const allowed = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw new Error('invalid UTC cron field');
    const base = match[1],
      step = match[2] === undefined ? 1 : Number(match[2]);
    if (!base || step < 1 || step > max - min + 1) throw new Error('invalid UTC cron step');
    const range = base === '*' ? [min, max] : base.split('-').map(Number);
    const start = range[0],
      end = range[1] ?? (match[2] === undefined ? start : max);
    if (start === undefined || end === undefined || start < min || end > max || end < start)
      throw new Error('invalid UTC cron range');
    for (let value = start; value <= end; value += step) allowed.add(value);
  }
  return [...allowed].sort((a, b) => a - b);
}

/** Five-field UTC cron with lists, ranges, steps and month/weekday names; DOM/DOW use OR. */
export function nextOccurrence(cron: string, after: Date): Date {
  if (!Number.isFinite(after.getTime())) throw new Error('invalid scheduling time');
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('invalid UTC cron');
  const [minuteText, hourText, dayText, monthText, weekdayText] = parts;
  if (!minuteText || !hourText || !dayText || !monthText || !weekdayText)
    throw new Error('invalid UTC cron');
  const minutes = field(minuteText, 0, 59),
    hours = field(hourText, 0, 23),
    days = field(dayText, 1, 31),
    months = field(monthText, 1, 12, MONTHS),
    weekdays = field(weekdayText, 0, 7, DAYS).map((day) => (day === 7 ? 0 : day));
  const date = new Date(after);
  date.setUTCHours(0, 0, 0, 0);
  for (let n = 0; n <= 366 * 8 + 1; n++, date.setUTCDate(date.getUTCDate() + 1)) {
    if (!months.includes(date.getUTCMonth() + 1)) continue;
    const dom = days.includes(date.getUTCDate()),
      dow = weekdays.includes(date.getUTCDay());
    if (!(dayText !== '*' && weekdayText !== '*' ? dom || dow : dom && dow)) continue;
    for (const hour of hours)
      for (const minute of minutes) {
        const next = new Date(date);
        next.setUTCHours(hour, minute, 0, 0);
        if (next > after) return next;
      }
  }
  throw new Error('cron has no occurrence in the next eight years');
}
