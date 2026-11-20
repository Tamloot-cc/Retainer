import type { RoutineDetail, RoutineRunView, RoutineVersionView } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Ellipsis, Workflow } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import {
  Badge,
  Button,
  Dialog,
  Empty,
  FormField,
  IdentityTag,
  Input,
  Loading,
  Menu,
  MenuAction,
  MenuSeparator,
  Muted,
  Notice,
  Page,
  Panel,
  Row,
  Section,
  Stack,
} from '../../ui/index.js';
import { QueryError } from '../state.js';
import { DescribeRoutine } from './describe.js';
import {
  errorText,
  needsApproval,
  pausedText,
  routineStatus,
  routinesKey,
  runStatus,
  triggerText,
} from './model.js';
import { RecordName } from './run.js';
import { VersionDetails } from './version.js';

const CRUMB = { eyebrow: 'Routines', eyebrowLink: { to: '/routines' } } as const;

/** `/routines/:id`: one routine, what waits for review, and its recent runs. */
export function RoutinePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { session } = useWorkspace();
  const routine = useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'detail', id],
    queryFn: ({ signal }) => api.routine(id, signal),
    // Runs in progress change on their own; follow them until they settle.
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => ['queued', 'running'].includes(run.status))
        ? 3000
        : false,
  });
  if (routine.error)
    return (
      <Page {...CRUMB} title="Routine">
        <QueryError error={routine.error} retry={() => void routine.refetch()} />
        <Link to="/routines" className="text-sm underline">
          All routines
        </Link>
      </Page>
    );
  if (!routine.data)
    return (
      <Page {...CRUMB} title="Routine">
        <Loading>Loading routine…</Loading>
      </Page>
    );
  return <Routine routine={routine.data} />;
}

function Routine({ routine }: { routine: RoutineDetail }) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const admin = canMutate(session, 'admin');
  const canWrite = canMutate(session);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [testing, setTesting] = useState<RoutineVersionView | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: routinesKey(session.workspace.id) });
  const state = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'archive') => api.setRoutineState(routine.id, action),
    onSuccess: async (_, action) => {
      setConfirmArchive(false);
      setOutcome(
        action === 'pause'
          ? 'Paused. It does nothing until it is resumed.'
          : action === 'resume'
            ? 'Resumed. It acts on what happens from now on, not on what happened while it was paused.'
            : 'Archived. It will not run again.',
      );
      await refresh();
    },
  });
  const decide = useMutation({
    mutationFn: ({
      version,
      decision,
    }: {
      version: RoutineVersionView;
      decision: 'approve' | 'reject';
    }) => api.decideRoutineVersion(routine.id, version.id, decision),
    onSuccess: async (result, { version, decision }) => {
      const discarded = result.discardedRuns ?? 0;
      setOutcome(
        decision === 'reject'
          ? `Rejected version ${version.number}.`
          : `Approved version ${version.number}. It acts on what happens from now on, not on earlier changes.${
              discarded
                ? ` ${discarded === 1 ? '1 run' : `${discarded} runs`} of the previous version that had not started ${discarded === 1 ? 'was' : 'were'} discarded.`
                : ''
            }`,
      );
      await refresh();
    },
  });
  const held = useMutation({
    mutationFn: (action: 'run' | 'discard') => api.releaseHeldRuns(routine.id, action),
    onSuccess: async (result, action) => {
      const count = (action === 'run' ? result.queued : result.discarded) ?? 0;
      const runs = count === 1 ? '1 held run' : `${count} held runs`;
      setOutcome(action === 'run' ? `Started ${runs}.` : `Discarded ${runs}.`);
      await refresh();
    },
  });
  const { label, tone } = routineStatus(routine.status);
  const proposals = routine.versions.filter((v) => v.state === 'proposed');
  const active = routine.activeVersion;
  const archived = routine.status === 'archived';
  const stopped = routine.status === 'paused' || routine.status === 'needs_attention';
  const reason = pausedText(routine);
  const error = state.error ?? decide.error ?? held.error;
  const errorAction = state.error
    ? 'pause, resume or archive a routine'
    : decide.error
      ? 'approve or reject a routine'
      : 'run or discard held runs';
  const busy = state.isPending || decide.isPending || held.isPending;
  return (
    <Page
      {...CRUMB}
      title={routine.name}
      avatar={
        <IdentityTag identity={routine.id}>
          <Workflow size={24} aria-hidden />
        </IdentityTag>
      }
      description={`Described as: “${routine.description}”`}
      actions={
        admin && !archived ? (
          <Menu
            label="Routine actions"
            align="end"
            trigger={
              <Button size="iconSmall" aria-label="Routine actions" disabled={busy}>
                <Ellipsis size={16} />
              </Button>
            }
          >
            {routine.status === 'active' ? (
              <MenuAction onSelect={() => state.mutate('pause')}>Pause</MenuAction>
            ) : null}
            {stopped && active && !needsApproval(routine.pausedReason) ? (
              <MenuAction onSelect={() => state.mutate('resume')}>Resume</MenuAction>
            ) : null}
            <MenuSeparator />
            <MenuAction destructive onSelect={() => setConfirmArchive(true)}>
              Archive…
            </MenuAction>
          </Menu>
        ) : null
      }
    >
      <Row>
        <Badge tone={tone}>{label}</Badge>
        {stopped && routine.pausedAt ? (
          <Muted>Since {new Date(routine.pausedAt).toLocaleString()}</Muted>
        ) : null}
        {routine.status === 'active' && routine.nextFireAt ? (
          <Muted>Next run {new Date(routine.nextFireAt).toLocaleString()}</Muted>
        ) : null}
      </Row>
      {reason ? (
        <Notice warning={routine.status === 'needs_attention'}>
          {reason}
          {stopped ? ' Changes made while it is paused are not handled later.' : null}
        </Notice>
      ) : null}
      {routine.status === 'draft' && !proposals.length ? (
        <Notice>No version waits for review. Describe it again below to build one.</Notice>
      ) : null}
      {error ? <Notice error>{errorText(error, errorAction)}</Notice> : null}
      {outcome ? <Notice onDismiss={() => setOutcome(null)}>{outcome}</Notice> : null}
      {routine.heldRuns ? (
        <Panel title="Held runs">
          <Stack>
            <p className="text-sm">
              {routine.heldRuns === 1 ? '1 run is' : `${routine.heldRuns} runs are`} held. Nothing
              was done for {routine.heldRuns === 1 ? 'it' : 'them'} yet.
            </p>
            {admin ? (
              <>
                {routine.status !== 'active' ? (
                  <Muted>Held runs wait while the routine is paused. Resume it to run them.</Muted>
                ) : null}
                <Row>
                  <Button
                    disabled={busy || routine.status !== 'active'}
                    onClick={() => held.mutate('run')}
                  >
                    Run them
                  </Button>
                  <Button disabled={busy} onClick={() => held.mutate('discard')}>
                    Discard them
                  </Button>
                </Row>
              </>
            ) : (
              <Muted>A workspace admin can run or discard them.</Muted>
            )}
          </Stack>
        </Panel>
      ) : null}
      {proposals.map((version) => (
        <Panel key={version.id} title={`Version ${version.number}, waiting for review`}>
          <Stack>
            <VersionDetails version={version} />
            {admin ? (
              <>
                {active ? (
                  <Muted>
                    Approving replaces version {active.number}. Its runs that have not started yet
                    are discarded.
                  </Muted>
                ) : null}
                <Row>
                  <Button
                    variant="primary"
                    disabled={busy || archived}
                    onClick={() => decide.mutate({ version, decision: 'approve' })}
                  >
                    Approve version {version.number}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => decide.mutate({ version, decision: 'reject' })}
                  >
                    Reject
                  </Button>
                  <Button disabled={busy || archived} onClick={() => setTesting(version)}>
                    Test on a record…
                  </Button>
                </Row>
                <TestLine />
              </>
            ) : (
              <Muted>A workspace admin reviews and approves it.</Muted>
            )}
          </Stack>
        </Panel>
      ))}
      {active ? (
        <Panel title={`Version ${active.number}, approved`}>
          <Stack>
            {active.approvedBy ? (
              <Muted small>
                Approved by {active.approvedBy.name || active.approvedBy.id}
                {active.approvedAt ? ` on ${new Date(active.approvedAt).toLocaleString()}` : ''}.
              </Muted>
            ) : null}
            <VersionDetails version={active} />
            {admin && !archived ? (
              <>
                <Row>
                  {stopped &&
                  needsApproval(routine.pausedReason) &&
                  routine.pausedReason !== 'check_failed' ? (
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => decide.mutate({ version: active, decision: 'approve' })}
                    >
                      Approve again
                    </Button>
                  ) : null}
                  <Button disabled={busy} onClick={() => setTesting(active)}>
                    Test on a record…
                  </Button>
                </Row>
                <TestLine />
              </>
            ) : null}
          </Stack>
        </Panel>
      ) : null}
      {canWrite && !archived ? (
        <Panel title={active ? 'Change what it does' : 'Describe it again'}>
          <Stack>
            <Muted>
              Edit the description and the builder writes a new version.
              {active
                ? ' The approved version keeps running until an admin approves the new one.'
                : ''}
            </Muted>
            <DescribeRoutine routineId={routine.id} initial={routine.description} />
          </Stack>
        </Panel>
      ) : null}
      <Section title="Recent runs">
        <Runs routineId={routine.id} runs={routine.runs} />
      </Section>
      {testing ? (
        <TestDialog routineId={routine.id} version={testing} onClose={() => setTesting(null)} />
      ) : null}
      {confirmArchive ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !state.isPending) setConfirmArchive(false);
          }}
          title={`Archive ${routine.name}?`}
        >
          <Stack>
            <p className="text-sm">
              It stops for good. Runs waiting to start are discarded and running ones stop. Its
              history stays.
            </p>
            <Row>
              <Button
                variant="destructive"
                disabled={state.isPending}
                onClick={() => state.mutate('archive')}
              >
                {state.isPending ? 'Archiving…' : 'Archive'}
              </Button>
              <Button disabled={state.isPending} onClick={() => setConfirmArchive(false)}>
                Cancel
              </Button>
            </Row>
          </Stack>
        </Dialog>
      ) : null}
    </Page>
  );
}

function TestLine() {
  return (
    <Muted small>
      A test makes real writes. A tool that sends something, such as a message, is reported, not
      called.
    </Muted>
  );
}

/**
 * A test run (routines spec §5.3): an admin runs a version once on a record
 * they choose. The confirmation says what is real and what is held back.
 */
function TestDialog({
  routineId,
  version,
  onClose,
}: {
  routineId: string;
  version: RoutineVersionView;
  onClose: () => void;
}) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const [recordId, setRecordId] = useState('');
  const needsRecord = version.manifest.when.kind !== 'schedule' || !!version.manifest.when.object;
  const test = useMutation({
    mutationFn: () => api.testRoutine(routineId, version.id, recordId.trim() || null),
    onSuccess: () => client.invalidateQueries({ queryKey: routinesKey(session.workspace.id) }),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !test.isPending) onClose();
      }}
      title={`Test version ${version.number}`}
    >
      {test.data ? (
        <Stack>
          <Notice>The test has started.</Notice>
          <Row>
            <Button variant="primary" asChild>
              <Link to="/routines/$id/runs/$run" params={{ id: routineId, run: test.data.runId }}>
                Open the test run
              </Link>
            </Button>
            <Button onClick={onClose}>Close</Button>
          </Row>
        </Stack>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            test.mutate();
          }}
        >
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>It runs once, for real. What it writes to records is saved.</li>
            <li>
              A tool that sends something, such as a message or an email, is not called. Retainer
              reports the call and the test stops there.
            </li>
            <li>Other tools run with their extension's access.</li>
            <li>Its writes can make other routines or extensions act, and those may send.</li>
          </ul>
          {needsRecord ? (
            <FormField label="Record ID" hint="The record to test it on">
              <Input
                aria-label="Record ID"
                value={recordId}
                required
                placeholder="00000000-0000-0000-0000-000000000000"
                onChange={(e) => setRecordId(e.currentTarget.value)}
              />
            </FormField>
          ) : (
            <Muted>This routine runs without a record.</Muted>
          )}
          {test.error ? <Notice error>{errorText(test.error, 'test a routine')}</Notice> : null}
          <Row>
            <Button
              type="submit"
              variant="primary"
              disabled={test.isPending || (needsRecord && !recordId.trim())}
            >
              {test.isPending ? 'Starting…' : 'Start the test'}
            </Button>
            <Button disabled={test.isPending} onClick={onClose}>
              Cancel
            </Button>
          </Row>
        </form>
      )}
    </Dialog>
  );
}

/** The newest runs and tests, each opening its calls. */
function Runs({ routineId, runs }: { routineId: string; runs: RoutineRunView[] }) {
  if (!runs.length) return <Empty quiet title="No runs yet." />;
  return (
    <ul
      aria-label="Routine runs"
      className="flex flex-col divide-y divide-border rounded-lg border border-border"
    >
      {runs.map((run) => {
        const { label, tone } = runStatus(run.status);
        return (
          <li key={run.id}>
            <Link
              to="/routines/$id/runs/$run"
              params={{ id: routineId, run: run.id }}
              aria-label={`${triggerText(run.trigger)} run, ${label}, ${new Date(run.at).toLocaleString()}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-hover"
            >
              <Badge tone={tone}>{label}</Badge>
              <span>{triggerText(run.trigger)}</span>
              {run.recordId ? (
                <Muted small>
                  <RecordName id={run.recordId} />
                </Muted>
              ) : null}
              <span className="ml-auto">
                <Muted small>{new Date(run.at).toLocaleString()}</Muted>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
