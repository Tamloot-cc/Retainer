import { deliverTask, expireTasks } from '../agent-runtime/tasks.js';
import type { Config } from '../config.js';
import type { Sql } from '../db/client.js';
import { inWorkspace } from '../db/tx.js';
import { log } from '../log.js';

/**
 * Hands task jobs to the agent runtime (agent spec §9.3, §13). Each
 * delivery carries a fresh job token the runtime trades, with the runtime
 * credential, for a turn; a delivery that never claims or closes is handed
 * out again once its lease runs out, up to the task's attempts.
 */
export type AgentTaskDriver = {
  deliver(task: { sessionId: string; jobToken: string }): Promise<void>;
};

/** The self-hosted `agent` container: `POST /tasks/:id/run`, answered at once, run in the background. */
export class HttpTaskDriver implements AgentTaskDriver {
  constructor(
    private readonly upstream: string,
    private readonly runtimeSecret: string,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async deliver(task: { sessionId: string; jobToken: string }) {
    const response = await this.transport(
      new URL(`/tasks/${task.sessionId}/run`, this.upstream).toString(),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.runtimeSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ job: task.jobToken }),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      },
    );
    await response.body?.cancel().catch(() => {});
    if (response.status !== 202) throw new Error(`the agent runtime answered ${response.status}`);
  }
}

/** Invokes a Lambda function asynchronously; tests replace AWS. */
export type LambdaEventInvoke = (
  target: string,
  payload: Uint8Array,
) => Promise<number | undefined>;

let lambdaClient: Promise<LambdaEventInvoke> | undefined;
export const invokeEvent: LambdaEventInvoke = async (target, payload) => {
  lambdaClient ??= import('@aws-sdk/client-lambda').then(({ LambdaClient, InvokeCommand }) => {
    const lambda = new LambdaClient({ maxAttempts: 1 });
    return async (FunctionName, Payload) =>
      (await lambda.send(new InvokeCommand({ FunctionName, Payload, InvocationType: 'Event' })))
        .StatusCode;
  });
  return (await lambdaClient)(target, payload);
};

/**
 * The hosted `agent` function: invoked asynchronously with its native
 * payload, under this function's own IAM role (the launcher's credential).
 * The payload holds the job token, which the runtime presents to the API.
 */
export class LambdaTaskDriver implements AgentTaskDriver {
  constructor(
    private readonly functionName: string,
    private readonly invoke: LambdaEventInvoke = invokeEvent,
  ) {}
  async deliver(task: { sessionId: string; jobToken: string }) {
    const status = await this.invoke(
      this.functionName,
      new TextEncoder().encode(
        JSON.stringify({ kind: 'agent-task', sessionId: task.sessionId, job: task.jobToken }),
      ),
    );
    if (status !== 202) throw new Error(`the agent function answered ${status}`);
  }
}

/**
 * One pass over due task jobs, and over tasks and waiting runs past their
 * expiry. `sql` is the runtime role; `discovery` the executor role, which
 * finds due work across workspaces.
 */
export class AgentTaskDispatcher {
  constructor(
    private readonly sql: Sql,
    private readonly discovery: Sql,
    private readonly driver: AgentTaskDriver,
  ) {}

  async tick(deadline = Date.now() + 10_000) {
    let delivered = 0;
    const due = await this.discovery<{ workspace_id: string; session_id: string }[]>`
      select * from retainer_agent_tasks_due(50)`;
    for (const { workspace_id: workspace, session_id: sessionId } of due) {
      if (Date.now() >= deadline) break;
      const handed = await inWorkspace(this.sql, workspace, (tx) => deliverTask(tx, sessionId));
      if (!handed) continue;
      try {
        await this.driver.deliver({ sessionId, jobToken: handed.jobToken });
        delivered++;
      } catch {
        // The delivery's short lease runs out and the job is handed out again.
        log.warn(`Delivering agent task ${sessionId} failed; it will be retried.`);
      }
    }
    return { delivered };
  }
}

/** Ends tasks and waiting runs past their expiry, in one workspace (§9.2). */
export async function expireWorkspaceTasks(sql: Sql, workspace: string) {
  await inWorkspace(sql, workspace, (tx) => expireTasks(tx));
}

/**
 * Where task jobs go (agent spec §9.3, §13): the hosted `agent` function, or
 * the self-hosted `agent` container. None without the runtime credential.
 */
export function agentTaskDriver(
  config: Pick<
    Config,
    'RETAINER_AGENT_RUNTIME_SECRET' | 'RETAINER_AGENT_FUNCTION' | 'RETAINER_AGENT_UPSTREAM'
  >,
): AgentTaskDriver | undefined {
  const secret = config.RETAINER_AGENT_RUNTIME_SECRET;
  if (!secret) return undefined;
  if (config.RETAINER_AGENT_FUNCTION) return new LambdaTaskDriver(config.RETAINER_AGENT_FUNCTION);
  if (config.RETAINER_AGENT_UPSTREAM)
    return new HttpTaskDriver(config.RETAINER_AGENT_UPSTREAM, secret);
  return undefined;
}
