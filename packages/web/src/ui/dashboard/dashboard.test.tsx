import { Renderer } from '@openuidev/react-lang';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { dashboardLibrary } from './library.js';
import { applyPatch, programAfter, splitAnswer } from './program.js';
import { dashboardTools, plainValue } from './tools.js';

const PROGRAM = `root = Dashboard("Deals", [kpis, stages, open])
byStage = Query("aggregate_records", {object: "deal", groupBy: "stage", aggregates: [{field: "amount", op: "sum"}]}, {total: 0, values: {sum_amount: 0}, groups: []})
recent = Query("query_records", {object: "deal", sort: [{field: "amount", direction: "desc"}], limit: 10}, {records: []})
kpis = Row([count, pipeline])
count = Metric("Deals", byStage.total)
pipeline = Metric("Pipeline", byStage.values.sum_amount, "money", "USD")
stages = BarChart("Deals by stage", byStage.groups.label, byStage.groups.total)
open = Table("Largest deals", recent.records, [TableColumn("Deal", "label"), TableColumn("Stage", "stage"), TableColumn("Amount", "amount", "money", "USD")])`;

const money = (units: number) => ({ amountMicros: units * 1_000_000, currency: 'USD' });

function fakeClient() {
  return {
    queryRecords: vi.fn(async () => ({
      nextCursor: null,
      records: [
        { id: 'r1', label: 'Acme renewal', fields: { stage: 'won', amount: money(5000) } },
        { id: 'r2', label: 'Globex pilot', fields: { stage: 'open', amount: money(1200) } },
      ],
    })),
    aggregate: vi.fn(async () => ({
      total: 3,
      values: [{ field: 'amount', op: 'sum' as const, value: money(7400) }],
      groups: [
        {
          value: 'won',
          total: 2,
          values: [{ field: 'amount', op: 'sum' as const, value: money(6200) }],
        },
        {
          value: 'open',
          total: 1,
          values: [{ field: 'amount', op: 'sum' as const, value: money(1200) }],
        },
      ],
    })),
  };
}

describe('dashboard tools', () => {
  it('makes values plain and keys aggregates by op and field', async () => {
    const client = fakeClient();
    const tools = dashboardTools(client as never);
    await expect(tools.aggregate_records({ object: 'deal', groupBy: 'stage' })).resolves.toEqual({
      total: 3,
      values: { sum_amount: 7400 },
      groups: [
        { label: 'won', total: 2, sum_amount: 6200 },
        { label: 'open', total: 1, sum_amount: 1200 },
      ],
    });
    const page = await tools.query_records({ object: 'deal', limit: 500 });
    expect(page.records[0]).toEqual({
      id: 'r1',
      label: 'Acme renewal',
      stage: 'won',
      amount: 5000,
    });
    expect(client.queryRecords).toHaveBeenCalledWith('deal', { limit: 200 });
    expect(plainValue({ first: 'Ada', last: 'Lovelace' })).toBe('Ada Lovelace');
  });
});

describe('dashboard programs', () => {
  it('splits prose from programs, an open fence still streaming', () => {
    expect(
      splitAnswer('Here it is:\n```openui-lang\nroot = Dashboard("A", [])\n```\nDone.'),
    ).toEqual([
      { kind: 'text', text: 'Here it is:\n' },
      { kind: 'program', code: 'root = Dashboard("A", [])\n', complete: true },
      { kind: 'text', text: '\nDone.' },
    ]);
    expect(splitAnswer('```openui-lang\nroot = Dash')).toEqual([
      { kind: 'program', code: 'root = Dash', complete: false },
    ]);
  });

  it('merges an edit into the dashboard before it', () => {
    const edited = applyPatch(
      PROGRAM,
      'pipeline = Metric("Open pipeline", byStage.values.sum_amount, "money", "USD")',
    );
    expect(edited).toContain('Metric("Open pipeline"');
    expect(edited).toContain('stages = BarChart(');
    expect(programAfter(null, ['no dashboard here'])).toBeNull();
  });
});

describe('dashboard rendering', () => {
  it('renders live numbers, bars and a table from the data tools', async () => {
    render(
      <Renderer
        response={PROGRAM}
        library={dashboardLibrary}
        toolProvider={dashboardTools(fakeClient() as never)}
        publishObservability={false}
      />,
    );
    expect(await screen.findByText('$7,400')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Deals' })).toBeTruthy();
    const bars = screen.getByText('Deals by stage').closest('section') as HTMLElement;
    expect(within(bars).getByText('won')).toBeTruthy();
    expect(within(bars).getByText('2')).toBeTruthy();
    const table = screen.getByText('Largest deals').closest('section') as HTMLElement;
    expect(within(table).getByRole('columnheader', { name: 'Stage' })).toBeTruthy();
    expect(within(table).getByText('Acme renewal')).toBeTruthy();
    expect(within(table).getByText('$5,000')).toBeTruthy();
  });
});
