import type { ReactNode } from 'react';

export function DashboardTable({
  title,
  columns,
  rows,
}: {
  title: string;
  columns: string[];
  rows: { id: string; cells: ReactNode[] }[];
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No data</p>;
  const headings = columns.map((label, index) => ({ label, key: `${label}-${index}` }));
  return (
    <section
      aria-label={title}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard scrolling for wide tables.
      tabIndex={0}
      className="max-w-full overflow-x-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring"
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{title}</caption>
        <thead className="bg-muted text-muted-foreground">
          <tr>
            {headings.map(({ label, key }) => (
              <th
                key={key}
                scope="col"
                className="whitespace-nowrap px-3 py-2 text-start text-xs font-medium"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ id, cells }) => (
            <tr key={id}>
              {cells.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: each cell belongs to its column position.
                <td key={index} className="px-3 py-2 whitespace-nowrap tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
