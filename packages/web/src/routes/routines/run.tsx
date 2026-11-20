import type { RoutineRunCall } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { api, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Empty,
  JsonBlock,
  Loading,
  Muted,
  Notice,
  Page,
  Property,
  PropertyList,
  RecordLink,
  Row,
  Section,
} from '../../ui/index.js';
import { QueryError, recordTitle, useRecordLabel } from '../state.js';
import {
  callStateText,
  operationText,
  RUN_STATUS_TEXT,
  routinesKey,
  runFinished,
  runStatus,
  triggerText,
} from './model.js';

/** A record's name, fetched only to label it; a record gone since says so. */
export function RecordName({ id }: { id: string }) {
  const record = useRecordLabel(id);
  if (record.error) return <>A record no longer available</>;
  return <>{record.data ? recordTitle(record.data) : 'Record'}</>;
}

/** `/routines/:id/runs/:run`: one run or test, and each call it made in order. */
export function RoutineRunPage() {
  const { id, run: runId } = useParams({ strict: false }) as { id: string; run: string };
  const { session } = useWorkspace();
  const run = useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'run', id, runId],
    queryFn: ({ signal }) => api.routineRun(id, runId, signal),
    refetchInterval: (query) =>
      query.state.data && runFinished(query.state.data.status) ? false : 2000,
  });
  const crumb = {
    eyebrow: 'Routine',
    eyebrowLink: { to: '/routines/$id', params: { id } },
  } as const;
  if (run.error)
    return (
      <Page {...crumb} title="Run">
        <QueryError error={run.error} retry={() => void run.refetch()} />
      </Page>
    );
  if (!run.data)
    return (
      <Page {...crumb} title="Run">
        <Loading>Loading run…</Loading>
      </Page>
    );
  const r = run.data;
  const { label, tone } = runStatus(r.status);
  const test = r.mode === 'test';
  return (
    <Page
      {...crumb}
      title={test ? 'Test run' : 'Run'}
      description={new Date(r.at).toLocaleString()}
    >
      <Row>
        <Badge tone={tone}>{label}</Badge>
        {test ? <Badge>Test</Badge> : null}
        {r.code ? <Muted>{r.code.replaceAll('_', ' ')}</Muted> : null}
      </Row>
      {RUN_STATUS_TEXT[r.status] ? <Notice>{RUN_STATUS_TEXT[r.status]}</Notice> : null}
      {test ? (
        <Muted>
          A test makes real writes. A tool that sends something is reported, not called, and the
          test stops there.
        </Muted>
      ) : null}
      <PropertyList>
        <Property label="Started by">
          {triggerText(r.trigger)}
          {r.initiatedBy ? ` · ${r.initiatedBy.name || r.initiatedBy.id}` : ''}
        </Property>
        <Property label="Record">
          {r.recordId ? (
            <RecordLink id={r.recordId}>
              <RecordName id={r.recordId} />
            </RecordLink>
          ) : (
            <Muted>None</Muted>
          )}
        </Property>
        <Property label="Started">
          {r.startedAt ? new Date(r.startedAt).toLocaleString() : <Muted>Not yet</Muted>}
        </Property>
        <Property label="Finished">
          {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : <Muted>Not yet</Muted>}
        </Property>
        <Property label="Attempt">{r.attempt}</Property>
        <Property label="Model calls">{r.modelCalls}</Property>
      </PropertyList>
      <Section title="What it did, in order">
        {r.calls.length ? (
          <ol
            aria-label="Calls"
            className="flex flex-col divide-y divide-border rounded-lg border border-border"
          >
            {r.calls.map((call) => (
              <Call key={call.position} call={call} />
            ))}
          </ol>
        ) : (
          <Empty quiet title={runFinished(r.status) ? 'It made no calls.' : 'No calls yet.'} />
        )}
        <Muted small>
          Results are kept for 7 days after a run ends, so you can check what it did.
        </Muted>
      </Section>
    </Page>
  );
}

function Call({ call }: { call: RoutineRunCall }) {
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5 text-sm">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Muted small>{call.position}.</Muted>
        <span className="font-medium">{operationText(call.operation)}</span>
        <Badge
          tone={call.state === 'failed' ? 'error' : call.state === 'done' ? 'success' : 'pending'}
        >
          {callStateText(call.state)}
        </Badge>
        {call.code ? <Muted small>{call.code.replaceAll('_', ' ')}</Muted> : null}
        {call.recordId ? (
          <RecordLink id={call.recordId}>
            <RecordName id={call.recordId} />
          </RecordLink>
        ) : null}
      </span>
      {call.differs ? (
        <Muted small>
          A retry asked for something different here. The first answer was kept and nothing was done
          twice.
        </Muted>
      ) : null}
      {call.result !== undefined ? (
        <JsonBlock value={call.result} label={`Result of call ${call.position}`} />
      ) : null}
    </li>
  );
}
