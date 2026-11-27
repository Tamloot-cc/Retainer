import type { DashboardFormat } from '@retainer/shared';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer } from './chart-container.js';
import { formatValue } from './format.js';

const chartColors = [
  'var(--primary)',
  'var(--category-teal-fg)',
  'var(--category-coral-fg)',
  'var(--category-amber-fg)',
  'var(--category-sage-fg)',
  'var(--category-olive-fg)',
  'var(--muted-foreground)',
];
export type ChartDatum = { label: string; values: unknown[]; amounts: (number | null)[] };
export type ChartKind = 'bar' | 'line' | 'stacked' | 'pie';

const tooltipStyle = {
  backgroundColor: 'var(--card)',
  borderColor: 'var(--border)',
  color: 'var(--foreground)',
};
const abbreviate = (value: string) => (value.length > 24 ? `${value.slice(0, 23)}…` : value);

export default function DashboardChart({
  kind,
  names,
  rows,
  format,
  currency,
}: {
  kind: ChartKind;
  names: string[];
  rows: ChartDatum[];
  format?: DashboardFormat;
  currency?: string;
}) {
  const data = rows.map(({ label, amounts }) => ({
    label,
    ...Object.fromEntries(amounts.map((value, index) => [`v${index}`, value])),
  }));
  const measures = names.map((name, index) => ({
    name,
    dataKey: `v${index}`,
    color: chartColors[index % chartColors.length],
  }));
  const slices = rows.map(({ label }, index) => ({
    id: `${label}-${index}`,
    color: chartColors[index % chartColors.length],
  }));
  const horizontal =
    (kind === 'bar' || kind === 'stacked') && rows.some(({ label }) => label.length > 14);
  const formatNumber = (amount: number) =>
    formatValue(currency ? { amount, currency } : amount, format);
  const tooltip = (
    <Tooltip
      contentStyle={tooltipStyle}
      itemStyle={{ color: 'var(--foreground)' }}
      labelStyle={{ color: 'var(--foreground)' }}
      formatter={(value) => (typeof value === 'number' ? formatNumber(value) : '—')}
    />
  );
  const axis = { axisLine: false, tickLine: false };
  const minHeight = horizontal ? Math.max(224, rows.length * 27 + 32) : 224;
  return (
    <ChartContainer className="aspect-auto" style={{ height: minHeight }}>
      {kind === 'pie' ? (
        <PieChart accessibilityLayer>
          {tooltip}
          <Legend />
          <Pie
            data={data}
            dataKey="v0"
            nameKey="label"
            innerRadius="43%"
            outerRadius="77%"
            isAnimationActive={false}
          >
            {slices.map(({ id, color }) => (
              <Cell key={id} fill={color} stroke="var(--card)" />
            ))}
          </Pie>
        </PieChart>
      ) : kind === 'line' ? (
        <LineChart accessibilityLayer data={data} margin={{ left: 8, right: 16, top: 10 }}>
          <CartesianGrid vertical={false} />
          <XAxis {...axis} dataKey="label" minTickGap={24} tickFormatter={abbreviate} />
          <YAxis {...axis} width={82} tickFormatter={formatNumber} />
          {tooltip}
          {names.length > 1 && <Legend />}
          {measures.map(({ name, dataKey, color }) => (
            <Line
              key={dataKey}
              name={name}
              dataKey={dataKey}
              type="monotone"
              stroke={color}
              strokeWidth={2}
              dot={rows.length <= 20}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      ) : (
        <BarChart
          accessibilityLayer
          data={data}
          layout={horizontal ? 'vertical' : 'horizontal'}
          stackOffset="sign"
          margin={{ left: 4, right: 12, top: 10 }}
        >
          <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
          {horizontal ? (
            <>
              <XAxis {...axis} type="number" tickFormatter={formatNumber} />
              <YAxis
                {...axis}
                type="category"
                dataKey="label"
                width={108}
                tickFormatter={abbreviate}
              />
            </>
          ) : (
            <>
              <XAxis {...axis} dataKey="label" minTickGap={20} tickFormatter={abbreviate} />
              <YAxis {...axis} width={82} tickFormatter={formatNumber} />
            </>
          )}
          {tooltip}
          {names.length > 1 && <Legend />}
          {measures.map(({ name, dataKey, color }) => (
            <Bar
              key={dataKey}
              name={name}
              dataKey={dataKey}
              maxBarSize={48}
              stackId={kind === 'stacked' ? 'value' : undefined}
              fill={color}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      )}
    </ChartContainer>
  );
}
