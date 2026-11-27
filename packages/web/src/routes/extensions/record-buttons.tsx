import type { ExtensionRecordButton } from '@retainer/extension';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
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

function RecordButton({
  button,
  recordId,
  report,
}: {
  button: ExtensionRecordButton;
  recordId: string;
  report: (message: string) => void;
}) {
  const { session } = useWorkspace();
  const workspace = session.workspace.id;
  const isExa = exaButtons.has(button.functionId);
  const client = useQueryClient();
  const { mutate, reset, data, isPending } = useMutation({
    mutationFn: () => api.runExtensionRecordButton(button, recordId),
    onSuccess: () => report(`Started “${button.label}” on this record.`),
    onError: (error) => report(`Couldn’t start “${button.label}”. ${error.message}`),
  });
  const runId = data?.id;
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
    reset();
  }, [button.label, client, isExa, report, reset, run.data, run.error, runId, workspace]);

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

export function ExtensionRecordButtons({
  object,
  recordId,
  onReport,
}: {
  object: string;
  recordId: string;
  onReport?: (message: string) => void;
}) {
  const { session } = useWorkspace();
  const report = useReport();
  const allowed = canMutate(session);
  const buttons = useQuery({
    queryKey: [...queryKey, session.workspace.id, 'record-buttons', object],
    queryFn: ({ signal }) => api.extensionRecordButtons(object, signal),
    enabled: allowed,
    retry: false,
  });
  if (!allowed) return null;
  return buttons.data?.buttons.map((button) => (
    <RecordButton
      key={`${button.installationId}:${button.functionId}:${recordId}`}
      button={button}
      recordId={recordId}
      report={onReport ?? report}
    />
  ));
}
