// Adapted from shadcn/ui's ChartContainer (MIT, see THIRD_PARTY.md).
import type { ComponentProps } from 'react';
import { ResponsiveContainer } from 'recharts';
import { cn } from '../../ui/core.js';

/** Uses Retainer's theme variables directly, so chart data never enters CSS. */
export function ChartContainer({
  children,
  className,
  ...props
}: ComponentProps<'div'> & {
  children: ComponentProps<typeof ResponsiveContainer>['children'];
}) {
  return (
    <div
      {...props}
      data-slot="chart"
      className={cn(
        'flex w-full min-w-0 justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted',
        className,
      )}
    >
      <ResponsiveContainer initialDimension={{ width: 320, height: 220 }}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}
