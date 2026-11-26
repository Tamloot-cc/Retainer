import { DASHBOARD_COMPONENT_NAMES, DASHBOARD_TOOLS } from '@retainer/shared';
import { expect, it } from 'vitest';
import { DASHBOARD_PROMPT } from './dashboards.js';

it('describes every dashboard component and data tool, read-only', () => {
  for (const name of DASHBOARD_COMPONENT_NAMES) expect(DASHBOARD_PROMPT).toContain(`${name}(`);
  for (const tool of DASHBOARD_TOOLS) expect(DASHBOARD_PROMPT).toContain(tool.name);
  expect(DASHBOARD_PROMPT).toMatch(/Never use Mutation\(\)/);
  expect(DASHBOARD_PROMPT).toMatch(/they are not your tools/);
  // An add-on to the base prompt, not a replacement: no "your ENTIRE response" rule.
  expect(DASHBOARD_PROMPT).not.toMatch(/ENTIRE response must be valid openui-lang/);
});

it('checks a dashboard program before it is saved', async () => {
  const { checkDashboard } = await import('./dashboards.js');
  const good = `root = Dashboard("Deals", [count])
data = Query("aggregate_records", {object: "deal"}, {total: 0})
count = Metric("Deals", data.total)`;
  expect(checkDashboard(good)).toEqual([]);
  expect(checkDashboard('root = Dashboard("Deals", [missing])')).toEqual([
    'missing is used but never defined',
  ]);
  expect(
    checkDashboard(
      `root = Dashboard("X", [m])\nm = Metric("A", d.total)\nd = Query("delete_records", {}, {})`,
    ),
  ).toContain('Query calls unknown tool delete_records');
  expect(checkDashboard(`root = Dashboard("X", [])\nr = Mutation("query_records", {})`)).toContain(
    'uses Mutation()',
  );
});
