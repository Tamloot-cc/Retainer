import { RetainerApiError } from '@retainer/sdk';
import type {
  RoutineGapCode,
  RoutineRunStatus,
  RoutineStatus,
  RoutineView,
} from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { api, useWorkspace } from '../../api/client.js';
import type { Tone } from '../../ui/index.js';

/** Every routine query sits under this key, so one invalidation refreshes them all. */
export const routinesKey = (workspace: string) => [workspace, 'routines'];

export function useRoutines() {
  const { session } = useWorkspace();
  return useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'list'],
    queryFn: ({ signal }) => api.routines(signal),
  });
}

/** The workspace's time zone, which schedules are read in. */
export function useTimeZone() {
  const { session } = useWorkspace();
  return useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'capabilities'],
    queryFn: ({ signal }) => api.routineCapabilities(signal),
    select: (caps) => caps.timezone,
    staleTime: 5 * 60_000,
  });
}

const STATUS: Record<RoutineStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Not approved yet', tone: 'pending' },
  active: { label: 'On', tone: 'success' },
  paused: { label: 'Paused', tone: 'neutral' },
  needs_attention: { label: 'Needs attention', tone: 'error' },
  archived: { label: 'Archived', tone: 'neutral' },
};
export const routineStatus = (status: RoutineStatus) =>
  STATUS[status] ?? { label: status, tone: 'neutral' as Tone };

/** Why a routine stopped, in a sentence. */
export function pausedText(routine: Pick<RoutineView, 'status' | 'pausedReason'>) {
  switch (routine.pausedReason) {
    case 'paused':
      return 'An admin paused it.';
    case 'runs_held':
      return `It started more than 200 runs in an hour, so Retainer paused it and held the extra runs. Nothing was done for them. Resume it, then run or discard them.`;
    case 'schedule_over_limit':
      return 'A scheduled run matched more than 200 records, so Retainer paused it and held those runs. Nothing was done for them. Resume it, then run or discard them. Narrowing which records it runs on is the lasting fix.';
    case 'tool_changed':
      return 'A tool it uses changed what it does or how it connects. An admin needs to approve it again before it runs.';
    case 'approver_left':
      return 'The admin who approved it is no longer an admin. Another admin needs to approve it before it runs.';
    case 'check_failed':
      return 'The workspace changed (a field, object or tool) and its code no longer fits. Describe it again to repair it, then approve the new version.';
    case 'failing':
      return 'Its runs kept failing, so Retainer paused it. Check the recent runs below before you resume it.';
    case null:
      return routine.status === 'paused' || routine.status === 'needs_attention'
        ? 'It is not running.'
        : null;
    default:
      return `It stopped (${plain(routine.pausedReason)}).`;
  }
}
/** Reasons a paused routine cannot simply be resumed: it needs a new approval. */
export const needsApproval = (reason: string | null) =>
  ['tool_changed', 'approver_left', 'check_failed'].includes(reason ?? '');

const RUN_STATUS: Record<RoutineRunStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Waiting to start', tone: 'pending' },
  held: { label: 'Held', tone: 'pending' },
  running: { label: 'Running', tone: 'pending' },
  succeeded: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  diverged: { label: 'Stopped on retry', tone: 'error' },
  budget_exhausted: { label: 'Out of budget', tone: 'error' },
  erased: { label: 'Ended by an erase', tone: 'neutral' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};
export const runStatus = (status: RoutineRunStatus) =>
  RUN_STATUS[status] ?? { label: plain(status), tone: 'neutral' as Tone };
export const runFinished = (status: RoutineRunStatus) =>
  !['queued', 'held', 'running'].includes(status);

/** What a run's status means, when the word alone is not enough. */
export const RUN_STATUS_TEXT: Partial<Record<RoutineRunStatus, string>> = {
  held: 'It waits for an admin to run or discard it.',
  skipped: 'Its condition did not match when it started, or it had already acted on this record.',
  expired: 'It ran past its time limit and did nothing more.',
  stopped: 'The routine was paused or archived while it ran, so it did nothing more.',
  diverged:
    'A retry took a different path from the first attempt, so it stopped to avoid doing anything twice.',
  budget_exhausted: 'It used up its write budget and did nothing more.',
  erased: 'Workspace data was erased for privacy while it ran, so it ended.',
  failed: 'What it did before failing is not undone; the calls below show each step.',
};

const TRIGGERS: Record<string, string> = {
  record: 'A record changed',
  schedule: 'On schedule',
  manual: 'Button pressed',
  test: 'Test',
  build: 'Builder',
  check: 'Check',
  preview: 'Dry run',
};
export const triggerText = (trigger: string) => TRIGGERS[trigger] ?? plain(trigger);

const OPERATIONS: Record<string, string> = {
  'record.create': 'Create a record',
  'record.update': 'Update a record',
  'events.log': 'Log an event',
  remember: 'Remember a fact',
  tool: 'Call a tool',
  'ai.generate': 'Ask the model',
};
export const operationText = (operation: string) => OPERATIONS[operation] ?? operation;

const CALL_STATES: Record<string, string> = {
  started: 'Sent, no answer yet',
  done: 'Done',
  failed: 'Failed',
  reported: 'Reported, not made',
};
export const callStateText = (state: string) => CALL_STATES[state] ?? plain(state);

const GAPS: Record<RoutineGapCode, string> = {
  no_source: 'Nothing brings this kind of event into Retainer.',
  no_tool: 'No installed extension can do this.',
  tool_not_connected: 'The extension that can do this has no connected account.',
  member_account: 'This would act from one person’s own account.',
  field_not_filterable: 'The condition tests a field Retainer cannot filter on.',
  needs_aggregate_trigger: 'It would need to react when a total or count changes.',
  needs_previous_value: 'It would need the value a field had before it changed.',
  needs_instant_answer: 'It would need to answer while someone waits.',
  needs_blocking: 'It would need to stop a change from being saved.',
  needs_deletion_trigger: 'It would need to react when a record is deleted.',
  needs_person_rank: 'It would need to replace a value a person set, without review.',
  model_unavailable: 'It needs a model, and this server has no model key.',
  over_limit: 'It would go over one of Retainer’s limits.',
  unclear: 'The description can be read more than one way.',
};
export const gapText = (code: string) => GAPS[code as RoutineGapCode] ?? plain(code);

export const VERDICTS = {
  full: 'The builder says this routine does everything you described.',
  partial: 'The builder says this routine does only part of what you described.',
  not_possible: 'The builder says this cannot be done yet.',
} as const;

/** The reasons a build job ends without a proposal, in a sentence. */
export function buildFailureText(code: string | null) {
  switch (code) {
    case 'builder_failed':
      return 'The builder could not write a routine that passes Retainer’s checks. Try describing it differently, or more simply.';
    case 'model_unavailable':
      return 'This server has no model key, so the builder cannot run. Your operator can add one.';
    case 'run_expired':
      return 'The builder took too long and stopped.';
    default:
      return `The builder stopped${code ? ` (${plain(code)})` : ''}.`;
  }
}

/** An API error as a sentence; a 403 says who can do it instead. */
export function errorText(error: unknown, action: string) {
  if (error instanceof RetainerApiError) {
    if (error.status === 403) return `Only a workspace admin can ${action}.`;
    if (error.code === 'model_unavailable')
      return 'This server has no model key, so the builder cannot run. Your operator can add one.';
  }
  return error instanceof Error ? error.message : String(error);
}

const plain = (code: string) => code.replaceAll('_', ' ');
