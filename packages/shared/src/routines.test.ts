import { describe, expect, it } from 'vitest';
import { describeFilter, routineFacts, routineManifestSchema } from './routines.js';

const names = {
  object: (id: string) =>
    id === 'deal'
      ? { singular: 'deal', plural: 'deals', isEvent: false }
      : { singular: 'meeting', plural: 'meetings', isEvent: true },
  field: (_object: string, key: string) =>
    ({ f_stage: 'Stage', f_amount: 'Amount', f_close: 'Close date' })[key] ?? key,
  tool: (name: string) =>
    name === 'send_email' ? { title: 'Send an email', effect: 'send' as const } : undefined,
};

describe('routine facts', () => {
  it("states a manifest's trigger, condition, reach and limits in fixed words", () => {
    const manifest = routineManifestSchema.parse({
      when: {
        kind: 'record',
        object: 'deal',
        on: ['updated'],
        fields: ['f_stage'],
        oncePerRecord: true,
      },
      if: { f_stage: { eq: 'won' }, f_amount: { gt: 100 } },
      expiry: { field: 'f_close' },
      uses: { tools: ['send_email'], model: true },
    });
    expect(routineFacts(manifest, names)).toEqual([
      "Runs when a deal's Stage changes.",
      'Only when the deal matches: Stage is "won" and Amount is greater than 100.',
      'Acts at most once for each deal, ever.',
      "A run stops acting once the deal's Close date has passed, and 24 hours after it starts at the latest.",
      'Calls a model, so the record content its code passes is sent to the model provider.',
      'May call these tools: "Send an email" (acts outside Retainer).',
      'It can send things outside Retainer without anyone reviewing them first.',
      'Writes as an agent: its values never replace what a person or a sync set without review.',
    ]);
  });

  it('describes schedules, buttons and nested filters', () => {
    expect(
      routineFacts(
        routineManifestSchema.parse({
          when: { kind: 'schedule', cron: '0 9 * * 1', object: 'deal' },
          uses: { tools: [], model: false },
        }),
        names,
      ).slice(0, 1),
    ).toEqual([
      'Runs on the schedule "0 9 * * 1" (the workspace\'s time zone), once for each deal, up to 200.',
    ]);
    expect(
      routineFacts(
        routineManifestSchema.parse({
          when: { kind: 'manual', object: 'deal', label: 'Send quote' },
          uses: { tools: [], model: false },
        }),
        names,
      )[0],
    ).toContain('presses "Send quote" on a deal');
    expect(
      describeFilter(
        { or: [{ f_stage: { in: ['a', 'b'] } }, { not: { f_amount: { isNull: true } } }] },
        (key) => names.field('deal', key),
      ),
    ).toBe('(Stage is one of ["a","b"] or not (Amount is empty))');
  });

  it('refuses manifests outside the grammar', () => {
    expect(
      routineManifestSchema.safeParse({
        when: { kind: 'relative', object: 'deal' },
        uses: { tools: [], model: false },
      }).success,
    ).toBe(false);
    expect(
      routineManifestSchema.safeParse({
        when: { kind: 'record', object: 'deal', on: [] },
        uses: { tools: [], model: false },
      }).success,
    ).toBe(false);
  });
});
