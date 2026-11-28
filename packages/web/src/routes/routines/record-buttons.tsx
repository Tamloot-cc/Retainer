import type { RoutineButton } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { Button } from '../../ui/index.js';
import { useReport } from '../state.js';
import { errorText, routinesKey } from './model.js';

/** The buttons of approved `manual` routines on records of `object`, when this person can press them. */
export function useRoutineButtons(object: string, enabled = true) {
  const { session } = useWorkspace();
  const allowed = session.routinesAvailable === true && canMutate(session);
  const buttons = useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'buttons', object],
    queryFn: ({ signal }) => api.routineButtons(object, signal),
    enabled: allowed && enabled,
    retry: false,
  });
  return allowed ? (buttons.data?.buttons ?? []) : [];
}

/**
 * Starts a routine's button on records and reports what happened, with a
 * link to the run (one record) or the routine's runs (several). The report
 * goes to the shell, so it outlives the menu or button that started it.
 */
export function useRunRoutineButton() {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const report = useReport();
  return useMutation({
    mutationFn: ({ button, recordIds }: { button: RoutineButton; recordIds: string[] }) =>
      api.runRoutine(button.routineId, recordIds),
    onSuccess: ({ runs }, { button, recordIds }) => {
      const runId = runs[0];
      report(
        recordIds.length === 1 ? (
          <>
            Started “{button.label}” on this record.{' '}
            {runId ? (
              <Link
                to="/routines/$id/runs/$run"
                params={{ id: button.routineId, run: runId }}
                className="underline"
              >
                See what it does
              </Link>
            ) : null}
          </>
        ) : (
          <>
            Started “{button.label}” on {runs.length} records.{' '}
            <Link to="/routines/$id" params={{ id: button.routineId }} className="underline">
              See its runs
            </Link>
          </>
        ),
      );
      void client.invalidateQueries({ queryKey: routinesKey(session.workspace.id) });
    },
    onError: (error, { button }) =>
      report(`“${button.label}” did not start: ${errorText(error, 'run this routine')}`),
  });
}

/**
 * The buttons of approved routines that run when a person presses them on
 * a record of this object (routines spec §4.2, `manual`). Pressing one
 * starts a run; the shell reports what happened, with a link to the run.
 */
export function RoutineButtons({ object, recordId }: { object: string; recordId: string }) {
  const buttons = useRoutineButtons(object);
  const run = useRunRoutineButton();
  if (!buttons.length) return null;
  return (
    <>
      {buttons.map((button) => (
        <Button
          key={button.routineId}
          size="small"
          disabled={run.isPending}
          title={`Runs the routine “${button.name}” on this record`}
          onClick={() => run.mutate({ button, recordIds: [recordId] })}
        >
          {button.label}
        </Button>
      ))}
    </>
  );
}
