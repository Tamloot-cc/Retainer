import { describe, expect, it } from 'vitest';
import { nextOccurrence } from './cron.js';

describe('UTC cron', () => {
  it('advances strictly after a timestamp, including year and leap-day boundaries', () => {
    expect(nextOccurrence('* * * * *', new Date('2026-12-31T23:59:01Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(nextOccurrence('30 9 * * *', new Date('2026-11-11T09:30:00Z')).toISOString()).toBe(
      '2026-11-12T09:30:00.000Z',
    );
    expect(nextOccurrence('0 0 29 2 *', new Date('2096-02-29T00:00:00Z')).toISOString()).toBe(
      '2104-02-29T00:00:00.000Z',
    );
  });
  it('uses the conventional OR rule for constrained day-of-month and weekday', () => {
    expect(nextOccurrence('0 0 15 * 1', new Date('2026-11-11T12:00:00Z')).toISOString()).toBe(
      '2026-11-15T00:00:00.000Z',
    );
  });
  it('rejects unsupported syntax and impossible dates', () => {
    expect(() => nextOccurrence('0 0 31 2 *', new Date('2026-01-01T00:00:00Z'))).toThrow(
      'no occurrence',
    );
    expect(() => nextOccurrence('*/5 * * * *', new Date())).toThrow('invalid UTC cron');
    expect(() => nextOccurrence('* * * * *', new Date('invalid'))).toThrow(
      'invalid scheduling time',
    );
  });
});
