import { type AgentResult, type AgentTaskRequest, agentTaskRequestSchema } from '@retainer/shared';
import type { ExecutionResult, Invocation } from './protocol.js';

/**
 * Hands the workspace agent a task from an extension function (agent spec
 * §9.2). The function can't replay, so it stages the task, returns
 * `waitFor(taskId)` and ends; when the task finishes, Retainer calls the
 * function again with the same input and `invocation.agentResult`, which
 * `withAgentResult` routes to the function's `onAgentResult`.
 *
 * `start` only stages the task: nothing runs until Retainer accepts the
 * function's `{ wait }`. A staged task the function doesn't wait for is
 * dropped. Needs `uses: ['agent']` and `agent.tools` on the function, and the
 * installation's grant.
 */
export function agentClient(
  invocation: Pick<Invocation, 'apiOrigin' | 'runToken' | 'installationId'>,
  transport: typeof fetch = fetch,
) {
  return {
    async start(request: AgentTaskRequest): Promise<{ taskId: string }> {
      const body = agentTaskRequestSchema.parse(request);
      const response = await transport(
        new URL(
          `/v1/extensions/${invocation.installationId}/runtime/agent-tasks`,
          invocation.apiOrigin,
        ),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${invocation.runToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      const json = (await response.json().catch(() => ({}))) as {
        taskId?: string;
        code?: string;
      };
      if (response.status !== 201 || typeof json.taskId !== 'string')
        throw Object.assign(new Error(`agent task refused: ${json.code ?? response.status}`), {
          status: response.status,
          code: json.code ?? 'agent_task_failed',
        });
      return { taskId: json.taskId };
    },
  };
}

/** The outcome that parks the invocation on a staged task (agent spec §9.2). */
export function waitFor(taskId: string): ExecutionResult {
  return { status: 'succeeded', wait: taskId };
}

/**
 * Routes an invocation: the answer of a task it waited for goes to
 * `onAgentResult`, anything else to `run`.
 */
export function withAgentResult(
  invocation: Invocation,
  handlers: {
    run: (invocation: Invocation) => Promise<ExecutionResult>;
    onAgentResult: (result: AgentResult, invocation: Invocation) => Promise<ExecutionResult>;
  },
): Promise<ExecutionResult> {
  return invocation.agentResult
    ? handlers.onAgentResult(invocation.agentResult, invocation)
    : handlers.run(invocation);
}
