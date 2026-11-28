import { RetainerApiError } from '@retainer/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { Button, CodeBlock, Muted, Notice, RelativeTime, Stack } from '../../ui/index.js';
import { DraftCard } from '../agent/draft-card.js';
import { DryRunList, Problems } from './dry-run.js';
import { errorText, routinesKey } from './model.js';
import {
  countText,
  draftState,
  parseRoutineFence,
  previewAge,
  proposalText,
  proposeBody,
} from './routine-draft.js';
import { Report } from './version.js';

/** Refusals that mean the draft changed state: the card reads it again (§5.2). */
const STALE = new Set(['invalid_routine', 'not_validated', 'routine_archived']);
const DAY = 86_400_000;

/**
 * A routine draft in the chat (routines-in-chat spec §5): the agent's words
 * from the fence, and everything Retainer vouches for from the draft route.
 * It never starts a check or a dry run; Propose proposes as the person.
 */
export default function RoutineChatBlock({
  code,
  streaming,
  complete,
}: {
  code: string;
  streaming: boolean;
  complete: boolean;
}) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const parsed = useMemo(() => {
    if (!complete || streaming) return {};
    try {
      return { fence: parseRoutineFence(code) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [code, complete, streaming]);
  const { fence } = parsed;
  const key = [
    ...routinesKey(session.workspace.id),
    'draft',
    fence?.source,
    fence?.preview,
    fence?.routine,
  ];
  const draft = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      if (!fence) throw new Error('The routine draft is incomplete.');
      return api.routineDraft(
        fence.source,
        { preview: fence.preview, ...(fence.routine ? { routine: fence.routine } : {}) },
        signal,
      );
    },
    enabled: !!fence,
    retry: false,
  });
  // A dry run still going: read only its runs again until it is done, never
  // start one. The draft itself (facts, check, count) is read once.
  const going = !!draft.data?.preview?.available && !draft.data.preview.done;
  const polled = useQuery({
    queryKey: [...key, 'runs'],
    queryFn: ({ signal }) => api.routinePreview(fence?.preview ?? '', signal),
    enabled: going && !!fence?.preview,
    retry: false,
    refetchInterval: (query) => (query.state.data?.done ? false : 2000),
  });
  const propose = useMutation({
    mutationFn: () => {
      if (!fence) throw new Error('The routine draft is incomplete.');
      return api.proposeRoutine(proposeBody(fence));
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: routinesKey(session.workspace.id) });
    },
    onError: async (error) => {
      if (error instanceof RetainerApiError && STALE.has(error.code)) await draft.refetch();
    },
  });
  const expired =
    draft.error instanceof RetainerApiError && draft.error.status === 404
      ? 'This draft has expired. Ask the agent to draft it again.'
      : undefined;
  const message =
    parsed.error ??
    expired ??
    (draft.error ? errorText(draft.error, 'see this draft') : undefined) ??
    (complete || streaming ? undefined : 'The routine draft is incomplete.');
  const data =
    draft.data?.preview?.available && polled.data
      ? {
          ...draft.data,
          preview: { available: true as const, done: polled.data.done, runs: polled.data.runs },
        }
      : draft.data;
  const state = fence && data ? draftState(fence, data) : undefined;
  const canPropose = canMutate(session);
  const admin = canMutate(session, 'admin');
  const proposed = state?.kind === 'proposed' ? state.proposal : undefined;
  const count = data ? countText(data.count) : null;
  const runs = data?.preview?.available ? data.preview.runs : [];
  const { age, cleared, newest } = previewAge(runs);
  const lastRan = newest === undefined ? undefined : new Date(newest).toISOString();
  return (
    <DraftCard
      notice={
        propose.error &&
        !(propose.error instanceof RetainerApiError && STALE.has(propose.error.code)) ? (
          <Notice error>{errorText(propose.error, 'propose a routine')}</Notice>
        ) : undefined
      }
      actions={
        fence && data ? (
          proposed ? (
            <Button size="small" asChild>
              <Link to="/routines/$id" params={{ id: proposed.routineId }}>
                {admin && proposed.state === 'proposed' ? 'Review and approve' : 'Open'}
              </Link>
            </Button>
          ) : state?.kind === 'ready' && canPropose ? (
            <Button
              variant="primary"
              size="small"
              disabled={propose.isPending}
              onClick={() => propose.mutate()}
            >
              {fence.routine ? 'Propose new version' : 'Propose'}
            </Button>
          ) : undefined
        ) : undefined
      }
    >
      <div>
        <h3 className="text-sm font-medium">{fence?.name ?? 'Routine draft'}</h3>
        {fence ? <p className="text-sm text-muted-foreground">{fence.description}</p> : null}
      </div>
      {streaming ? (
        <p className="text-xs text-muted-foreground">Drafting routine…</p>
      ) : message ? (
        <Notice error>{message}</Notice>
      ) : !data || !fence || !state ? (
        <p className="text-xs text-muted-foreground">Loading the draft…</p>
      ) : (
        <Stack>
          {proposed ? <Notice>{proposalText(proposed.state)}</Notice> : null}
          {state.kind === 'problems' ? (
            <Notice error>
              <Stack>
                <span>This draft no longer passes Retainer’s checks.</span>
                <Problems problems={data.problems} />
              </Stack>
            </Notice>
          ) : null}
          {state.kind === 'unchecked' ? (
            <Notice>
              This draft needs a fresh check: it is over a week old, or the workspace changed. Ask
              the agent to check it again.
            </Notice>
          ) : null}
          <section aria-label="Retainer's facts" className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">What it does, in Retainer’s words</h4>
            {data.facts.length ? (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {data.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            ) : (
              <Muted small>Retainer could not describe this draft.</Muted>
            )}
          </section>
          <section aria-label="The agent's summary" className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">Written by the agent</h4>
            <p className="text-sm">{fence.summary}</p>
            <Report report={fence.report} />
          </section>
          <section aria-label="Dry run" className="flex flex-col gap-1">
            <h4 className="text-xs font-medium">Dry run</h4>
            {count ? <Muted small>{count}</Muted> : null}
            {data.preview?.available && !cleared ? (
              <>
                {age > DAY && lastRan ? (
                  <Muted small>
                    It last ran <RelativeTime at={lastRan} />.
                  </Muted>
                ) : null}
                <DryRunList runs={data.preview.runs} done={data.preview.done} />
                <Muted small>
                  Records are read as they are today, and a model can answer differently next time.
                </Muted>
              </>
            ) : (
              <Muted small>
                {cleared ? 'The dry run’s results are no longer kept.' : 'No stored dry run.'} An
                admin can test it on a record before approving.
              </Muted>
            )}
          </section>
          <CodeBlock summary="Show the code" code={data.code} />
          {!proposed && state.kind === 'ready' && !canPropose ? (
            <Muted small>A person with write access can propose this routine.</Muted>
          ) : null}
          {!proposed && state.kind === 'ready' && canPropose ? (
            <Muted small>
              Proposing saves it for an admin. Nothing runs until an admin approves it.
            </Muted>
          ) : null}
        </Stack>
      )}
    </DraftCard>
  );
}
