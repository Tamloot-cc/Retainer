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
