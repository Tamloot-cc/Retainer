import { isElementNode } from '@openuidev/lang-core';
import {
  type ComponentRenderer,
  type ComponentRenderProps,
  createLibrary,
  defineComponent,
  useDataSources,
  useRendererQuery,
} from '@openuidev/react-lang';
import {
  DASHBOARD_FORMATS,
  type DashboardComponentName,
  type DashboardFormat,
  type DashboardIssue,
  dashboardComponents,
} from '@retainer/shared';
import { createContext, lazy, type ReactNode, Suspense, useContext } from 'react';
import type { ChartDatum, ChartKind } from './charts.js';
import { formatValue, isMixed, isMoney } from './format.js';
import { DashboardTable } from './table.js';

// The renderer checks this flag before mounting its development inspector.
(globalThis as Record<symbol, unknown>)[Symbol.for('openui.devtools.autoMount')] = true;

const Chart = lazy(() => import('./charts.js'));
export const DashboardIssues = createContext<DashboardIssue[]>([]);

export function Details({ label, messages }: { label: string; messages: string[] }) {
  return (
    <details className="text-sm text-muted-foreground">
      <summary className="cursor-pointer">{label}</summary>
      <ul className="mt-1 list-disc ps-5">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </details>
  );
}

function Tile({ id, label, children }: { id?: string; label: string; children: ReactNode }) {
  const sources = useDataSources();
  const { errors } = useRendererQuery();
  const issues = useContext(DashboardIssues);
  const queries = id ? (sources?.components[id]?.queries ?? []) : [];
  const unavailable = issues.filter((issue) => queries.includes(issue.statement));
  const failures = errors.filter(
    (issue) => issue.statementId && queries.includes(issue.statementId),
  );
  const trimmed = queries.flatMap((name) => {
    const data = sources?.queries[name]?.data;
    if (
      data &&
      typeof data === 'object' &&
      'tooManyGroups' in data &&
      data.tooManyGroups &&
      'groups' in data &&
      Array.isArray(data.groups)
    )
      return [data.groups.length];
    return [];
  });
  const loading = queries.some((name) => {
    const query = sources?.queries[name];
    return query?.loading === true;
  });
  return (
    <section
      aria-label={label}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4"
    >
      {unavailable.length || failures.length ? (
        <h3 className="text-sm font-semibold">{label}</h3>
      ) : null}
      {unavailable.length ? (
        <Details
          label="This part uses data that was removed or is unavailable"
          messages={[...new Set(unavailable.map((item) => item.message))]}
        />
      ) : failures.length ? (
        <Details
          label="This part couldn’t load"
          messages={[...new Set(failures.map((item) => item.message))]}
        />
      ) : (
        <>
          {children}
          {loading ? (
            <span className="text-xs text-muted-foreground" role="status">
              Refreshing…
            </span>
          ) : null}
        </>
      )}
      {trimmed.length ? (
        <p className="text-xs text-muted-foreground">Showing {Math.min(...trimmed)} groups</p>
      ) : null}
    </section>
  );
}

function formatOf(value: unknown): DashboardFormat | undefined {
  return DASHBOARD_FORMATS.find((format) => format === value);
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const numberOf = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : isMoney(value)
      ? value.amount
      : null;
const piece = (value: unknown, name: string) =>
  isElementNode(value) && value.typeName === name ? value.props : undefined;

function chartRows(
  labels: unknown[],
  series: unknown[][],
  pie: boolean,
  currency?: string,
): ChartDatum[] {
  const rows = labels.map((label, index) => {
    const values = series.map((values) => values[index] ?? null);
    return { label: text(label) || 'No value', values, amounts: values.map(numberOf) };
  });
  if (!pie || rows.length <= 7) return rows;
  const sorted = [...rows].sort((a, b) => (b.amounts[0] ?? 0) - (a.amounts[0] ?? 0));
  const rest = sorted.slice(6);
  const amount = rest.reduce((sum, row) => sum + (row.amounts[0] ?? 0), 0);
  return [
    ...sorted.slice(0, 6),
    {
      label: 'Other',
      values: [currency ? { amount, currency } : amount],
      amounts: [amount],
    },
  ];
}

function ChartTile({
  kind,
  id,
  props,
}: {
  kind: ChartKind;
  id?: string;
  props: Record<string, unknown>;
}) {
  const title = text(props.title);
  const format = formatOf(props.format);
  const series =
    kind === 'bar' || kind === 'pie'
      ? [{ name: 'Value', values: list(props.values) }]
      : list(props.series).flatMap((value) => {
          const entry = piece(value, 'Series');
          return entry ? [{ name: text(entry.name), values: list(entry.values) }] : [];
        });
  const values = series.flatMap(({ values }) => values);
  const currencies = new Set(values.filter(isMoney).map(({ currency }) => currency));
  const mixed = currencies.size > 1 || values.some(isMixed);
  const currency = currencies.values().next().value;
  const rows = chartRows(
    list(props.labels),
    series.map((entry) => entry.values),
    kind === 'pie' && !mixed,
    currency,
  );
  const names = series.map(({ name }) => name);
  const validPie =
    kind !== 'pie' ||
    (rows.some((row) => (row.amounts[0] ?? 0) > 0) &&
      rows.every((row) => (row.amounts[0] ?? 0) >= 0));
  const hasValues = rows.some(({ amounts }) => amounts.some((value) => value !== null));
  return (
    <Tile id={id} label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {mixed ? <p className="text-sm text-muted-foreground">Mixed currencies</p> : null}
      {!mixed && validPie && hasValues ? (
        <Suspense fallback={<ChartFallback rows={rows} />}>
          <Chart kind={kind} names={names} rows={rows} format={format} currency={currency} />
        </Suspense>
      ) : null}
      {!mixed && !hasValues ? <p className="text-sm text-muted-foreground">No data</p> : null}
      {rows.length ? (
        <details>
          <summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            View data table
          </summary>
          <div className="mt-2">
            <DashboardTable
              title={title}
              columns={['Category', ...names]}
              rows={rows.map((row, index) => ({
                id: String(index),
                cells: [row.label, ...row.values.map((value) => formatValue(value, format))],
              }))}
            />
          </div>
        </details>
      ) : null}
    </Tile>
  );
}

function ChartFallback({ rows }: { rows: ChartDatum[] }) {
  const max = Math.max(1, ...rows.map(({ amounts }) => Math.abs(amounts[0] ?? 0)));
  return (
    <div aria-hidden className="space-y-2">
      {rows.slice(0, 10).map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: categories may display the same label.
        <div key={index} className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-24 shrink-0 truncate">{row.label}</span>
          <div className="h-2 flex-1 rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${(Math.abs(row.amounts[0] ?? 0) / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function tileId({ statementId, bindSource }: ComponentRenderProps) {
  return statementId ?? bindSource?.()['data-openui-source'];
}

function Table(component: ComponentRenderProps) {
  const { props } = component;
  const title = text(props.title);
  const columns = list(props.columns).flatMap((column) => {
    const definition = piece(column, 'TableColumn');
    return definition ? [definition] : [];
  });
  const rows = list(props.rows)
    .slice(0, 100)
    .flatMap((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      return [
        {
          id: typeof row.id === 'string' ? row.id : String(index),
          cells: columns.map((column) =>
            formatValue(
              Object.hasOwn(row, text(column.key)) ? row[text(column.key)] : null,
              formatOf(column.format),
            ),
          ),
        },
      ];
    });
  return (
    <Tile id={tileId(component)} label={title}>
      <h3 className="text-sm font-semibold">{title}</h3>
      <DashboardTable
        title={title}
        columns={columns.map((column) => text(column.label))}
        rows={rows}
      />
    </Tile>
  );
}

const chart = (kind: ChartKind) => (component: ComponentRenderProps) => (
  <ChartTile kind={kind} id={tileId(component)} props={component.props} />
);

const renderers: Record<DashboardComponentName, ComponentRenderer> = {
  Dashboard: ({ props, renderNode }) => (
    <div className="flex min-w-0 flex-col gap-3">
      <h2 className="text-lg font-semibold" dir="auto">
        {text(props.title)}
      </h2>
      {renderNode(props.children)}
    </div>
  ),
  Row: ({ props, renderNode }) => (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))]">
      {renderNode(props.children)}
    </div>
  ),
  Metric: (component) => {
    const { props } = component;
    return (
      <Tile id={tileId(component)} label={text(props.label)}>
        <h3 className="text-sm font-medium text-muted-foreground">{text(props.label)}</h3>
        <p className="text-2xl font-semibold tabular-nums">
          {formatValue(props.value, formatOf(props.format))}
        </p>
      </Tile>
    );
  },
  Table,
  TableColumn: () => null,
  Series: () => null,
  BarChart: chart('bar'),
  LineChart: chart('line'),
  StackedBar: chart('stacked'),
  PieChart: chart('pie'),
  Text: ({ props }) => (
    <p dir="auto" className="whitespace-pre-wrap text-sm text-muted-foreground">
      {text(props.text)}
    </p>
  ),
};

export const dashboardLibrary = createLibrary({
  root: 'Dashboard',
  components: dashboardComponents(defineComponent, renderers),
});
