import type { RoutineProblem, RoutineReport } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, useWorkspace } from '../../api/client.js';
import { Button, Loading, Muted, Notice, Row, Stack, Textarea } from '../../ui/index.js';
import { buildFailureText, errorText, routinesKey, runFinished } from './model.js';
import { Report } from './version.js';

/** What a build job leaves in its output (the routine builder's outcome). */
type BuildOutput = {
  outcome?: string;
  proposed?: boolean;
  routineId?: string;
  versionId?: string;
  report?: RoutineReport;
  code?: string;
  problems?: RoutineProblem[];
};

/**
 * The built-in builder (routines spec §5.1): a description in plain words
 * becomes a proposal for an admin to review. With `routineId` it proposes a
 * new version of that routine; the active one keeps running meanwhile.
 */
export function DescribeRoutine({
  routineId,
  initial = '',
  onDone,
}: {
  routineId?: string;
  initial?: string;
  /** Called once a proposal is saved, after opening it. */
  onDone?: () => void;
}) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [description, setDescription] = useState(initial);
  const [jobId, setJobId] = useState<string | null>(null);
  const build = useMutation({
    mutationFn: () => api.buildRoutine(description.trim(), routineId),
    onSuccess: ({ jobId }) => setJobId(jobId),
  });
  const job = useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'job', jobId],
    queryFn: ({ signal }) => api.routineJob(jobId ?? '', signal),
    enabled: !!jobId,
    refetchInterval: (query) =>
      query.state.data && runFinished(query.state.data.status) ? false : 2000,
  });
  const output = (job.data?.output ?? null) as BuildOutput | null;
  const finished = !!job.data && runFinished(job.data.status);
  const proposed =
    finished && job.data?.status === 'succeeded' && output?.proposed ? output.routineId : undefined;
  useEffect(() => {
    if (!proposed) return;
    void client.invalidateQueries({ queryKey: routinesKey(session.workspace.id) });
    setJobId(null);
    onDone?.();
    void navigate({ to: '/routines/$id', params: { id: proposed } });
  }, [proposed, client, session.workspace.id, navigate, onDone]);
  const working = build.isPending || (!!jobId && !finished);
  const notPossible = finished && job.data?.status === 'succeeded' && output?.proposed === false;
  const failed = finished && job.data?.status !== 'succeeded';
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setJobId(null);
        build.mutate();
      }}
    >
      <Textarea
        prose
        aria-label="Describe the routine"
        placeholder="For example: when a deal moves to Won, create a task for its owner to send a thank-you note within two days."
        value={description}
        maxLength={10000}
        disabled={working}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Muted small>
        The builder writes the routine with a language model. Your description and the content of
        some records go to the model provider. Nothing runs until an admin approves it.
      </Muted>
      {build.error ? <Notice error>{errorText(build.error, 'build a routine')}</Notice> : null}
      {job.error ? <Notice error>{errorText(job.error, 'build a routine')}</Notice> : null}
      {working ? <Loading>Building the routine. This can take a minute…</Loading> : null}
      {notPossible ? (
        <Notice>
          <Stack>
            <span>The builder could not make this routine, so nothing was saved.</span>
            {output?.report ? <Report report={output.report} /> : null}
          </Stack>
        </Notice>
      ) : null}
      {failed ? (
        <Notice error>
          <Stack>
            <span>{buildFailureText(job.data?.code ?? output?.code ?? null)}</span>
            {output?.problems?.length ? (
              <ul aria-label="Problems" className="list-disc pl-5">
                {output.problems.map((problem) => (
                  <li key={`${problem.part}:${problem.at ?? ''}:${problem.code}`}>
                    {problem.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Stack>
        </Notice>
      ) : null}
      <Row>
        <Button type="submit" variant="primary" disabled={working || !description.trim()}>
          {routineId ? 'Build a new version' : 'Build routine'}
        </Button>
      </Row>
    </form>
  );
}
