import {
  createLibrary,
  createParser,
  defineComponent,
  mergeStatements,
} from '@openuidev/lang-core';
import { DASHBOARD_TOOLS, dashboardComponents } from '@retainer/shared';

/**
 * The dashboard library for the prompt (spike). lang-core never looks at a
 * component's renderer, so the agent passes none; the web app builds the
 * same library with its own.
 */
const none = {
  Dashboard: null,
  Row: null,
  Metric: null,
  BarChart: null,
  Table: null,
  TableColumn: null,
};
export const dashboardLibrary = createLibrary({
  root: 'Dashboard',
  components: dashboardComponents(defineComponent, none),
});

const PREAMBLE = `## Dashboards

The person reads your answers in Retainer's web app, which can show a live dashboard: headline numbers, bar charts and tables over the workspace's records. When they ask for a dashboard, a chart, a breakdown or a report they will come back to, answer with a short sentence and one dashboard written in openui-lang, the language described below, inside an \`\`\`openui-lang fence. Answer every other question in plain text, as usual, without openui-lang.

A dashboard's Query() calls run in the person's browser each time it opens, with their access; they are not your tools. Before you write one, use describe_schema for the object's API name and field names (select options too), and query_records to see real values. Then write Query() calls with those names, so the numbers stay live; never copy numbers you read into the dashboard.`;

const RULES = [
  'Only Query() is available. Never use Mutation(), forms, inputs, buttons or $variables: dashboards are read-only.',
  'Use only the components listed above. A Dashboard is the root of every dashboard.',
  'For a breakdown by a select field, use aggregate_records with groupBy and chart its groups: labels = data.groups.label, values = data.groups.total (or a "<op>_<field>" key).',
  "To show a total per option (amount per stage), add it to the groupBy query's aggregates and chart data.groups.<op>_<field>. Never write one Query per option or type the options in: options added later must still appear.",
  'For a headline number, use aggregate_records and read data.total or data.values.<op>_<field>.',
  'Show at most 100 rows in a Table; set limit in query_records.',
  'Give money fields format "money" and their currency, e.g. Metric("Pipeline", data.values.sum_amount, "money", "USD") and TableColumn("Amount", "amount", "money", "USD").',
];

const TOOL_EXAMPLES = [
  `\`\`\`openui-lang
root = Dashboard("Deals", [kpis, stages, open])
byStage = Query("aggregate_records", {object: "deal", groupBy: "stage", aggregates: [{field: "amount", op: "sum"}]}, {total: 0, values: {sum_amount: 0}, groups: []})
recent = Query("query_records", {object: "deal", sort: [{field: "amount", direction: "desc"}], limit: 10}, {records: []})
kpis = Row([count, pipeline])
count = Metric("Deals", byStage.total)
pipeline = Metric("Pipeline", byStage.values.sum_amount, "money", "USD")
stages = BarChart("Deals by stage", byStage.groups.label, byStage.groups.total)
open = Table("Largest deals", recent.records, [TableColumn("Deal", "label"), TableColumn("Stage", "stage"), TableColumn("Amount", "amount", "money", "USD")])
\`\`\``,
];

/**
 * The second system block of a chat (spike): how to answer with a dashboard.
 * Static text, like the base prompt, so it caches with it.
 */
export const DASHBOARD_PROMPT = dashboardLibrary.prompt({
  preamble: PREAMBLE,
  tools: DASHBOARD_TOOLS,
  toolCalls: true,
  bindings: false,
  inlineMode: true,
  editMode: true,
  additionalRules: RULES,
  toolExamples: TOOL_EXAMPLES,
});

const parser = createParser(dashboardLibrary.toJSONSchema(), 'Dashboard');

/**
 * What is wrong with a dashboard program, if anything (spike): parse and
 * prop errors, names it uses but never defines, a missing root, and any
 * Mutation (dashboards are read-only). The server can run the same check
 * before it saves one.
 */
export function checkDashboard(program: string): string[] {
  const result = parser.parse(program);
  const problems = result.meta.errors.map((e) => `${e.component ?? '?'}: ${e.message}`);
  if (!result.root) problems.push('no root Dashboard');
  for (const name of result.meta.unresolved) problems.push(`${name} is used but never defined`);
  if (result.mutationStatements.length) problems.push('uses Mutation()');
  const tools = new Set(DASHBOARD_TOOLS.map((t) => t.name));
  for (const [, name] of program.matchAll(/\bQuery\(\s*"([^"]*)"/g))
    if (!tools.has(name ?? '')) problems.push(`Query calls unknown tool ${name}`);
  return problems;
}

/** A dashboard after an edit: the changed statements merged into the program before it. */
export const mergeDashboard = (program: string, patch: string) => mergeStatements(program, patch);
