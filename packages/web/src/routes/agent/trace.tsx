import type { RoutineRunAgentTask } from '@retainer/shared';
import { useQuery } from '@tanstack/react-query';
import { api, useWorkspace } from '../../api/client.js';
import { Badge, Loading, Muted, Notice, Section, type Tone } from '../../ui/index.js';
import { routinesKey } from '../routines/model.js';
import { ChatMessages } from './messages.js';
import { type ChatMessage, errorCode } from './model.js';

const STATE: Record<RoutineRunAgentTask['state'], { label: string; tone: Tone }> = {
  staged: { label: 'Waiting to start', tone: 'pending' },
  queued: { label: 'Waiting to start', tone: 'pending' },
  running: { label: 'Working', tone: 'pending' },
  completed: { label: 'Answered', tone: 'success' },
  failed: { label: 'No answer', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const ERASED =
  'Its messages are no longer kept: an agent task’s messages are erased 7 days after it ends.';

/**
 * What the agent did for a routine run's `ai.agent` calls (agent spec §5.3):
 * each task's saved messages, read-only, in the chat's own layout. `positions`
 * are the run's agent calls, so a task retention has erased still gets a line.
 */
export function AgentTrace({
  routineId,
  runId,
  positions,
}: {
  routineId: string;
  runId: string;
  positions: number[];
}) {
  const { session } = useWorkspace();
  const tasks = useQuery({
    queryKey: [...routinesKey(session.workspace.id), 'run', routineId, runId, 'agent-tasks'],
    queryFn: ({ signal }) => api.routineRunAgentTasks(routineId, runId, signal),
    refetchInterval: (query) =>
      query.state.data?.tasks.some((task) => !task.finishedAt) ? 3000 : false,
  });
  return (
    <Section title="What the agent did">
      {tasks.error ? (
        <Notice announce={false}>
          {errorCode(tasks.error) === 'agent_unavailable'
            ? 'The agent isn’t available on this server, so what it did can’t be shown.'
            : 'What the agent did couldn’t be loaded. Reload the page to try again.'}
        </Notice>
      ) : !tasks.data ? (
        <Loading>Loading what the agent did…</Loading>
      ) : (
        positions.map((position) => (
          <AgentTask
            key={position}
            position={position}
            task={tasks.data.tasks.find((t) => t.position === position)}
          />
        ))
      )}
    </Section>
  );
}

function AgentTask({ position, task }: { position: number; task?: RoutineRunAgentTask }) {
  const state = task ? STATE[task.state] : undefined;
  return (
    <article
      aria-label={`The agent's task for call ${position}`}
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">For call {position}</span>
        {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
        {task?.code ? <Muted small>{task.code.replaceAll('_', ' ')}</Muted> : null}
      </header>
      {!task ? (
        <Muted small>{ERASED}</Muted>
      ) : task.messages.length === 0 ? (
        <Muted small>{task.finishedAt ? ERASED : 'The agent hasn’t started on it yet.'}</Muted>
      ) : (
        <>
          <ChatMessages messages={task.messages as unknown as ChatMessage[]} mark={false} />
          {task.keptUntil ? (
            <Muted small>Kept until {new Date(task.keptUntil).toLocaleDateString()}.</Muted>
          ) : null}
        </>
      )}
    </article>
  );
}
