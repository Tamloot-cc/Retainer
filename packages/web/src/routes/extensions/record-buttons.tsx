import type { ExtensionRecordButton } from '@retainer/extension';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { api, canMutate, useWorkspace } from '../../api/client.js';
import { Button } from '../../ui/index.js';
import { useReport } from '../state.js';
import { queryKey, stateLabel } from './model.js';

const inProgress = (status: string) =>
  status === 'queued' || status === 'running' || status === 'waiting';

// The built-in Exa button IDs are stable across releases.
const exaButtons = new Set([
  'f2a76368-d95d-4020-a8e9-099b1e5ceda4',
  'd8c01ffc-4418-43e8-a084-dc7d499d8117',
]);

/**
 * Watches a record button's run until it ends, then reports how it went
 * and refreshes what it may have changed. `onEnd` runs once it has.
 */
function useRunWatch(
  button: ExtensionRecordButton,
  runId: string | undefined,
  report: (message: string) => void,
  onEnd: () => void,
) {
  const { session } = useWorkspace();
  const workspace = session.workspace.id;
  const isExa = exaButtons.has(button.functionId);
  const client = useQueryClient();
  const run = useQuery({
    queryKey: [...queryKey, workspace, 'record-button-run', button.installationId, runId],
    queryFn: ({ signal }) =>
      api.extensionRecordButtonRun(button.installationId, runId ?? '', signal),
    enabled: !!runId,
    refetchInterval: (query) =>
      !query.state.error && (!query.state.data || inProgress(query.state.data.status))
        ? 2000
        : false,
  });

  useEffect(() => {
    if (!runId) return;
    if (run.error) {
      report(`Couldn’t check the status of “${button.label}”.`);
    } else if (run.data && !inProgress(run.data.status)) {
      if (run.data.status === 'succeeded') {
        const code = run.data.code;
        if (isExa && code === 'no_domain') {
          report('Enrichment skipped. Add a company domain and try again.');
        } else if (isExa && (code === 'no_match' || code?.startsWith('no_match_'))) {
          report('Enrichment skipped. No confident match was found.');
        } else {
          const reason =
            code === 'nothing_to_fill' ? ' All mapped fields already have values.' : '';
          report(`“${button.label}” finished.${reason}`);
        }
      } else {
        report(`“${button.label}” ended with status: ${stateLabel(run.data.status)}.`);
      }
      void client.invalidateQueries({ queryKey: [workspace] });
    } else {
      return;
    }
    onEnd();
  }, [button.label, client, isExa, report, onEnd, run.data, run.error, runId, workspace]);
}

/**
 * A run started away from its button (from a record's right-click menu):
 * renders nothing, and reports the run's end like the button does.
 */
export function ExtensionRunWatch({
  button,
  runId,
  runKey,
  report,
  onEnd,
}: {
  button: ExtensionRecordButton;
  runId: string;
  /** Handed back to `onEnd`. */
  runKey: string;
  report: (message: string) => void;
  onEnd: (runKey: string) => void;
}) {
  const end = useCallback(() => onEnd(runKey), [onEnd, runKey]);
  useRunWatch(button, runId, report, end);
  return null;
}

/**
 * Starts an extension's record button and reports it: the run's ID, or
 * undefined when it couldn't start (reported too).
 */
export async function startExtensionRun(
  button: ExtensionRecordButton,
  recordId: string,
  report: (message: string) => void,
): Promise<string | undefined> {
  try {
    const { id } = await api.runExtensionRecordButton(button, recordId);
    report(`Started “${button.label}” on this record.`);
    return id;
  } catch (error) {
    report(`Couldn’t start “${button.label}”. ${(error as Error).message}`);
    return undefined;
  }
}

function RecordButton({
  button,
  recordId,
  report,
}: {
  button: ExtensionRecordButton;
  recordId: string;
  report: (message: string) => void;
}) {
  const {
    mutate,
    reset,
    data: runId,
    isPending,
  } = useMutation({
    mutationFn: () => startExtensionRun(button, recordId, report),
  });
  useRunWatch(button, runId, report, reset);

  const busy = isPending || !!runId;
  return (
    <Button
      size="small"
      aria-disabled={busy}
      aria-busy={busy}
      className="aria-disabled:opacity-50"
      onClick={() => {
        if (!busy) mutate();
      }}
    >
      {button.label}
    </Button>
  );
}

/** The record buttons extensions add to records of `object`, when this person can press them. */
export function useExtensionButtons(object: string, enabled = true) {
  const { session } = useWorkspace();
  const allowed = canMutate(session);
  const buttons = useQuery({
    queryKey: [...queryKey, session.workspace.id, 'record-buttons', object],
    queryFn: ({ signal }) => api.extensionRecordButtons(object, signal),
    enabled: allowed && enabled,
    // Changes to extensions refresh this list (they invalidate `queryKey`).
    staleTime: 5 * 60_000,
    retry: false,
  });
  return allowed ? (buttons.data?.buttons ?? []) : [];
}

export function ExtensionRecordButtons({
  object,
  recordId,
  onReport,
}: {
  object: string;
  recordId: string;
  onReport?: (message: string) => void;
}) {
  const report = useReport();
  const buttons = useExtensionButtons(object);
  return buttons.map((button) => (
    <RecordButton
      key={`${button.installationId}:${button.functionId}:${recordId}`}
      button={button}
      recordId={recordId}
      report={onReport ?? report}
    />
  ));
}
