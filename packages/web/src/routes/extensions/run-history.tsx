import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, isToday, isYesterday } from 'date-fns';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Clock,
  History,
  Minus,
  RotateCcw,
} from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client.js';
import { Badge, Button, CopyButton, Empty, Loading, Notice } from '../../ui/index.js';
import { QueryError } from '../state.js';
import { type Installation, queryKey, stateLabel } from './model.js';
import { type ExtensionRun, runDetails } from './run-details.js';

const filters = [
  { value: 'all', label: 'All runs', empty: 'No runs yet' },
  { value: 'active', label: 'In progress', empty: 'No runs in progress' },
  { value: 'succeeded', label: 'Succeeded', empty: 'No successful runs' },
  { value: 'failed', label: 'Failed', empty: 'No failed runs' },
  { value: 'cancelled', label: 'Cancelled', empty: 'No cancelled runs' },
] as const;
type Filter = (typeof filters)[number];

const statusStyles = {
  succeeded: {
    icon: Check,
    tone: 'success',
    color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  failed: { icon: CircleAlert, tone: 'error', color: 'bg-destructive/10 text-destructive' },
  active: {
    icon: Clock,
    tone: 'pending',
    color: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  other: { icon: Minus, tone: 'neutral', color: 'bg-muted text-muted-foreground' },
} as const;

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
});

function RunRow({
  run,
  registrationId,
  canRetry,
  retrying,
  onRetry,
}: {
  run: ExtensionRun;
  registrationId: string;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { title, trigger, outcome } = runDetails(registrationId, run);
  const status =
    run.status === 'succeeded' || run.status === 'failed'
      ? statusStyles[run.status]
      : ['queued', 'running', 'waiting'].includes(run.status)
        ? statusStyles.active
        : statusStyles.other;
  const Icon = status.icon;
  const created = new Date(run.createdAt);
  return (
    <li>
      <details className="group open:bg-muted/25">
        <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-3 py-3 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:grid-cols-[auto_minmax(0,1fr)_6.5rem_5.5rem_auto] sm:items-center sm:gap-x-4 sm:px-4 [&::-webkit-details-marker]:hidden">
          <span
            className={`inline-flex size-8 items-center justify-center rounded-lg ${status.color}`}
          >
            <Icon size={16} aria-hidden />
          </span>
          <span className="min-w-0 space-y-0.5">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-semibold [overflow-wrap:anywhere]">{title}</span>
              {trigger ? <span className="text-xs text-muted-foreground">{trigger}</span> : null}
            </span>
            {outcome ? (
              <span className="block text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {outcome}
              </span>
            ) : null}
          </span>
          <span className="col-start-2 row-start-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:contents">
            <span>
              <Badge tone={status.tone}>{stateLabel(run.status)}</Badge>
            </span>
            <time
              dateTime={run.createdAt}
              className="text-xs text-muted-foreground tabular-nums sm:text-right"
            >
              {timeFormatter.format(created)}
            </time>
          </span>
          <ChevronDown
            aria-hidden
            size={16}
            className="col-start-3 row-start-1 mt-2 text-muted-foreground group-open:rotate-180 sm:col-start-5 sm:mt-0"
          />
        </summary>
        <div className="border-t border-border/70 px-4 py-3 sm:pl-16">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm sm:gap-x-5">
            <dt className="mt-0.5 text-xs text-muted-foreground">Attempts</dt>
            <dd className="tabular-nums">{run.attempt}</dd>
            <dt className="mt-0.5 text-xs text-muted-foreground">Queued at</dt>
            <dd>
              <time dateTime={run.createdAt}>{timestampFormatter.format(created)}</time>
            </dd>
            <dt className="mt-0.5 text-xs text-muted-foreground">Last updated</dt>
            <dd>
              <time dateTime={run.updatedAt}>
                {timestampFormatter.format(new Date(run.updatedAt))}
              </time>
            </dd>
            {run.code ? (
              <>
                <dt className="mt-0.5 text-xs text-muted-foreground">Result code</dt>
                <dd>
                  <code className="text-xs [overflow-wrap:anywhere]">{run.code}</code>
                </dd>
              </>
            ) : null}
            <dt className="mt-0.5 text-xs text-muted-foreground">Run ID</dt>
            <dd className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 sm:flex">
              <code className="text-xs [overflow-wrap:anywhere]">{run.id}</code>
              <CopyButton value={run.id} label="Copy run ID" iconOnly />
            </dd>
          </dl>
          {canRetry ? (
            <Button className="mt-3" size="small" disabled={retrying} onClick={onRetry}>
              <RotateCcw size={13} aria-hidden />
              Retry run
            </Button>
          ) : null}
        </div>
      </details>
    </li>
  );
}

export function RunHistory({
  installation,
  connection,
  admin,
  onAll,
}: {
  installation: Installation;
  connection?: string;
  admin: boolean;
  onAll: () => void;
}) {
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>(filters[0]);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const runs = useQuery({
    queryKey: [...queryKey, 'runs', installation.id, connection, filter.value, cursor],
    queryFn: ({ signal }) =>
      api.extensionRuns(installation.id, {
        signal,
        limit: 25,
        ...(connection ? { connection } : {}),
        ...(cursor ? { cursor } : {}),
        ...(filter.value === 'all' ? {} : { status: filter.value }),
      }),
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: (runId: string) =>
      api.retryExtensionRun(installation.id, runId, crypto.randomUUID()),
    onSuccess: () => client.invalidateQueries({ queryKey: [...queryKey, 'runs', installation.id] }),
  });
  const days = new Map<string, { date: Date; runs: ExtensionRun[] }>();
  for (const run of runs.data?.runs ?? []) {
    const date = new Date(run.createdAt);
    const day = format(date, 'yyyy-MM-dd');
    const group = days.get(day);
    if (group) group.runs.push(run);
    else days.set(day, { date, runs: [run] });
  }
  const nextCursor = runs.data?.nextCursor;
  function selectFilter(next: Filter) {
    if (next === filter) return;
    setFilter(next);
    setCursors([]);
  }
  return (
    <section aria-labelledby="extension-run-history" className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <h2 id="extension-run-history" className="flex items-center gap-2 text-base font-semibold">
          <History size={17} className="text-muted-foreground" aria-hidden />
          Run history
        </h2>
        <fieldset className="flex min-w-0 flex-wrap gap-0.5 rounded-lg bg-muted/65 p-1 sm:gap-1">
          <legend className="sr-only">Filter by run status</legend>
          {filters.map((option) => (
            <Button
              key={option.value}
              variant="ghost"
              size="small"
              aria-pressed={filter.value === option.value}
              className="px-1.5 aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-xs sm:px-2"
              onClick={() => selectFilter(option)}
            >
              {option.label}
            </Button>
          ))}
        </fieldset>
      </header>
      {connection ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">
          Viewing one connection
          <Button variant="ghost" size="small" onClick={onAll}>
            Show all connections
          </Button>
        </div>
      ) : null}
      {retry.error ? (
        <Notice error onDismiss={retry.reset}>
          {retry.error.message}
        </Notice>
      ) : null}
      {retry.isSuccess ? <Notice onDismiss={retry.reset}>Run queued for retry.</Notice> : null}
      {runs.error ? <QueryError error={runs.error} retry={() => void runs.refetch()} /> : null}
      {runs.isPending ? <Loading>Loading runs…</Loading> : null}
      {runs.data && !days.size ? (
        <div className="rounded-lg border border-border bg-card px-4 py-6">
          <Empty
            quiet
            title={cursor ? 'No runs on this page' : filter.empty}
            description={
              filter.value === 'all' && !cursor
                ? 'Runs appear here as the extension does work.'
                : undefined
            }
          />
        </div>
      ) : null}
      {Array.from(days, ([day, group]) => (
        <section key={day} aria-labelledby={`runs-${day}`} className="space-y-2">
          <h3 id={`runs-${day}`} className="px-1 text-xs font-semibold text-muted-foreground">
            <time dateTime={day}>
              {isToday(group.date)
                ? 'Today'
                : isYesterday(group.date)
                  ? 'Yesterday'
                  : dateFormatter.format(group.date)}
            </time>
          </h3>
          <ul
            aria-label="Extension runs"
            className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card"
          >
            {group.runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                registrationId={installation.registrationId}
                canRetry={admin && run.status === 'failed'}
                retrying={retry.isPending}
                onRetry={() => retry.mutate(run.id)}
              />
            ))}
          </ul>
        </section>
      ))}
      {cursor || nextCursor ? (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <Button
            variant="ghost"
            size="small"
            disabled={!cursor}
            onClick={() => setCursors((pages) => pages.slice(0, -1))}
          >
            <ArrowLeft size={14} aria-hidden />
            Newer runs
          </Button>
          <Button
            variant="ghost"
            size="small"
            disabled={!nextCursor}
            onClick={() => {
              if (nextCursor) setCursors((pages) => [...pages, nextCursor]);
            }}
          >
            Older runs
            <ArrowRight size={14} aria-hidden />
          </Button>
        </div>
      ) : null}
    </section>
  );
}
