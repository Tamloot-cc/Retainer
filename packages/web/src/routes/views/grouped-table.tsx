import {
  type AggregateGroup,
  type AggregateInput,
  displayViewGroups,
  type ObjectView,
  type QueryInput,
  type RecordPage,
  type SavedView,
} from '@retainer/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { Button, GridFooter, Inset, Notice } from '../../ui/index.js';
import { byCursor, QueryError } from '../state.js';
import { formatAggregate } from './list-state.js';

export function GroupedTable({
  object,
  view,
  input,
  render,
}: {
  object: ObjectView;
  view: SavedView;
  input: QueryInput;
  render: (pages: RecordPage[]) => ReactNode;
}) {
  const { session } = useWorkspace();
  const name = object.nameSingular;
  const groupField = object.fields.find((field) => field.name === view.groupBy);
  const groupTotals = view.groupAggregate ? [view.groupAggregate] : [];
  const columnTotals = Object.entries(view.columns?.aggregates ?? {}).map(([field, op]) => ({
    field,
    op,
  }));
  const grouping: AggregateInput = {
    groupBy: view.groupBy ?? undefined,
    granularity: view.granularity ?? undefined,
    search: input.search,
    filter: input.filter,
    aggregates: [...groupTotals, ...columnTotals],
    viewGroups: { hidden: view.hiddenGroups },
  };
  const totals = useQuery({
    queryKey: [session.workspace.id, 'aggregate', name, grouping],
    queryFn: ({ signal }) => api.aggregate(name, grouping, signal),
  });
  if (totals.error)
    return (
      <Inset>
        <QueryError error={totals.error} retry={() => void totals.refetch()} />
      </Inset>
    );
  if (!totals.data)
    return (
      <Inset>
        <Notice>Loading groups…</Notice>
      </Inset>
    );
  const groups = displayViewGroups(totals.data.groups ?? [], view, groupField);
  const format = (measure: NonNullable<typeof totals.data>['values'][number] | undefined) => {
    const field = object.fields.find((item) => item.name === measure?.field);
    return measure && field ? formatAggregate(field, measure) : undefined;
  };
  return (
    <>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {groups.map((group) => (
          <Section
            key={
              group.overflow ? 'overflow' : group.value === null ? 'empty' : `group:${group.value}`
            }
            identity={JSON.stringify([
              session.workspace.id,
              view.object,
              view.id,
              view.groupBy,
              view.granularity,
              group.overflow,
              group.value,
            ])}
            name={name}
            group={group}
            total={groupTotals.length ? format(group.values[0]) : undefined}
            input={input}
            render={render}
          />
        ))}
        {!groups.length && <Notice>No groups to display.</Notice>}
      </div>
      <GridFooter>
        {totals.data.total.toLocaleString()} records
        {totals.data.values.slice(groupTotals.length).map((measure) => {
          const value = format(measure);
          const field = object.fields.find((item) => item.name === measure.field);
          return (
            value && (
              <span key={measure.field}>
                {' '}
                · {field?.label} {value}
              </span>
            )
          );
        })}
      </GridFooter>
    </>
  );
}

function Section({
  identity,
  name,
  group,
  total,
  input,
  render,
}: {
  identity: string;
  name: string;
  group: AggregateGroup;
  total: string | undefined;
  input: QueryInput;
  render: (pages: RecordPage[]) => ReactNode;
}) {
  const { session } = useWorkspace();
  const element = useRef<HTMLDetailsElement>(null);
  const [seen, setSeen] = useState(false);
  const key = `retainer:view-group:${identity}`;
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem(key) !== 'closed';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    if (seen || !element.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setSeen(true);
    });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [seen]);
  const section: QueryInput = { ...input, cursor: undefined, groupMatch: group.match, limit: 25 };
  const query = useInfiniteQuery({
    ...byCursor,
    queryKey: [session.workspace.id, 'records', name, 'group', section],
    queryFn: ({ pageParam, signal }) =>
      api.queryRecords(name, { ...section, cursor: pageParam }, signal),
    enabled: open && seen && !!group.match && group.total > 0,
  });
  return (
    <details
      ref={element}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        try {
          sessionStorage.setItem(key, next ? 'open' : 'closed');
        } catch {
          /* Session storage is optional. */
        }
      }}
      className="min-w-0 rounded-lg border border-border"
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        {group.label}{' '}
        <span className="font-normal text-muted-foreground">
          · {group.total.toLocaleString()}
          {total ? ` · ${total}` : ''}
        </span>
      </summary>
      {open &&
        group.total > 0 &&
        (query.error ? (
          <QueryError error={query.error} retry={() => void query.refetch()} />
        ) : query.data ? (
          render(query.data.pages)
        ) : (
          <p className="px-3 py-2 text-sm text-muted-foreground">Loading records…</p>
        ))}
      {open && query.hasNextPage && (
        <Button
          size="small"
          variant="ghost"
          className="m-2"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
        </Button>
      )}
    </details>
  );
}
