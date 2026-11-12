import { describe, expect, it } from 'vitest';
import { compareRevision, sourceIdentityChannel } from './policy.js';

describe('release-pinned source ordering', () => {
  it('orders integer revisions numerically without losing precision', () => {
    expect(compareRevision('integer', '10', '9')).toBe(1);
    expect(compareRevision('integer', '9007199254740993', '9007199254740992')).toBe(1);
    expect(compareRevision('integer', '2', '10')).toBe(-1);
    expect(compareRevision('integer', '0', null)).toBeNull();
    expect(() => compareRevision('integer', '01', '1')).toThrow('nonnegative integer');
    expect(() => compareRevision('integer', undefined)).toThrow('requires an ordering marker');
  });
  it('compares explicit timezones and preserves submillisecond provider ordering', () => {
    expect(compareRevision('timestamp', '2026-11-11T12:00:00+02:00', '2026-11-11T10:00:00Z')).toBe(
      0,
    );
    expect(
      compareRevision('timestamp', '2026-11-11T10:00:00.000002Z', '2026-11-11T10:00:00.000001Z'),
    ).toBe(1);
    expect(() => compareRevision('timestamp', '2026-02-31T10:00:00Z')).toThrow('ISO timestamp');
    expect(() => compareRevision('timestamp', '2026-11-11T10:00:00')).toThrow('ISO timestamp');
  });
  it('never infers order for opaque tokens and separates identity boundaries', () => {
    expect(compareRevision('opaque', 'z', 'a')).toBeNull();
    expect(compareRevision('opaque', 'same', 'same')).toBe(0);
    expect(sourceIdentityChannel('a', 'b:c', 'd')).not.toBe(sourceIdentityChannel('a:b', 'c', 'd'));
  });
});
