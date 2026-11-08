import { describe, expect, it } from 'vitest';
import { canRematchParticipant, participantKey, resolveParticipants } from './event-links.js';

const A = '10000000-0000-4000-8000-00000000000a';
const B = '10000000-0000-4000-8000-00000000000b';
const dana = {
  handle: { kind: 'email' as const, value: 'dana@acme.test' },
  recordId: null,
  role: null,
};

describe('resolveParticipants', () => {
  it('matches an email claimed by one live record', () => {
    const records = new Map([[A, { id: A, deleted: false }]]);
    const emails = new Map([['dana@acme.test', { live: [A], deleted: [] }]]);
    expect(resolveParticipants([dana], records, emails)).toEqual([{ recordId: A }]);
  });

  it('judges email claims by the locked records, not the earlier read', () => {
    const emails = new Map([['dana@acme.test', { live: [A], deleted: [] }]]);
    // Deleted after the claims were read.
    expect(resolveParticipants([dana], new Map([[A, { id: A, deleted: true }]]), emails)).toEqual([
      { reason: 'deleted_record' },
    ]);
    // Two claimants, one deleted since: the other is the match.
    const both = new Map([['dana@acme.test', { live: [A, B], deleted: [] }]]);
    expect(
      resolveParticipants(
        [dana],
        new Map([
          [A, { id: A, deleted: true }],
          [B, { id: B, deleted: false }],
        ]),
        both,
      ),
    ).toEqual([{ recordId: B }]);
    // Two claimants merged since: one record, matched as the survivor.
    expect(
      resolveParticipants(
        [dana],
        new Map([
          [A, { id: A, deleted: false }],
          [B, { id: A, deleted: false }],
        ]),
        both,
      ),
    ).toEqual([{ recordId: A }]);
  });
});

describe('participant retry identity and eligibility', () => {
  it('uses role and handle before record ID, and record ID only without a handle', () => {
    expect(participantKey(null, 'dana@acme.test', null)).toBe(
      participantKey(null, 'dana@acme.test', A),
    );
    expect(participantKey('guest', 'dana@acme.test', A)).not.toBe(
      participantKey(null, 'dana@acme.test', A),
    );
    expect(participantKey(null, null, A)).not.toBe(participantKey(null, null, B));
  });

  it('only retries safe unmatched reasons, requiring an explicit candidate for ambiguity', () => {
    const p = { ...dana, erased: false };
    const row = { record_id: null, unmatched_reason: 'no_match' as const };
    expect(canRematchParticipant(row, p, [], null)).toBe(true);
    expect(canRematchParticipant({ ...row, unmatched_reason: 'phone_only' }, p, [], null)).toBe(
      true,
    );
    for (const unmatched_reason of ['suppressed', 'deleted_record', 'ambiguous'] as const) {
      expect(canRematchParticipant({ ...row, unmatched_reason }, p, [A], A)).toBe(false);
    }
    expect(canRematchParticipant({ ...row, record_id: A }, p, [], null)).toBe(false);
    expect(canRematchParticipant(row, { ...p, erased: true }, [], null)).toBe(false);
    const ambiguous = { ...row, unmatched_reason: 'ambiguous' as const };
    expect(canRematchParticipant(ambiguous, { ...p, recordId: A }, [A, B], A)).toBe(true);
    expect(canRematchParticipant(ambiguous, { ...p, recordId: B }, [A], B)).toBe(false);
  });
});
