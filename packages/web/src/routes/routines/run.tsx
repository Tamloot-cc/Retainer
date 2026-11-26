import type { RoutineRunCall } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { api, useWorkspace } from '../../api/client.js';
import {
  Badge,
  CodeBlock,
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
import { AgentTrace } from '../agent/trace.js';
import { QueryError, recordTitle, useRecordLabel } from '../state.js';
import {
  callError,
  callStateText,
  FIELD_STATUS,
  failureText,
  madeChanges,
  operationText,
  pendingReviews,
  RUN_STATUS_TEXT,
  routineObject,
  routinesKey,
  runFinished,
  runOutcome,
  triggerText,
  useRoutineCapabilities,
  writtenFields,
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
  const { label, tone } = runOutcome(r);
  const test = r.mode === 'test';
  const waiting = pendingReviews(r);
  const output = r.output ?? {};
  const logs = Array.isArray(output.logs) ? (output.logs as unknown[]).map(String) : [];
  const agentCalls = r.calls
    .filter((call) => call.operation === 'ai.agent')
    .map((call) => call.position);
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
      {failureText(r) ? <Notice error>{failureText(r)}</Notice> : null}
      {RUN_STATUS_TEXT[r.status] ? <Notice>{RUN_STATUS_TEXT[r.status]}</Notice> : null}
      {r.needsAttention ? (
        <Notice error>
          Needs attention: data this run read changed while it waited for the agent, so it stopped
          and dropped the agent's answer. Nothing starts it again on its own.
        </Notice>
      ) : null}
      {r.agentAnswerUnused ? (
        <Notice>
          Agent answer unused: when the run continued, it finished before it reached the agent's
          answer.
        </Notice>
      ) : null}
      {r.status === 'succeeded' && !madeChanges(r) ? (
        <Notice>
          It finished without changing anything. What it returned, below, may say why.
        </Notice>
      ) : null}
      {waiting ? (
        <Notice warning>
          {waiting === 1 ? '1 value it wrote waits' : `${waiting} values it wrote wait`} for a
          person’s review. A person or a sync set {waiting === 1 ? 'that field' : 'those fields'},
          so the routine’s value does not replace it until someone approves it.
        </Notice>
      ) : null}
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
          <Calls calls={r.calls} finished={runFinished(r.status)} />
        ) : (
          <Empty quiet title={runFinished(r.status) ? 'It made no calls.' : 'No calls yet.'} />
        )}
        <Muted small>
          Results are kept for 7 days after a run ends, so you can check what it did.
        </Muted>
      </Section>
      {agentCalls.length ? (
        <AgentTrace routineId={id} runId={runId} positions={agentCalls} />
      ) : null}
      {output.result !== undefined || logs.length ? (
        <Section title="What it returned">
          {output.result === undefined || output.result === null ? (
            <Muted>Nothing.</Muted>
          ) : typeof output.result === 'string' ? (
            <p className="text-sm">{output.result}</p>
          ) : (
            <JsonBlock value={output.result} label="What it returned" />
          )}
          {logs.length ? <CodeBlock summary="Show its log" code={logs.join('\n')} /> : null}
        </Section>
      ) : null}
    </Page>
  );
}

/** Each call a run made, in order. */
export function Calls({
  calls,
  finished,
  label = 'Calls',
}: {
  calls: RoutineRunCall[];
  finished: boolean;
  label?: string;
}) {
  return (
    <ol
      aria-label={label}
      className="flex flex-col divide-y divide-border rounded-lg border border-border"
    >
      {calls.map((call) => (
        <Call key={call.position} call={call} finished={finished} />
      ))}
    </ol>
  );
}

function Call({ call, finished }: { call: RoutineRunCall; finished: boolean }) {
  const error = callError(call);
  const fields = writtenFields(call);
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5 text-sm">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Muted small>{call.position}.</Muted>
        <span className="font-medium">
          {call.recordId && fields ? (
            <WriteTitle call={call} recordId={call.recordId} />
          ) : (
            operationText(call.operation)
          )}
        </span>
        <Badge
          tone={call.state === 'failed' ? 'error' : call.state === 'done' ? 'success' : 'pending'}
        >
          {callStateText(call, finished)}
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
          The replay stopped here because this call changed. The original effect is shown above.
        </Muted>
      ) : null}
      {error ? (
        <span>
          {call.code === 'model_failed' || call.code === 'model_refused'
            ? 'The model provider said: '
            : 'The error: '}
          {error}
        </span>
      ) : fields ? (
        <WrittenFields call={call} fields={fields} />
      ) : call.result !== undefined ? (
        <JsonBlock value={call.result} label={`Result of call ${call.position}`} />
      ) : null}
    </li>
  );
}

/** The object a write's record belongs to, and its routine description. */
function useWrittenObject(recordId: string | null) {
  const record = useRecordLabel(recordId ?? '', !!recordId);
  const caps = useRoutineCapabilities();
  return routineObject(caps.data, record.data?.object);
}

/** "Create a task", "Update a company": the write, with the kind of record. */
function WriteTitle({ call, recordId }: { call: RoutineRunCall; recordId: string }) {
  const object = useWrittenObject(recordId);
  const verb = call.operation === 'record.create' ? 'Create' : 'Update';
  return <>{object ? `${verb} a ${object.label.toLowerCase()}` : operationText(call.operation)}</>;
}

/** Each field a write set and what happened to it, by the field's label. */
function WrittenFields({ call, fields }: { call: RoutineRunCall; fields: [string, string][] }) {
  const object = useWrittenObject(call.recordId);
  if (!fields.length) return <Muted small>It set no fields.</Muted>;
  return (
    <ul aria-label={`Fields of call ${call.position}`} className="flex flex-col gap-0.5">
      {fields.map(([key, status]) => (
        <li key={key}>
          <span className="text-muted-foreground">
            {object?.fields.find((f) => f.key === key)?.label ?? key}:
          </span>{' '}
          {status === 'pending_review' ? (
            <Badge tone="pending">{FIELD_STATUS[status]}</Badge>
          ) : (
            (FIELD_STATUS[status] ?? status.replaceAll('_', ' '))
          )}
        </li>
      ))}
    </ul>
  );
}
