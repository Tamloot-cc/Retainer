import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { RecordLink } from '../../ui/index.js';
import { objectLabel, QueryError, recordTitle } from '../state.js';
import { queryKey } from './model.js';
import { type ExtensionRun, runTriggerLabel } from './run-details.js';

export function RunSection({
  name,
  preview,
  icon: Icon,
  children,
}: {
  name: string;
  preview: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <details className="group/section min-w-0 overflow-hidden rounded-md border border-border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-sm font-medium">{name}</span>
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
          {preview}
        </span>
        <ChevronDown
          size={14}
          className="shrink-0 text-muted-foreground group-open/section:rotate-180"
          aria-hidden
        />
      </summary>
      <div className="border-t border-border px-3 py-3 text-sm">{children}</div>
    </details>
  );
}

const fieldGroups = [
  { status: 'applied', label: 'Filled', tone: 'text-emerald-700 dark:text-emerald-300' },
  {
    status: 'pending_review',
    label: 'Awaiting review',
    tone: 'text-amber-700 dark:text-amber-300',
  },
  { status: 'populated', label: 'Already populated', tone: 'text-muted-foreground' },
  { status: 'cleared', label: 'Previously cleared', tone: 'text-muted-foreground' },
] as const;

const seconds = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function duration(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${seconds.format(ms / 1000)} s`;
}

export function RunInspection({
  installationId,
  run,
  outcome,
  open,
}: {
  installationId: string;
  run: ExtensionRun;
  outcome: string | null;
  open: boolean;
}) {
  const { schema } = useWorkspace();
  const inspection = useQuery({
    queryKey: [
      ...queryKey,
      'runs',
      installationId,
      'inspection',
      run.id,
      run.attempt,
      run.updatedAt,
    ],
    queryFn: ({ signal }) => api.inspectExtensionRun(installationId, run.id, signal),
    enabled: open,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  if (!open) return null;
  if (inspection.error)
    return <QueryError error={inspection.error} retry={() => void inspection.refetch()} />;
  if (!inspection.data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading input and output…
      </p>
    );

  const { input, output, timing } = inspection.data;
  const groups = fieldGroups
    .map((group) => ({
      ...group,
      fields: output.fields.filter(({ status }) => status === group.status),
    }))
    .filter((group) => group.fields.length);
  const recordTrigger = input.trigger === 'recordButton' || input.trigger === 'change';
  const triggerLabel = runTriggerLabel(input.trigger);
  return (
    <div className="space-y-2">
      <RunSection
        name="Input"
        icon={ArrowDownToLine}
        preview={input.record ? recordTitle(input.record) : triggerLabel}
      >
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2">
          {recordTrigger ? (
            <>
              <dt className="text-xs text-muted-foreground">Record</dt>
              <dd className="[&_a]:underline [&_a]:underline-offset-2">
                {input.record ? (
                  <>
                    <RecordLink id={input.record.id} wrap>
                      {recordTitle(input.record)}
                    </RecordLink>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {objectLabel(schema, input.record.object)}
                    </span>
                  </>
                ) : (
                  'Record unavailable'
                )}
              </dd>
            </>
          ) : null}
          <dt className="text-xs text-muted-foreground">Trigger</dt>
          <dd>{input.operation === 'create' ? 'Record created' : triggerLabel}</dd>
          {input.changedFields.length ? (
            <>
              <dt className="text-xs text-muted-foreground">
                {input.operation === 'create' ? 'Fields set' : 'Changed fields'}
              </dt>
              <dd className="[overflow-wrap:anywhere]">{input.changedFields.join(', ')}</dd>
            </>
          ) : null}
        </dl>
      </RunSection>
      <RunSection
        name="Output"
        icon={ArrowUpFromLine}
        preview={
          groups
            .map((group) => `${group.fields.length} ${group.label.toLowerCase()}`)
            .join(' · ') || (outcome ? 'Run outcome' : 'No field results')
        }
      >
        {!groups.length && outcome ? <p className="mb-1">{outcome}</p> : null}
        {groups.length ? (
          <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
            {groups.map((group) => (
              <div key={group.status} className="contents">
                <dt className={`text-xs font-medium sm:mt-0.5 ${group.tone}`}>{group.label}</dt>
                <dd className="[overflow-wrap:anywhere]">
                  {group.fields.map((field) => field.label).join(', ')}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">No field-level output was recorded.</p>
        )}
      </RunSection>
      {timing.queueMs !== null || timing.latestAttemptMs !== null ? (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
          {timing.queueMs !== null ? (
            <div className="flex gap-1.5">
              <dt>Queue wait</dt>
              <dd className="font-medium text-foreground tabular-nums">
                {duration(timing.queueMs)}
              </dd>
            </div>
          ) : null}
          {timing.latestAttemptMs !== null ? (
            <div className="flex gap-1.5">
              <dt>Last attempt</dt>
              <dd className="font-medium text-foreground tabular-nums">
                {duration(timing.latestAttemptMs)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
