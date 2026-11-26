import { type RuntimeApi, RuntimeApiError } from './api-client.js';
import { errorFields, logEvent } from './logger.js';
import { runTurn, type TurnOutcome } from './turn.js';

export type RunTaskDeps = {
  api: RuntimeApi;
  mastraUrl: string;
  pollIntervalMs?: number;
};

export type RunTaskInput = {
  sessionId: string;
  /** The delivery's job token (spec §9.3). */
  job: string;
  notAfter?: Date | undefined;
  build?: string | undefined;
};

/**
 * Runs one task job (spec §9.3): claims a turn with the job token, runs it
 * with native structured output and at most one repair turn, reads the
 * whole stream (nobody watches it), and closes with the answer, which ends
 * the task. A job delivered again continues the same session from its last
 * saved step instead of sending its first message again. Returns null when
 * the claim was refused: the job is no longer this delivery's to run.
 */
export async function runTask(deps: RunTaskDeps, input: RunTaskInput): Promise<TurnOutcome | null> {
  let claim: Awaited<ReturnType<RuntimeApi['claim']>>;
  try {
    claim = await deps.api.claim(input.sessionId, {
      job: input.job,
      ...(input.notAfter ? { notAfter: input.notAfter.toISOString() } : {}),
      ...(input.build ? { build: input.build } : {}),
    });
  } catch (error) {
    logEvent(
      error instanceof RuntimeApiError && error.status < 500 ? 'info' : 'warn',
      'task_claim_failed',
      {
        sessionId: input.sessionId,
        ...errorFields(error),
      },
    );
    return null;
  }
  if (!claim.task) throw new Error('the claim is not a task');
  const running = await runTurn(
    {
      api: deps.api,
      mastraUrl: deps.mastraUrl,
      ...(deps.pollIntervalMs ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    },
    {
      claim,
      text: claim.session.firstTurn ? claim.task.firstMessage : null,
      task: { outputSchema: claim.task.outputSchema, repaired: claim.task.repaired },
    },
  );
  // Read to its end: the turn's saves and its close follow the stream.
  const reader = running.stream.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  return running.done;
}
