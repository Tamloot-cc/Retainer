import type { RoutineProblem, RoutineRunView, RoutineVersionView } from '@retainer/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  Loading,
  Muted,
  Notice,
  Row,
  Stack,
} from '../../ui/index.js';
import { errorText, failureText, routinesKey, runFinished, runStatus } from './model.js';
import { Calls, RecordName } from './run.js';

/**
 * A dry run of one version (routines spec §5.2, item 5): the code runs on a
 * few recent records, its writes and tool calls are reported, not made. It
 * is how an admin sees a version fail before approving it.
 */
export function DryRunDialog({
  version,
  onClose,
}: {
  version: RoutineVersionView;
  onClose: () => void;
}) {
  const { session } = useWorkspace();
  const start = useMutation({
    mutationFn: () => api.previewRoutine({ manifest: version.manifest, code: version.code }),
  });
  const previewId = start.data?.previewId ?? null;
  const preview = useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'preview', previewId],
    queryFn: ({ signal }) => api.routinePreview(previewId as string, signal),
    enabled: !!previewId,
    refetchInterval: (query) => (query.state.data?.done ? false : 2000),
  });
  const started = start.isPending || !!start.data;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Dry run of version ${version.number}`}
    >
      {!started ? (
        <Stack>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>It runs the code on up to five recent records.</li>
            <li>Its writes and tool calls are reported, not made. Nothing changes.</li>
            <li>
              It asks the model for real, if the routine uses one. Those calls count toward the
              workspace’s daily model calls.
            </li>
          </ul>
          {start.error ? <Notice error>{errorText(start.error, 'start a dry run')}</Notice> : null}
          <Row>
            <Button variant="primary" onClick={() => start.mutate()}>
              Start the dry run
            </Button>
            <Button onClick={onClose}>Cancel</Button>
          </Row>
        </Stack>
      ) : !start.data ? (
        <Loading>Starting the dry run…</Loading>
      ) : !start.data.valid ? (
        <Stack>
          <Notice error>The code does not pass Retainer’s checks, so it cannot run.</Notice>
          <Problems problems={start.data.problems} />
          <Row>
            <Button onClick={onClose}>Close</Button>
          </Row>
        </Stack>
      ) : (
        <Stack>
          {start.data.matched !== undefined ? <Matched count={start.data.matched} /> : null}
          {!previewId ? (
            <Empty quiet title="No recent records to run it on, so there is nothing to show." />
          ) : preview.error ? (
            <Notice error>{errorText(preview.error, 'see a dry run')}</Notice>
          ) : !preview.data ? (
            <Loading>Waiting for the dry run…</Loading>
          ) : (
            <DryRunList runs={preview.data.runs} done={preview.data.done} />
          )}
          <Row>
            <Button onClick={onClose}>Close</Button>
          </Row>
        </Stack>
      )}
    </Dialog>
  );
}

/** How many recent changes or records it would have started on. */
function Matched({ count }: { count: number }) {
  return (
    <Muted small>
      {count === 1 ? '1 recent change or record' : `${count} recent changes or records`} would start
      it, before its condition is checked. The runs below show which ones it acts on.
    </Muted>
  );
}

export function Problems({ problems }: { problems: RoutineProblem[] }) {
  return (
    <ul aria-label="Problems" className="flex list-disc flex-col gap-1 pl-5 text-sm">
      {problems.map((problem) => (
        <li key={`${problem.part}:${problem.at ?? ''}:${problem.code}`}>
          {problem.at ? `${problem.at}: ` : ''}
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

/** A preview's stored runs, as the dialog and a chat's draft card show them. */
export function DryRunList({ runs, done }: { runs: RoutineRunView[]; done: boolean }) {
  return (
    <Stack>
      {runs.map((run) => (
        <DryRun key={run.id} run={run} />
      ))}
      {done ? null : <Loading>Still running…</Loading>}
    </Stack>
  );
}

function DryRun({ run }: { run: RoutineRunView }) {
  const { label, tone } = runStatus(run.status);
  const finished = runFinished(run.status);
  const failure = failureText(run);
  return (
    <section
      aria-label={`Dry run on ${run.recordId ?? 'no record'}`}
      className="flex flex-col gap-2"
    >
      <Row>
        <Badge tone={tone}>{label}</Badge>
        {run.recordId ? (
          <span className="text-sm">
            <RecordName id={run.recordId} />
          </span>
        ) : (
          <Muted small>Without a record</Muted>
        )}
      </Row>
      {failure ? <Notice error>{failure}</Notice> : null}
      {run.status === 'skipped' ? (
        <Muted small>Its condition did not match this record, so the code did not run.</Muted>
      ) : run.calls.length ? (
        <Calls calls={run.calls} finished={finished} label="Dry run calls" />
      ) : finished ? (
        <Muted small>It made no calls.</Muted>
      ) : null}
    </section>
  );
}
