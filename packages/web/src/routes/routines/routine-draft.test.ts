import type { RoutineDraft } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import {
  countText,
  draftState,
  matchingProposal,
  parseRoutineFence,
  proposeBody,
} from './routine-draft.js';

const SOURCE = '5f0c2a1e-0000-4000-8000-000000000001';
const PREVIEW = 'a41e2a1e-0000-4000-8000-000000000002';
const ROUTINE = 'b51e2a1e-0000-4000-8000-000000000003';
const fence = {
  source: SOURCE,
  preview: PREVIEW,
  name: 'Thank-you task for won deals',
  description: 'When a deal moves to Won, create a task for its owner.',
  summary: 'Creates one task for the owner.',
  report: { verdict: 'full', gaps: [] },
};
const json = (value: unknown) => JSON.stringify(value);

const proposal = (over: Partial<RoutineDraft['proposals'][number]> = {}) => ({
  routineId: ROUTINE,
  versionId: 'v1',
  number: 1,
  name: fence.name,
  description: fence.description,
  summary: fence.summary,
  report: { verdict: 'full' as const, gaps: [] },
  state: 'proposed' as const,
  builtBy: { type: 'user' as const, id: 'dana' },
  byYou: true,
  createdAt: '2026-11-28T08:00:00Z',
  ...over,
});
const draft = (over: Partial<RoutineDraft> = {}): RoutineDraft => ({
  sourceId: SOURCE,
  manifest: {
    when: { kind: 'record', object: 'deal', on: ['updated'] },
    uses: { tools: [], model: false },
  },
  code: 'export async function main() {}',
  facts: [],
  ok: true,
  problems: [],
  count: { kind: 'record', value: 3 },
  preview: null,
  proposals: [],
  ...over,
});

describe('a routine fence', () => {
  it('parses into a propose body by source, never with code', () => {
    const parsed = parseRoutineFence(json(fence));
    expect(proposeBody(parsed)).toEqual({
      sourceId: SOURCE,
      name: fence.name,
      description: fence.description,
      summary: fence.summary,
      report: { verdict: 'full', gaps: [] },
    });
    expect(proposeBody(parseRoutineFence(json({ ...fence, routine: ROUTINE })))).toMatchObject({
      routineId: ROUTINE,
    });
    expect(parseRoutineFence(json({ ...fence, preview: null })).preview).toBeNull();
  });

  it('refuses unknown keys, missing keys and a not-possible verdict', () => {
    expect(() => parseRoutineFence(json({ ...fence, code: 'x' }))).toThrow(/should not: code/);
    expect(() => parseRoutineFence(json({ ...fence, facts: [] }))).toThrow(/should not/);
    const { preview: _preview, ...noPreview } = fence;
    expect(() => parseRoutineFence(json(noPreview))).toThrow(/which dry run/);
    const { summary: _summary, ...noSummary } = fence;
    expect(() => parseRoutineFence(json(noSummary))).toThrow(/needs a summary/);
    expect(() =>
      parseRoutineFence(json({ ...fence, report: { verdict: 'not_possible', gaps: [] } })),
    ).toThrow(/not possible/);
    expect(() => parseRoutineFence(json({ ...fence, source: 'nope' }))).toThrow(/checked source/);
    expect(() =>
      parseRoutineFence(
        json({
          ...fence,
          report: { verdict: 'partial', gaps: [{ part: 'x', reason: 'made_up', fix: 'y' }] },
        }),
      ),
    ).toThrow(/gaps/);
  });
});

describe('a reopened card', () => {
  const parsed = parseRoutineFence(json(fence));

  it('knows its own proposal, not one with other words, another person or routine', () => {
    expect(matchingProposal(parsed, [proposal()])).toBeTruthy();
    expect(matchingProposal(parsed, [proposal({ name: 'Another name' })])).toBeUndefined();
    expect(matchingProposal(parsed, [proposal({ byYou: false })])).toBeUndefined();
    expect(
      matchingProposal(parsed, [proposal({ report: { verdict: 'partial', gaps: [] } })]),
    ).toBeUndefined();
    // A new draft matches only a routine's first version.
    expect(matchingProposal(parsed, [proposal({ number: 2 })])).toBeUndefined();
    const edit = parseRoutineFence(json({ ...fence, routine: ROUTINE }));
    expect(matchingProposal(edit, [proposal({ number: 3 })])).toBeTruthy();
    expect(
      matchingProposal(edit, [
        proposal({ number: 3, routineId: 'c61e2a1e-0000-4000-8000-000000000004' }),
      ]),
    ).toBeUndefined();
  });

  it('tests the states in order: proposed, problems, unchecked, ready', () => {
    expect(
      draftState(parsed, draft({ proposals: [proposal({ state: 'approved' })] })),
    ).toMatchObject({
      kind: 'proposed',
      proposal: { state: 'approved' },
    });
    expect(
      draftState(
        parsed,
        draft({ problems: [{ part: 'manifest', code: 'tool_not_connected', message: 'x' }] }),
      ).kind,
    ).toBe('problems');
    expect(draftState(parsed, draft({ ok: false })).kind).toBe('unchecked');
    expect(draftState(parsed, draft()).kind).toBe('ready');
  });

  it('words the count by trigger', () => {
    expect(countText({ kind: 'record', value: 1 })).toMatch(/^1 change in the last 30 days/);
    expect(countText({ kind: 'schedule', value: 12 })).toMatch(/^12 records match now/);
    expect(countText({ kind: 'schedule_once', value: null })).toBe(
      'Runs once each time, without a record.',
    );
    expect(countText({ kind: 'manual', value: null })).toBeNull();
    expect(countText(null)).toBeNull();
  });
});
