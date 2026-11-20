import { nextOccurrence } from '@retainer/extension';
import { ROUTINE_LIMITS } from '@retainer/shared';

/** Whether a string is an IANA time zone this runtime knows. */
export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.length <= 100;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offset(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The next occurrence of a five-field cron after `after`, read in a time
 * zone (routines spec §4.2, §7). The cron is matched against the zone's wall
 * clock. A wall time a clock change skips runs that much later (02:30 on a
 * spring-forward night runs at 03:30); a repeated one runs the first time.
 */
export function nextInZone(cron: string, after: Date, zone: string): Date {
  let wallAfter = new Date(after.getTime() + offset(zone, after));
  for (let guard = 0; guard < 8; guard++) {
    const wall = nextOccurrence(cron, wallAfter);
    // The instants the wall time could be, under the offsets either side of
    // a change: the earliest that reads back as this wall time, or, in a
    // skipped hour, the later one, so a schedule never fires early.
    const first = new Date(wall.getTime() - offset(zone, wall));
    const second = new Date(wall.getTime() - offset(zone, first));
    const exact = [first, second]
      .filter((c) => c.getTime() + offset(zone, c) === wall.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    const instant = exact[0] ?? (first > second ? first : second);
    if (instant > after) return instant;
    wallAfter = wall;
  }
  throw new Error('cron has no occurrence');
}

/** Why a cron is refused, or undefined: it must parse and fire at most every 15 minutes. */
export function cronProblem(cron: string): string | undefined {
  try {
    let at = new Date(Date.UTC(2026, 0, 5));
    let previous: Date | undefined;
    for (let i = 0; i < 200; i++) {
      const next = nextOccurrence(cron, at);
      if (previous && next.getTime() - previous.getTime() < ROUTINE_LIMITS.scheduleMinutes * 60000)
        return `a schedule fires at most every ${ROUTINE_LIMITS.scheduleMinutes} minutes`;
      previous = next;
      at = next;
    }
    return undefined;
  } catch {
    return 'not a valid five-field cron';
  }
}
