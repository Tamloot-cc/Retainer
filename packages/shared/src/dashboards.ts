import { z } from 'zod';

/**
 * Dashboards the workspace agent writes in OpenUI Lang (spike). One set of
 * components and data tools, used twice: the agent builds the library with
 * `@openuidev/lang-core` to write its prompt, and the web app builds it with
 * `@openuidev/react-lang` and its own renderers to show it. This module only
 * describes them, so `shared` takes no OpenUI dependency: each side passes
 * its own `defineComponent`.
 */

export const DASHBOARD_FORMATS = ['number', 'money', 'percent'] as const;
export type DashboardFormat = (typeof DASHBOARD_FORMATS)[number];

const format = z
  .enum(DASHBOARD_FORMATS)
  .optional()
  .describe('How to show numbers: "money" for amounts, "percent" for 0-100 values.');

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
  const Metric = define({
    name: 'Metric',
    description: 'One headline number with a label, such as a total or an average.',
    props: z.object({
      label: z.string(),
      value: z.union([z.number(), z.string(), z.null()]),
      format,
      currency: z.string().optional().describe('ISO 4217 code for "money", e.g. "USD".'),
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
      values: z.array(z.union([z.number(), z.null()])),
      format,
      currency: z.string().optional(),
    }),
    component: renderers.BarChart,
  });
  const TableColumn = define({
    name: 'TableColumn',
    description: 'One column of a Table: its heading and the row key it shows.',
    props: z.object({
      label: z.string(),
      key: z.string(),
      format,
      currency: z.string().optional().describe('ISO 4217 code for "money", e.g. "USD".'),
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
  const tile = z.union([ref(Metric), ref(BarChart), ref(Table)]);
  const Row = define({
    name: 'Row',
    description: 'Places tiles side by side, for example three Metrics.',
    props: z.object({ children: z.array(tile) }),
    component: renderers.Row,
  });
  const Dashboard = define({
    name: 'Dashboard',
    description: 'The whole dashboard: a title and its tiles, top to bottom.',
    props: z.object({
      title: z.string(),
      children: z.array(z.union([ref(Row), ref(Metric), ref(BarChart), ref(Table)])),
    }),
    component: renderers.Dashboard,
  });
  return [Dashboard, Row, Metric, BarChart, Table, TableColumn] as D[];
}

/** The data tools a dashboard's `Query` calls. They run in the viewer's browser with the viewer's access. */
export const DASHBOARD_TOOLS = [
  {
    name: 'query_records',
    description:
      'Records of one object, filtered and sorted like the query_records tool (same object, filter, sort and search), at most 200. ' +
      'Each record has id, label and its fields by name, with values made plain: money as a number in currency units, a name as text, a relation as a record ID.',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'string' },
        filter: { type: 'object' },
        search: { type: 'string' },
        sort: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, direction: { enum: ['asc', 'desc'] } },
          },
        },
        limit: { type: 'number' },
      },
      required: ['object'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, label: { type: 'string' } },
            additionalProperties: true,
          },
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'aggregate_records',
    description:
      'Counts and totals over the records of one object that match a filter. aggregates lists { field, op } with op one of ' +
      'countEmpty, countNotEmpty, percentEmpty, percentNotEmpty, countUnique, sum, avg, min, max. ' +
      'groupBy names a select field and adds one group per option. Each result is keyed "<op>_<field>", e.g. sum_amount; money is a number in currency units.',
    inputSchema: {
      type: 'object',
      properties: {
        object: { type: 'string' },
        filter: { type: 'object' },
        search: { type: 'string' },
        aggregates: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, op: { type: 'string' } },
          },
        },
        groupBy: { type: 'string' },
      },
      required: ['object'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        total: { type: 'number' },
        values: { type: 'object', additionalProperties: { type: 'number' } },
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, total: { type: 'number' } },
            additionalProperties: { type: 'number' },
          },
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
];
