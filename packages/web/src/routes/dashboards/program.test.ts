import { EXAMPLE_DASHBOARD } from '@retainer/shared';
import { expect, it } from 'vitest';
import { mergeDashboardBlocks, renderableProgram, sameDashboardProgram } from './program.js';

it('merges the changed statements and drops unused components', () => {
  const patch =
    'root = Dashboard("Edited", [count])\ncount = Metric("Deals remaining", byStage.total)';
  const merged = mergeDashboardBlocks([EXAMPLE_DASHBOARD], patch);
  expect(merged).toContain('count = Metric("Deals remaining", byStage.total)');
  expect(merged).toContain('byStage = Query');
  expect(merged).not.toContain('stages =');
});

it('disables reads with a removed field, a fast refresh, or a nonliteral argument', () => {
  const invalid = `root = Dashboard("Plan", [])
fast = Query("aggregate_records", {object: "deal"}, {}, 59)
overflow = Query("aggregate_records", {object: "deal"}, {}, 2147484)
dynamic = Query("aggregate_records", {object: fast.total}, {})
removed = Query("aggregate_records", {object: "deal", groupBy: "stage"}, {})
valid = Query("aggregate_records", {object: "deal"}, {}, 60)`;
  const safe = renderableProgram(invalid, [{ statement: 'removed', message: 'Unknown stage' }]);
  expect(safe.issues.map(({ statement }) => statement).sort()).toEqual([
    'dynamic',
    'fast',
    'overflow',
    'removed',
  ]);
  expect(safe.program.match(/Query\("__unavailable"/g)).toHaveLength(4);
  expect(safe.program).toContain('valid = Query("aggregate_records", {object: "deal"}, {}, 60)');
});

it('recognizes a persisted program after the API reformats its query arguments', () => {
  const saved = EXAMPLE_DASHBOARD.replace(
    '{object: "deal", limit: 10, fields: {amount: "amount"}}',
    '{"fields":{"amount":"amount"},"limit":10,"object":"deal"}',
  );
  expect(sameDashboardProgram(saved, EXAMPLE_DASHBOARD)).toBe(true);
  expect(sameDashboardProgram(saved.replace('limit":10', 'limit":5'), EXAMPLE_DASHBOARD)).toBe(
    false,
  );
});

it('rejects a nested query before any part of the draft can run', () => {
  const source = `root = Dashboard("Plan", [count])
count = Metric("Count", Query("aggregate_records", {object: "deal"}, {total: 0}, 60).total)`;
  expect(renderableProgram(source, [])).toEqual({
    program: '',
    issues: [{ statement: 'count', message: 'Query must be its own statement' }],
  });
});

it('removes query calls and their refresh timers from historical previews', () => {
  const source = `root = Dashboard("Plan", [count])
rows = Query("aggregate_records", {object: "deal"}, {total: 0}, 60)
count = Metric("Count", rows.total)`;
  const safe = renderableProgram(source, [], { live: false });
  expect(safe.issues).toEqual([]);
  expect(safe.program).toContain('rows = null');
  expect(safe.program).not.toContain('Query(');
  expect(safe.program).toContain('count = Metric("Count", rows.total)');
});
