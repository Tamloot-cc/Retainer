import { DASHBOARD_TOOLS, EXAMPLE_DASHBOARD } from '@retainer/shared';
import { dashboardLibrary } from './program.js';

const dataTools = DASHBOARD_TOOLS.map(
  ({ name, description, inputSchema }) =>
    `- ${name}: ${description}\n  Arguments: ${JSON.stringify(inputSchema.properties)}`,
).join('\n');

export const dashboardGuide = dashboardLibrary.prompt({
  preamble: [
    'Write a live dashboard only when the person asks for one or a reusable breakdown clearly fits. Answer other requests in plain text. Only Retainer’s web app renders these dashboards.',
    'Use a statement like `data = Query("aggregate_records", {object: "deal"}, {total: null}, 60)`. The last argument is an optional refresh interval in seconds. The browser reads with the viewer’s access and distinguishes loading, failure and zero.',
    'The only dashboard data tools are:',
    dataTools,
  ].join('\n\n'),
  // The generic tool workflow also describes write actions. Supply the
  // dashboard reads above and keep the language and component signatures.
  toolCalls: false,
  builtinFunctions: true,
  inlineMode: true,
  editMode: true,
  bindings: false,
  additionalRules: [
    'Learn the current schema with describe_schema and try the reads with query_records and aggregate_records.',
    'Use root = Dashboard(…). Keep all field names inside Query arguments, which must be literal values. Use fields to map record fields to aliases, and as to alias every aggregate. The aliases id, label, value and total are reserved.',
    'Use Query only. Dashboards have no mutations, actions, interactive inputs or state variables. Use at most 20 reads and refresh no faster than once per minute.',
    'Read all data from Query. Never copy record values or computed totals into a program.',
    'For a headline count, use aggregate_records and bind the Metric to the query’s .total. A query_records page has at most 200 rows and its selection fields contain display labels. When using @Filter on dashboard rows for a display calculation, compare against the displayed values.',
    'Use the stored option values from describe_schema in Query filters. A select uses equality, e.g. {stage: "won"}. A multi_select uses contains for membership, e.g. {tags: {contains: "competitor"}}.',
    'For a category breakdown, query with groupBy and read groups.label and groups.total or groups.<alias>. Never enumerate options or issue a query per option.',
    'For time charts, group on a date such as createdAt or occurredAt, and choose day, week, month, quarter or year. A Series takes one value per label.',
    'Money carries its currency. Use the optional percent format only for values from 0 to 100.',
    'Call check_dashboard with the complete merged program before answering. Fix reported problems before replying. When editing, send only changed statements in the answer fence. For a new independent dashboard, include the root and all statements it needs.',
  ],
  examples: [
    `\`\`\`openui-lang\n${EXAMPLE_DASHBOARD}\n\`\`\``,
    [
      '```openui-lang',
      'root = Dashboard("Won deals", [metric])',
      'won = Query("aggregate_records", {object: "deal", filter: {stage: "won"}}, {total: null})',
      'metric = Metric("Won deals", won.total)',
      '```',
    ].join('\n'),
  ],
});
