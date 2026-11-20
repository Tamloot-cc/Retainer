import { describe, expect, it } from 'vitest';
import { cronProblem, nextInZone, validTimeZone } from './cron.js';
import { triggerMatches } from './matcher.js';

describe('routine schedules', () => {
  it('reads a cron on the workspace wall clock', () => {
    // 09:00 in Jerusalem is 07:00 UTC in winter.
    expect(nextInZone('0 9 * * 1', new Date('2026-11-20T00:00:00Z'), 'Asia/Jerusalem')).toEqual(
      new Date('2026-11-23T07:00:00Z'),
    );
    expect(nextInZone('0 9 * * *', new Date('2026-11-20T08:00:00Z'), 'UTC')).toEqual(
      new Date('2026-11-20T09:00:00Z'),
    );
  });

  it('keeps the wall time across a clock change', () => {
    // New York leaves daylight time on 2026-11-01: 09:00 is 13:00 UTC before, 14:00 after.
    expect(nextInZone('0 9 * * *', new Date('2026-10-31T12:00:00Z'), 'America/New_York')).toEqual(
      new Date('2026-10-31T13:00:00Z'),
    );
    expect(nextInZone('0 9 * * *', new Date('2026-11-01T12:00:00Z'), 'America/New_York')).toEqual(
      new Date('2026-11-01T14:00:00Z'),
    );
  });

  it('never fires a skipped wall time early, and a repeated one once', () => {
    // 02:30 does not exist in New York on 2026-03-08; it runs at 03:30 EDT, 07:30 UTC.
    expect(nextInZone('30 2 * * *', new Date('2026-03-08T00:00:00Z'), 'America/New_York')).toEqual(
      new Date('2026-03-08T07:30:00Z'),
    );
    // 01:30 happens twice on 2026-11-01; it runs the first time, 01:30 EDT.
    expect(nextInZone('30 1 * * *', new Date('2026-11-01T00:00:00Z'), 'America/New_York')).toEqual(
      new Date('2026-11-01T05:30:00Z'),
    );
    // East of UTC too: Berlin repeats 02:30 on 2026-10-25 (CEST first, 00:30 UTC)
    // and skips it on 2026-03-29 (03:30 CEST, 01:30 UTC).
    expect(nextInZone('30 2 * * *', new Date('2026-10-24T12:00:00Z'), 'Europe/Berlin')).toEqual(
      new Date('2026-10-25T00:30:00Z'),
    );
    expect(nextInZone('30 2 * * *', new Date('2026-03-28T12:00:00Z'), 'Europe/Berlin')).toEqual(
      new Date('2026-03-29T01:30:00Z'),
    );
    // Sydney repeats 02:30 on 2026-04-05: the first is AEDT, 15:30 UTC the day before.
    expect(nextInZone('30 2 * * *', new Date('2026-04-04T00:00:00Z'), 'Australia/Sydney')).toEqual(
      new Date('2026-04-04T15:30:00Z'),
    );
    // Hourly in Berlin keeps both 02:00s.
    expect(nextInZone('0 * * * *', new Date('2026-10-24T23:30:00Z'), 'Europe/Berlin')).toEqual(
      new Date('2026-10-25T00:00:00Z'),
    );
  });

  it('refuses invalid crons and ones more frequent than every 15 minutes', () => {
    expect(cronProblem('*/15 * * * *')).toBeUndefined();
    expect(cronProblem('0 9 * * 1-5')).toBeUndefined();
    expect(cronProblem('*/5 * * * *')).toContain('15 minutes');
    expect(cronProblem('0,10 9 * * *')).toContain('15 minutes');
    expect(cronProblem('not a cron')).toContain('cron');
  });

  it('knows IANA zones', () => {
    expect(validTimeZone('Europe/Paris')).toBe(true);
    expect(validTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('record triggers', () => {
  const when = {
    kind: 'record' as const,
    object: 'o',
    on: ['created' as const, 'updated' as const],
    fields: ['stage'],
  };
  it('match the object, the operation and a watched field', () => {
    const change = (operation: string, field_keys: string[] = [], object_type_id = 'o') => ({
      object_type_id,
      operation,
      field_keys,
    });
    expect(triggerMatches(when, 'o', change('create'))).toBe(true);
    expect(triggerMatches(when, 'o', change('update', ['stage']))).toBe(true);
    expect(triggerMatches(when, 'o', change('supersede', ['stage', 'x']))).toBe(true);
    expect(triggerMatches(when, 'o', change('update', ['amount']))).toBe(false);
    expect(triggerMatches(when, 'o', change('links'))).toBe(false);
    expect(triggerMatches(when, 'o', change('delete'))).toBe(false);
    expect(triggerMatches(when, 'o', change('create', [], 'other'))).toBe(false);
    expect(
      triggerMatches({ ...when, on: ['links'], fields: undefined }, 'o', change('links')),
    ).toBe(true);
  });
});
