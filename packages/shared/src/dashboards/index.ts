import { z } from 'zod';
import { AGGREGATE_OPS } from '../api.js';

/**
 * Dashboards the workspace agent writes in OpenUI Lang. One set of
 * components and data tools, used twice: the agent builds the library with
 * `@openuidev/lang-core` to write its prompt, and the web app builds it with
 * `@openuidev/react-lang` and its own renderers to show it. This module only
 * describes them, so `shared` takes no OpenUI dependency: each side passes
 * its own `defineComponent`.
 */

export const DASHBOARD_FORMATS = ['number', 'percent', 'date'] as const;
export type DashboardFormat = (typeof DASHBOARD_FORMATS)[number];

const format = z
  .enum(DASHBOARD_FORMATS)
  .optional()
  .describe('Use percent for 0–100 values, or date for date strings. Money formats itself.');

/** What a `defineComponent` returns that the specs below use. */
type Defined = { name: string; ref: unknown };
const ref = (component: Defined) => component.ref as z.ZodType;
type Define<C, D extends Defined> = (config: {
  name: string;
  description: string;
  props: z.ZodObject;
  component: C;
}) => D;

export const DASHBOARD_COMPONENT_NAMES = [
  'Dashboard',
  'Row',
  'Metric',
  'BarChart',
  'LineChart',
  'StackedBar',
  'PieChart',
  'Series',
  'Text',
  'Table',
  'TableColumn',
] as const;
export type DashboardComponentName = (typeof DASHBOARD_COMPONENT_NAMES)[number];

/**
 * The dashboard components, in dependency order, made with the caller's
 * `defineComponent`. Prop key order is the positional order in programs.
 */
export function dashboardComponents<C, D extends Defined>(
  define: Define<C, D>,
  renderers: Record<DashboardComponentName, C>,
) {
  const value = z.union([
    z.number(),
    z.string(),
    z.null(),
    z.object({ amount: z.number(), currency: z.string() }),
    z.object({ mixedCurrencies: z.literal(true) }),
  ]);
  const Metric = define({
    name: 'Metric',
    description: 'One headline number with a label, such as a total or an average.',
    props: z.object({
      label: z.string(),
      value,
      format,
    }),
    component: renderers.Metric,
  });
  const BarChart = define({
    name: 'BarChart',
    description:
      'Horizontal bars comparing values across categories, such as deals per stage. labels and values line up by position.',
    props: z.object({
      title: z.string(),
      labels: z.array(z.union([z.string(), z.null()])),
      values: z.array(value),
      format,
    }),
    component: renderers.BarChart,
  });
  const Series = define({
    name: 'Series',
    description: 'One named line or stack, with a value per label.',
    props: z.object({ name: z.string(), values: z.array(value) }),
    component: renderers.Series,
  });
  const makeSeriesChart = (name: 'LineChart' | 'StackedBar', description: string) =>
    define({
      name,
      description,
      props: z.object({
        title: z.string(),
        labels: z.array(z.union([z.string(), z.null()])),
        series: z.array(ref(Series)),
        format,
      }),
      component: renderers[name],
    });
  const LineChart = makeSeriesChart('LineChart', 'Lines comparing values across periods.');
  const StackedBar = makeSeriesChart('StackedBar', 'Bars split into multiple series.');
  const PieChart = define({
    name: 'PieChart',
    description: 'Shares of a whole. Smaller slices are folded into Other.',
    props: z.object({
      title: z.string(),
      labels: z.array(z.union([z.string(), z.null()])),
      values: z.array(value),
      format,
    }),
    component: renderers.PieChart,
  });
  const Text = define({
    name: 'Text',
    description: 'A short plain-text note.',
    props: z.object({ text: z.string() }),
    component: renderers.Text,
  });
  const TableColumn = define({
    name: 'TableColumn',
    description: 'One column of a Table: its heading and the row key it shows.',
    props: z.object({
      label: z.string(),
      key: z.string(),
      format,
    }),
    component: renderers.TableColumn,
  });
  const Table = define({
    name: 'Table',
    description:
      'Rows of records with chosen columns. rows is a list of objects, e.g. data.records.',
    props: z.object({
      title: z.string(),
      rows: z.array(z.record(z.string(), z.unknown())),
      columns: z.array(ref(TableColumn)),
    }),
    component: renderers.Table,
  });
  const tiles = [
    ref(Metric),
    ref(BarChart),
    ref(StackedBar),
    ref(LineChart),
    ref(PieChart),
    ref(Table),
    ref(Text),
  ] as const;
  const Row = define({
    name: 'Row',
    description: 'Places tiles side by side, for example three Metrics.',
    props: z.object({ children: z.array(z.union(tiles)) }),
    component: renderers.Row,
  });
  const Dashboard = define({
    name: 'Dashboard',
    description: 'The whole dashboard: a title and its tiles, top to bottom.',
    props: z.object({
      title: z.string(),
      children: z.array(z.union([ref(Row), ...tiles])),
    }),
    component: renderers.Dashboard,
  });
  return [
    Dashboard,
    Row,
    Metric,
    BarChart,
    StackedBar,
    LineChart,
    PieChart,
    Table,
    TableColumn,
    Series,
    Text,
  ] as D[];
}

export const DASHBOARD_MAX_BYTES = 20 * 1024;
export const DASHBOARD_MAX_QUERIES = 20;
export const DASHBOARD_MIN_REFRESH = 60;

const reserved = new Set([
  'id',
  'label',
  'total',
  'value',
  '__proto__',
  'constructor',
  'prototype',
]);
const alias = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine((name) => !reserved.has(name), {
    message: 'This alias is reserved',
  });
const base = {
  object: z.string().min(1),
  search: z.string().trim().min(1).max(500).optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};
export const dashboardRecordsSchema = z.strictObject({
  ...base,
  sort: z
    .array(z.strictObject({ field: z.string(), direction: z.enum(['asc', 'desc']).default('asc') }))
    .max(3)
    .optional(),
  fields: z.record(alias, z.string()),
});
export const dashboardAggregateSchema = z
  .strictObject({
    ...base,
    aggregates: z
      .array(z.strictObject({ field: z.string(), op: z.enum(AGGREGATE_OPS), as: alias }))
      .max(50)
      .optional(),
    groupBy: z.string().optional(),
    granularity: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
  })
  .refine(
    ({ aggregates = [] }) => new Set(aggregates.map((item) => item.as)).size === aggregates.length,
    {
      message: 'Aggregate aliases must be unique',
    },
  );

export const DASHBOARD_TOOLS = [
  {
    name: 'query_records',
    description:
      'Read up to 200 records. fields maps aliases to schema field names. Returns records with id, label and the selected aliases. Money includes its currency.',
    inputSchema: z.toJSONSchema(dashboardRecordsSchema),
    outputSchema: {
      type: 'object',
      properties: { records: { type: 'array', items: { type: 'object' } } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'aggregate_records',
    description:
      'Return total, values keyed by each aggregate’s as alias, and groups with value, label, total and aggregate aliases. Group by select, dates or a single relation.',
    inputSchema: z.toJSONSchema(dashboardAggregateSchema, { unrepresentable: 'any' }),
    outputSchema: {
      type: 'object',
      properties: {
        total: { type: 'number' },
        values: { type: 'object' },
        groups: { type: 'array', items: { type: 'object' } },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

export type DashboardIssue = { statement: string; message: string };
export type DashboardVisibility = 'private' | 'workspace';
export type DashboardSummary = {
  id: string;
  name: string;
  position: number;
  visibility: DashboardVisibility;
  chatId: string | null;
  createdBy: import('../actor.js').Actor;
  updatedBy: import('../actor.js').Actor;
  createdAt: string;
  updatedAt: string;
};
export type SavedDashboard = DashboardSummary & { program: string; issues: DashboardIssue[] };
export type CreateDashboard = {
  name: string;
  program: string;
  visibility?: DashboardVisibility;
  chatId?: string | null;
};
export type UpdateDashboard = Partial<CreateDashboard> & {
  position?: number;
  expectedUpdatedAt: string;
};

export const EXAMPLE_DASHBOARD = `root = Dashboard("Deals", [count, stages, open])
byStage = Query("aggregate_records", {object: "deal", groupBy: "stage"}, {total: 0, values: {}, groups: []})
recent = Query("query_records", {object: "deal", limit: 10, fields: {amount: "amount"}}, {records: []})
count = Metric("Deals", byStage.total)
stages = BarChart("Deals by stage", byStage.groups.label, byStage.groups.total)
open = Table("Deals", recent.records, [TableColumn("Deal", "label"), TableColumn("Amount", "amount")])`;
