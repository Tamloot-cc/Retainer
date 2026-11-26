import { RetainerApiError } from '@retainer/sdk';
import type { RoutineRunAgentTask, SchemaDescription, Session } from '@retainer/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, WorkspaceContext } from '../../api/client.js';
import { AgentTrace } from './trace.js';

function show(positions: number[]) {
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
        <AgentTrace routineId="routine-1" runId="run-1" positions={positions} />
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
    show([2]);
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
    show([1, 4]);
    const gone = await screen.findByRole('article', { name: "The agent's task for call 1" });
    expect(within(gone).getByText(/no longer kept/)).toBeTruthy();
    const emptied = screen.getByRole('article', { name: "The agent's task for call 4" });
    expect(within(emptied).getByText(/no longer kept/)).toBeTruthy();
  });

  it('says a task that has not started yet is waiting', async () => {
    vi.spyOn(api, 'routineRunAgentTasks').mockResolvedValue({
      tasks: [task({ state: 'queued', finishedAt: null, keptUntil: null, messages: [] })],
    });
    show([2]);
    expect(await screen.findByText('Waiting to start')).toBeTruthy();
    expect(screen.getByText(/hasn’t started on it yet/)).toBeTruthy();
  });

  it('explains when the agent is not available on this server', async () => {
    vi.spyOn(api, 'routineRunAgentTasks').mockRejectedValue(
      new RetainerApiError(503, 'agent_unavailable', 'not set up'),
    );
    show([2]);
    expect(await screen.findByText(/isn’t available on this server/)).toBeTruthy();
  });
});
