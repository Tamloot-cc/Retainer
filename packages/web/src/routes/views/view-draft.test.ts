import { displayViewGroups, type ObjectView } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import { describeFilter } from './settings-summary.js';
import { parseViewDraft } from './view-draft.js';

const object = {
  fields: [
    {
      name: 'stage',
      label: 'Stage',
      type: 'select',
      settings: { options: [{ value: 'lead', label: 'Lead' }] },
    },
    { name: 'closeDate', label: 'Close date', type: 'date', settings: {} },
    { name: 'company', label: 'Company', type: 'relation', settings: {} },
  ],
} as ObjectView;

describe('view draft settings', () => {
  it('accepts new and edit envelopes and refuses access and position settings', () => {
    const fresh = { object: 'deal', kind: 'table', name: 'Hot leads' };
    const edit = { view: 'a-view-id', groupBy: null };
    expect(parseViewDraft(JSON.stringify(fresh))).toEqual(fresh);
    expect(parseViewDraft(JSON.stringify(edit))).toEqual(edit);
    for (const restricted of [
      { visibility: 'private' },
      { position: 4 },
      { expectedUpdatedAt: 'now' },
    ])
      expect(() => parseViewDraft(JSON.stringify({ ...fresh, ...restricted }))).toThrow();
  });

  it('describes nested filters, labels and relative values in plain words', () => {
    expect(
      describeFilter(
        {
          and: [
            { or: [{ stage: 'lead' }, { company: { isNull: true } }] },
            { not: { closeDate: { within: { next: 2, unit: 'week' } } } },
            { closeDate: { lt: { ago: 3, unit: 'day' } } },
          ],
        },
        object,
      ),
    ).toBe(
      '((Stage is Lead or Company is empty) and Not (Close date is within the next 2 weeks) and Close date is before 3 days ago)',
    );
  });

  it('orders dates by period and keeps the overflow last when some groups are hidden', () => {
    const groups = [
      { value: '2026-03-01', label: 'March', total: 1, values: [] },
      { value: '2026-02-01', label: 'February', total: 1, values: [] },
      { value: '2026-01-01', label: 'January', total: 1, values: [] },
      { value: null, label: 'Earlier', total: 2, values: [], overflow: true as const },
    ];
    expect(
      displayViewGroups(groups, { groupBy: 'closeDate', hiddenGroups: ['2026-02-01'] }).map(
        ({ label }) => label,
      ),
    ).toEqual(['January', 'March', 'Earlier']);
    expect(
      displayViewGroups(groups, { groupBy: 'closeDate', groupOrder: 'desc', hiddenGroups: [] }).map(
        ({ label }) => label,
      ),
    ).toEqual(['March', 'February', 'January', 'Earlier']);
  });
});
