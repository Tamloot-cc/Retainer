import { RetainerApiError } from '@retainer/sdk';
import type {
  RoutineRunAgentTask,
  RoutineRunCall,
  SchemaDescription,
  Session,
} from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { AgentTrace } from './trace.js';

type Call = { position: number; state: RoutineRunCall['state']; code: string | null };
const done = (position: number): Call => ({ position, state: 'done', code: null });

function show(calls: Call[], runFinished = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkspaceContext.Provider
        value={{
          session: {
            actor: { type: 'user', id: 'dana' },
            scopes: ['read'],
            workspace: { id: 'workspace', name: 'Acme', slug: 'acme' },
            person: true,
          } as Session,
          schema: { objects: [] } as unknown as SchemaDescription,
        }}
      >
        <AgentTrace routineId="routine-1" runId="run-1" calls={calls} runFinished={runFinished} />
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

const task = (over: Partial<RoutineRunAgentTask> = {}): RoutineRunAgentTask => ({
  sessionId: 'task-1',
  position: 2,
  state: 'completed',
  code: null,
  createdAt: '2026-11-25T10:00:00Z',
  finishedAt: '2026-11-25T10:02:00Z',
  keptUntil: '2026-12-02T10:02:00Z',
  messages: [
    { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Input: { "name": "Acme" }' }] },
    {
      id: 'a',
      role: 'assistant',
      parts: [
        {
          type: 'tool-web_search',
          toolCallId: 't',
          state: 'output-available',
          input: { query: 'Acme funding' },
          output: [],
        },
        { type: 'text', text: '{"round":"Series B"}', state: 'done' },
      ],
    },
  ],
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('AgentTrace', () => {
  it("shows a task's saved messages read-only, with its state and how long they're kept", async () => {
    const tasks = vi.spyOn(api, 'routineRunAgentTasks').mockResolvedValue({ tasks: [task()] });
    show([done(2)]);
    const article = await screen.findByRole('article', { name: "The agent's task for call 2" });
    expect(within(article).getByText('Answered')).toBeTruthy();
    expect(within(article).getByText('Searched the web for “Acme funding”')).toBeTruthy();
    expect(within(article).getByText('{"round":"Series B"}')).toBeTruthy();
    expect(within(article).getByText(/Kept until/)).toBeTruthy();
    // Nothing is happening in a saved trace: no mark moves.
    expect(article.querySelector('.retainer-mark')).toBeNull();
    expect(tasks).toHaveBeenCalledWith('routine-1', 'run-1', expect.anything());
  });

  it('says plainly when retention has erased a task', async () => {
    vi.spyOn(api, 'routineRunAgentTasks').mockResolvedValue({
      tasks: [task({ position: 4, messages: [] })],
    });
    show([done(1), done(4)]);
    const gone = await screen.findByRole('article', { name: "The agent's task for call 1" });
    expect(within(gone).getByText(/no longer kept/)).toBeTruthy();
    const emptied = screen.getByRole('article', { name: "The agent's task for call 4" });
    expect(within(emptied).getByText(/no longer kept/)).toBeTruthy();
  });

  it('says a task that has not started yet is waiting', async () => {
    vi.spyOn(api, 'routineRunAgentTasks').mockResolvedValue({
      tasks: [task({ state: 'queued', finishedAt: null, keptUntil: null, messages: [] })],
    });
    show([done(2)]);
    expect(await screen.findByText('Waiting to start')).toBeTruthy();
    expect(screen.getByText(/hasn’t started on it yet/)).toBeTruthy();
  });

  it('says a call the runtime refused got no task, with why', async () => {
    vi.spyOn(api, 'routineRunAgentTasks').mockResolvedValue({ tasks: [] });
    show([{ position: 3, state: 'failed', code: 'agent_not_declared' }]);
    const card = await screen.findByRole('article', { name: "The agent's task for call 3" });
    expect(within(card).getByText(/was refused: agent not declared/)).toBeTruthy();
    expect(within(card).queryByText(/no longer kept/)).toBeNull();
  });

  it('keeps checking while the run may still start another agent call', async () => {
    const tasks = vi
      .spyOn(api, 'routineRunAgentTasks')
      .mockResolvedValueOnce({ tasks: [task()] })
      .mockResolvedValue({ tasks: [task(), task({ sessionId: 'task-2', position: 5 })] });
    show([done(2), { position: 5, state: 'started', code: null }], false);
    const card = await screen.findByRole('article', { name: "The agent's task for call 5" });
    expect(within(card).getByText(/hasn’t started on it yet/)).toBeTruthy();
    await waitFor(() => expect(tasks.mock.calls.length).toBeGreaterThan(1), { timeout: 5000 });
    expect(await within(card).findByText('Answered')).toBeTruthy();
  });

  it('explains when the agent is not available on this server', async () => {
    vi.spyOn(api, 'routineRunAgentTasks').mockRejectedValue(
      new RetainerApiError(503, 'agent_unavailable', 'not set up'),
    );
    show([done(2)]);
    expect(await screen.findByText(/isn’t available on this server/)).toBeTruthy();
  });
});
