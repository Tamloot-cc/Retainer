import { RetainerApiError } from '@retainer/sdk';
import type {
  RoutineCapabilities,
  RoutineGapCode,
  RoutineRunCall,
  RoutineRunStatus,
  RoutineRunView,
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

/** What routines can use in this workspace: its objects and fields by key, its tools. */
export function useRoutineCapabilities() {
  const { session } = useWorkspace();
  return useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'capabilities'],
    queryFn: ({ signal }) => api.routineCapabilities(signal),
    staleTime: 5 * 60_000,
  });
}

/** An object routines describe, by its API name or the universal ID a manifest stores. */
export const routineObject = (
  caps: Pick<RoutineCapabilities, 'objects'> | undefined,
  id: string | undefined,
) => caps?.objects.find((o) => o.universalId === id || o.name === id);

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
    case 'record_backlog_over_limit':
      return 'The record backlog exceeded the limit. Only the runs shown here were held.';
    case 'runs_held':
      return `It started more than 200 runs in an hour, so Retainer paused it and held the extra runs. Nothing was done for them. Resume it, then run or discard them.`;
    case 'schedule_over_limit':
      return 'A scheduled run matched more than 200 records, so Retainer paused it and held those runs. Nothing was done for them. Resume it, then run or discard them. Narrowing which records it runs on is the lasting fix.';
    case 'schedule_too_large':
      return 'A scheduled run matched more than 2,000 records, too many to hold, so Retainer paused it and did nothing. Ask the agent to narrow it to fewer records, then approve the new version.';
    case 'tool_changed':
      return 'A tool it uses changed what it does or how it connects. An admin needs to approve it again before it runs.';
    case 'approver_left':
      return 'The admin who approved it is no longer an admin. Another admin needs to approve it before it runs.';
    case 'check_failed':
      return 'The workspace changed (a field, object or tool) and its code no longer fits. Ask the agent to repair it, then approve the new version.';
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
  waiting: { label: 'Waiting for the agent', tone: 'pending' },
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
  !['queued', 'held', 'running', 'waiting'].includes(status);

/** Why a run was skipped, by the code it ended with (#147). */
const SKIPPED: Record<string, string> = {
  condition_false: 'Its condition did not match the record when it started.',
  record_used_up: 'It had already acted on this record, and it acts once per record.',
  record_gone: 'Its record was deleted before it started.',
};

/** A run's status, explained in words when the word alone is not enough. */
export function runStatusText(run: Pick<RoutineRunView, 'status' | 'code'>) {
  if (run.status === 'skipped' && run.code && SKIPPED[run.code]) return SKIPPED[run.code];
  return RUN_STATUS_TEXT[run.status];
}

/** What a run's status means, when the word alone is not enough. */
const RUN_STATUS_TEXT: Partial<Record<RoutineRunStatus, string>> = {
  held: 'It waits for an admin to run or discard it.',
  waiting:
    'It handed the workspace agent a task and continues from the start when the answer arrives.',
  skipped: 'It did not run on this record.',
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
  'ai.agent': 'Ask the agent',
};
export const operationText = (operation: string) => OPERATIONS[operation] ?? operation;

const WRITES = ['record.create', 'record.update', 'events.log', 'remember'];

/** Whether a run changed anything: a write made, or a tool called. */
export const madeChanges = (run: Pick<RoutineRunView, 'calls'>) =>
  run.calls.some(
    (call) =>
      call.state === 'done' &&
      (WRITES.includes(call.operation) ||
        // A read-only tool only answers; a call recorded before tools carried
        // their effect counts as a change, as it did then (#151).
        (call.operation === 'tool' && call.tool?.effect !== 'read')),
  );

/** A finished run's status, saying when it succeeded without changing anything. */
export function runOutcome(run: Pick<RoutineRunView, 'status' | 'calls'>) {
  if (run.status === 'succeeded' && !madeChanges(run))
    return { label: 'Done, no changes', tone: 'neutral' as Tone };
  return runStatus(run.status);
}

/** What happened to each field a write set, in words. */
export const FIELD_STATUS: Record<string, string> = {
  applied: 'saved',
  pending_review: 'waiting for review',
  superseded: 'not used: a newer value is kept',
};

/** A record write's fields and what happened to each, when the result has them. */
export function writtenFields(call: RoutineRunCall): [string, string][] | null {
  if (call.operation !== 'record.create' && call.operation !== 'record.update') return null;
  const fields = (call.result as { fields?: unknown } | undefined)?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
  return Object.entries(fields as Record<string, unknown>).map(([key, status]) => [
    key,
    String(status),
  ]);
}

/** How many values a run wrote that wait for a person's review. */
export const pendingReviews = (run: Pick<RoutineRunView, 'calls'>) =>
  run.calls.reduce(
    (count, call) =>
      count +
      (writtenFields(call)?.filter(([, status]) => status === 'pending_review').length ?? 0),
    0,
  );

const CALL_STATES: Record<string, string> = {
  started: 'Sent, no answer yet',
  done: 'Done',
  failed: 'Failed',
  reported: 'Reported, not made',
};
/** A call's state in words; a call still open on a finished run got no answer. */
export function callStateText(call: Pick<RoutineRunCall, 'state' | 'code'>, finished = false) {
  if (call.state === 'failed' && call.code === 'model_refused') return 'Refused';
  if (call.state === 'failed' && call.code === 'model_output') return 'Unusable answer';
  if (call.state === 'started' && finished) return 'No answer';
  return CALL_STATES[call.state] ?? plain(call.state);
}

/** The error a failed call kept, such as the model provider's refusal. */
export function callError(call: RoutineRunCall): string | null {
  if (call.state !== 'failed') return null;
  const error = (call.result as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' && error ? error : null;
}

const FAILURES: Record<string, string> = {
  routine_error: 'The routine’s code stopped with an error.',
  check_failed: 'The code no longer passes Retainer’s checks, so it did not run.',
  run_timeout: 'It ran past its time limit.',
  output_too_large: 'It wrote more output than a run may keep.',
  no_code: 'This version has no code to run.',
  dry_run_budget: 'Today’s model budget for dry runs was used up.',
};

/** Why a failed run failed, in a sentence, with the error it ended on. */
export function failureText(run: Pick<RoutineRunView, 'status' | 'code' | 'output'>) {
  if (!['failed', 'diverged', 'budget_exhausted'].includes(run.status)) return null;
  const error = typeof run.output?.error === 'string' ? run.output.error : null;
  const why = run.code ? (FAILURES[run.code] ?? null) : null;
  if (!why && !error) return null;
  return [why, error ? `The error: ${error}` : null].filter(Boolean).join(' ');
}

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
  full: 'The agent that wrote it says this routine does everything you described.',
  partial: 'The agent that wrote it says this routine does only part of what you described.',
  not_possible: 'The agent that wrote it says this cannot be done yet.',
} as const;

/** An API error as a sentence; a 403 says who can do it instead. */
export function errorText(error: unknown, action: string) {
  if (error instanceof RetainerApiError) {
    if (error.status === 403) return `Only a workspace admin can ${action}.`;
    if (error.code === 'model_unavailable')
      return 'This server has no model key, so routines cannot call a model. Your operator can add one.';
  }
  return error instanceof Error ? error.message : String(error);
}

const plain = (code: string) => code.replaceAll('_', ' ');
