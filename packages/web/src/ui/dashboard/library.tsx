import './quiet.js';
import {
  type ComponentRenderer,
  createLibrary,
  type DefinedComponent,
  defineComponent,
} from '@openuidev/react-lang';
import { type DashboardFormat, dashboardComponents } from '@retainer/shared';
import type { ReactNode } from 'react';
import { Table as Grid, Td, Tr } from '../index.js';

/**
 * The dashboard library (spike): the components the agent writes, with
 * Retainer's own look. The props come from `@retainer/shared`, so the
 * agent's prompt and these renderers can't drift apart.
 */

export function formatValue(value: unknown, format?: DashboardFormat, currency?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value !== 'number') return String(value);
  if (format === 'percent')
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`;
  if (format === 'money' && currency && /^[A-Z]{3}$/.test(currency))
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function Tile({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

type Props<K extends string> = Record<K, unknown>;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const Dashboard: ComponentRenderer<Props<'title' | 'children'>> = ({ props, renderNode }) => (
  <div className="flex flex-col gap-3">
    <h2 className="text-base font-semibold">{String(props.title ?? '')}</h2>
    {renderNode(props.children)}
  </div>
);

const Row: ComponentRenderer<Props<'children'>> = ({ props, renderNode }) => (
  <div className="flex flex-col gap-3 md:flex-row">{renderNode(props.children)}</div>
);

const Metric: ComponentRenderer<Props<'label' | 'value' | 'format' | 'currency'>> = ({ props }) => (
  <Tile title={String(props.label ?? '')}>
    <p className="text-2xl font-semibold tabular-nums">
      {formatValue(props.value, props.format as DashboardFormat, props.currency as string)}
    </p>
  </Tile>
);

const BarChart: ComponentRenderer<Props<'title' | 'labels' | 'values' | 'format' | 'currency'>> = ({
  props,
}) => {
  const labels = list(props.labels);
  const values = list(props.values).map((v) => (typeof v === 'number' ? v : 0));
  const max = Math.max(0, ...values);
  return (
    <Tile title={String(props.title ?? '')}>
      {values.length ? (
        <ul className="flex flex-col gap-1.5 text-sm">
          {values.map((value, i) => (
            // Bars are positional: the program gives labels and values in the same order.
            // biome-ignore lint/suspicious/noArrayIndexKey: positional data
            <li key={i} className="grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-2">
              <span className="truncate text-muted-foreground">
                {labels[i] === null || labels[i] === undefined ? 'No value' : String(labels[i])}
              </span>
              <span className="h-2.5 rounded-sm bg-muted">
                <span
                  className="block h-full rounded-sm bg-primary"
                  style={{ width: `${max ? (value / max) * 100 : 0}%` }}
                />
              </span>
              <span className="tabular-nums">
                {formatValue(value, props.format as DashboardFormat, props.currency as string)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing to show.</p>
      )}
    </Tile>
  );
};

/** Rendered by `Table`, which reads its props; alone it shows nothing. */
const TableColumn: ComponentRenderer<Props<'label' | 'key' | 'format' | 'currency'>> = () => null;

type Column = { label: string; key: string; format?: DashboardFormat; currency?: string };
const columnsOf = (value: unknown): Column[] =>
  list(value).flatMap((c) => {
    const props = (c as { props?: Record<string, unknown> } | null)?.props;
    return props && typeof props.key === 'string'
      ? [
          {
            label: String(props.label ?? props.key),
            key: props.key,
            format: props.format as DashboardFormat,
            currency: typeof props.currency === 'string' ? props.currency : undefined,
          },
        ]
      : [];
  });

const Table: ComponentRenderer<Props<'title' | 'rows' | 'columns'>> = ({ props }) => {
  const columns = columnsOf(props.columns);
  const rows = list(props.rows).slice(0, 100) as Record<string, unknown>[];
  return (
    <Tile title={String(props.title ?? '')}>
      {rows.length && columns.length ? (
        <Grid headers={columns.map((c) => ({ label: c.label }))}>
          {rows.map((row, i) => (
            <Tr key={typeof row.id === 'string' ? row.id : i}>
              {columns.map((c, at) => (
                <Td key={c.key} first={at === 0}>
                  {formatValue(row[c.key], c.format, c.currency)}
                </Td>
              ))}
            </Tr>
          ))}
        </Grid>
      ) : (
        <p className="text-sm text-muted-foreground">No records.</p>
      )}
    </Tile>
  );
};

export const dashboardLibrary = createLibrary({
  root: 'Dashboard',
  // Each renderer reads its props loosely; the shared zod schemas type them.
  components: dashboardComponents(
    defineComponent as (config: { component: ComponentRenderer<never> }) => DefinedComponent,
    { Dashboard, Row, Metric, BarChart, Table, TableColumn } as Record<
      string,
      ComponentRenderer<never>
    > as never,
  ),
});
