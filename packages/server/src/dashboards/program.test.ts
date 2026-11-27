import { EXAMPLE_DASHBOARD } from '@retainer/shared';
import { describe, expect, it } from 'vitest';
import { inspectDashboard, rewriteQueries } from './program.js';

const root = 'root = Dashboard("Demo", [metric])\nmetric = Metric("Test", data.total)';
const query = 'data = Query("aggregate_records", {object: "deal"}, {total: 0})';

describe('dashboard programs', () => {
  it('checks the guide example and preserves the statements around each Query', () => {
    const { problems, queries } = inspectDashboard(EXAMPLE_DASHBOARD);
    expect(problems).toEqual([]);
    expect(queries.map(({ statement }) => statement)).toEqual(['byStage', 'recent']);
    const rewritten = rewriteQueries(EXAMPLE_DASHBOARD, queries, ({ args }) => args);
    expect(inspectDashboard(rewritten).problems).toEqual([]);
    expect(rewritten.split('\n').filter((line) => !line.includes('Query('))).toEqual(
      EXAMPLE_DASHBOARD.split('\n').filter((line) => !line.includes('Query(')),
    );
  });

  it.each([
    ['missing root', 'other = Metric("Test", 1)'],
    ['truncated', `${root}\n${query.slice(0, -2)}`],
    ['unknown orphaned component', 'root = Dashboard("Demo", [])\nunused = Unknown("x")'],
    ['invalid orphaned prop', 'root = Dashboard("Demo", [])\nunused = Metric("x", 1, "wrong")'],
    ['trailing tokens', 'root = Dashboard("Demo", []) trailing'],
    ['cycle', 'root = Dashboard("Demo", [])\na = b\nb = a'],
    ['unknown component', 'root = Dashboard("Demo", [Unknown("x")])'],
    ['extra prop', 'root = Dashboard("Demo", [], "extra")'],
    ['undefined reference', root],
    ['mutation', `${root}\ndata = Mutation("query_records", {}, {})`],
    ['unknown read', `${root}\n${query.replace('aggregate_records', 'other')}`],
    ['dynamic arguments', `${root}\n${query.replace('{object: "deal"}', 'metric')}`],
    ['overflowing refresh', `${root}\n${query.replace('{total: 0})', '{total: 0}, 2147484)')}`],
    ['refresh under a minute', `${root}\n${query.replace('{total: 0})', '{total: 0}, 59)')}`],
    [
      'missing alias',
      root +
        '\n' +
        query.replace(
          'object: "deal"',
          'object: "deal", aggregates: [{field: "amount", op: "sum"}]',
        ),
    ],
    [
      'reserved alias',
      root +
        '\n' +
        query.replace(
          'object: "deal"',
          'object: "deal", aggregates: [{field: "amount", op: "sum", as: "total"}]',
        ),
    ],
    [
      'table field instead of alias',
      EXAMPLE_DASHBOARD.replace('TableColumn("Amount", "amount")', 'TableColumn("Name", "name")'),
    ],
    [
      'too many reads',
      root +
        '\n' +
        query +
        '\n' +
        Array.from({ length: 20 }, (_, i) => query.replace('data =', `q${i} =`)).join('\n'),
    ],
    ['UTF-8 size', `root = Dashboard("${'🎉'.repeat(5300)}", [])`],
  ])('rejects %s', (_, program) => {
    expect(inspectDashboard(program).problems.length).toBeGreaterThan(0);
  });
});
