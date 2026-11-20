import type { RoutineButton } from '@retainer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { Button } from '../../ui/index.js';
import { useReport } from '../state.js';
import { errorText, routinesKey } from './model.js';

/**
 * The buttons of approved routines that run when a person presses them on
 * a record of this object (routines spec §4.2, `manual`). Pressing one
 * starts a run; the shell reports what happened, with a link to the run.
 */
export function RoutineButtons({ object, recordId }: { object: string; recordId: string }) {
  const { session } = useWorkspace();
  const client = useQueryClient();
  const report = useReport();
  const allowed = canMutate(session);
  const buttons = useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'buttons', object],
    queryFn: ({ signal }) => api.routineButtons(object, signal),
    enabled: allowed,
    retry: false,
  });
  const run = useMutation({
    mutationFn: (button: RoutineButton) => api.runRoutine(button.routineId, [recordId]),
    onSuccess: ({ runs }, button) => {
      const runId = runs[0];
      report(
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
        </>,
      );
      void client.invalidateQueries({ queryKey: routinesKey(session.workspace.id) });
    },
    onError: (error, button) =>
      report(`“${button.label}” did not start: ${errorText(error, 'run this routine')}`),
  });
  if (!allowed || !buttons.data?.buttons.length) return null;
  return (
    <>
      {buttons.data.buttons.map((button) => (
        <Button
          key={button.routineId}
          size="small"
          disabled={run.isPending}
          title={`Runs the routine “${button.name}” on this record`}
          onClick={() => run.mutate(button)}
        >
          {button.label}
        </Button>
      ))}
    </>
  );
}
