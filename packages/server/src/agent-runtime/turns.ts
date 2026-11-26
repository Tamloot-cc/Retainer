import { randomUUID } from 'node:crypto';
import type { AgentBinding } from '../caller.js';
import type { Sql } from '../db/client.js';
import { inWorkspace, type Tx } from '../db/tx.js';
import { AppError } from '../errors.js';
import { type AgentAccess, agentAccessSchema } from './access.js';
import { mintToken, parseToken, secretMatches, TURN_TOKEN_PREFIX } from './tokens.js';

/**
 * The turn lease (agent spec §6.3). A session runs at most one turn at a
 * time. A claim gives the turn the session's next **generation** and a
 * **deadline**: 14 minutes, or less when the runtime's invocation or a
 * task's expiry ends sooner. Every call the runtime makes carries the turn
 * token, and the API refuses one from a turn that is no longer the
 * session's running one, so a late call from an old invocation can't land
 * after a new claim.
 */

/** A chat turn's and a task job's lease (§6.3, §9.3). */
export const TURN_MS = 14 * 60_000;
/** How long past its deadline a turn token may still report and close its own turn (§6.3). */
export const GRACE_MS = 60_000;

export const TURN_STATUSES = [
  'running',
  'completed',
  'refused',
  'incomplete',
  'context_limit_reached',
  'model_unavailable',
  'history_rejected',
  'limit_reached',
  'cancelled',
  'timed_out',
  'failed',
] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];
/** What the runtime may close a turn as: any end, `timed_out` included when it cuts at its deadline. */
export const CLOSE_STATUSES = TURN_STATUSES.filter(
  (status): status is Exclude<TurnStatus, 'running'> => status !== 'running',
);

export const turnCancelled = (message = 'this turn was cancelled or replaced') =>
  new AppError(409, 'turn_cancelled', message);
const invalidTurnToken = () =>
  new AppError(401, 'unauthorized', 'the turn credential is invalid or expired');

export type TurnRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  generation: number;
  status: TurnStatus;
  run_id: string;
  message_id: string | null;
  token_hash: string;
  access: unknown;
  claimed_at: Date;
  deadline: Date;
  stopped_at: Date | null;
  finished_at: Date | null;
  lease_id: string | null;
  lease_build: string | null;
  steps: number;
  tool_calls: number;
  web_searches: number;
};

/** A verified turn token: its turn, whether it is the session's live one, and its credential. */
export type VerifiedTurn = {
  workspaceId: string;
  turn: TurnRow;
  /** The session's current generation is this turn's, and no newer claim exists. */
  current: boolean;
  /** Running, current and before its deadline: it may call tools. */
  live: boolean;
  access: AgentAccess;
  binding: AgentBinding;
};

/**
 * Checks a turn token inside a workspace transaction. A token is good until
 * its turn's deadline plus the grace; after that it opens nothing.
 */
export async function verifyTurnToken(
  tx: Tx,
  token: string,
  sessionId: string,
  options: { lock?: boolean } = {},
): Promise<VerifiedTurn> {
  const parsed = parseToken(TURN_TOKEN_PREFIX, token);
  if (!parsed) throw invalidTurnToken();
  const [turn] = await tx<
    (TurnRow & { session_generation: number; expired: boolean; live: boolean })[]
  >`
    select t.*, s.generation as session_generation,
      t.deadline + make_interval(secs => ${GRACE_MS / 1000}) <= clock_timestamp() as expired,
      t.deadline > clock_timestamp() as live
    from agent_turns t join agent_sessions s on s.id = t.session_id
    where t.id = ${parsed.id} and t.session_id = ${sessionId}
    ${options.lock ? tx`for update of t` : tx``}`;
  if (!turn || turn.expired || !secretMatches(turn.token_hash, parsed.secret))
    throw invalidTurnToken();
  const current = turn.session_generation === turn.generation;
  const access = agentAccessSchema.parse(turn.access);
  return {
    workspaceId: parsed.workspaceId,
    turn,
    current,
    live: current && turn.status === 'running' && turn.live,
    access,
    binding: {
      sessionId: turn.session_id,
      turnId: turn.id,
      generation: turn.generation,
      ...(access.kind === 'cli' ? { cli: { userId: access.userId, loginId: access.loginId } } : {}),
    },
  };
}

/** The workspace a turn token names, to open its transaction; checked by `verifyTurnToken`. */
export function turnTokenWorkspace(token: string): string {
  const parsed = parseToken(TURN_TOKEN_PREFIX, token);
  if (!parsed) throw invalidTurnToken();
  return parsed.workspaceId;
}

export type ClaimInput = {
  sessionId: string;
  access: AgentAccess;
  /** The runtime's own bound: its invocation's remaining time less its final writes (§6.3). */
  notAfter?: Date;
  /** The agent function's build, for the hosted writer lease (§10.2). */
  build?: string;
};

export type ClaimedTurn = {
  turn: TurnRow;
  token: string;
  /** The turn this claim closed as `timed_out`, if any. */
  timedOut: string | null;
};

/**
 * Claims a session's next turn, inside the caller's transaction, which holds
 * the session row locked (`lockSession`). Refused with `turn_running` while a
 * turn runs, and with `turn_stopping` after a cancel until the old runtime has
 * closed its turn or its deadline plus the grace has passed, so steps of two
 * turns never interleave in Mastra's store (§5.2). A running turn past its
 * deadline plus the grace is closed as `timed_out` first.
 */
export async function claimTurn(
  tx: Tx,
  workspaceId: string,
  input: ClaimInput,
): Promise<ClaimedTurn> {
  const [last] = await tx<(TurnRow & { past_grace: boolean })[]>`
    select *, deadline + make_interval(secs => ${GRACE_MS / 1000}) <= clock_timestamp() as past_grace
    from agent_turns where session_id = ${input.sessionId}
    order by generation desc limit 1 for update`;
  let timedOut: string | null = null;
  if (last) {
    if (last.status === 'running') {
      if (!last.past_grace)
        throw new AppError(409, 'turn_running', 'a turn is already running in this chat');
      await tx`update agent_turns set status = 'timed_out', error_code = 'timed_out',
        finished_at = clock_timestamp() where id = ${last.id}`;
      timedOut = last.id;
    } else if (!last.stopped_at && !last.past_grace) {
      throw new AppError(
        409,
        'turn_stopping',
        'the last turn is still stopping; try again in a few seconds',
      );
    }
  }
  const [session] = await tx<{ generation: number }[]>`
    update agent_sessions set generation = generation + 1, last_active_at = clock_timestamp()
    where id = ${input.sessionId} returning generation`;
  if (!session) throw new AppError(404, 'not_found', 'chat not found');
  const id = randomUUID();
  const { token, hash } = mintToken(TURN_TOKEN_PREFIX, workspaceId, id);
  const cap = input.notAfter ?? null;
  const [turn] = await tx<TurnRow[]>`
    insert into agent_turns (id, workspace_id, session_id, generation, run_id, message_id, token_hash, access, deadline)
    values (${id}, ${workspaceId}, ${input.sessionId}, ${session.generation}, ${randomUUID()}, ${randomUUID()}, ${hash},
      ${tx.json(input.access)},
      least(clock_timestamp() + make_interval(secs => ${TURN_MS / 1000}), coalesce(${cap}::timestamptz, 'infinity')))
    returning *`;
  if (!turn) throw new Error('claim insert returned no row');
  if (turn.deadline.getTime() <= Date.now())
    throw new AppError(409, 'deadline_passed', 'no time is left for a turn in this invocation');
  if (input.build) {
    // One hosted writer lease for the whole turn (§10.2): a deploy waits for
    // it, or for its `until` after a hard death. It names no external effect.
    const remaining = Math.min(
      910_000,
      Math.max(1, turn.deadline.getTime() + GRACE_MS - Date.now()),
    );
    const [lease] = await tx<{ state: string }[]>`
      select retainer_deploy.acquire_writer(${id}::uuid, ${remaining}::int, ${input.build}, null, null) as state`;
    if (lease?.state === 'denied')
      throw new AppError(503, 'maintenance', 'the agent is paused for a deploy; try again shortly');
    if (lease?.state === 'leased') {
      await tx`update agent_turns set lease_id = ${id}, lease_build = ${input.build} where id = ${id}`;
      turn.lease_id = id;
      turn.lease_build = input.build;
    }
  }
  return { turn, token, timedOut };
}

/** Locks a session row for a claim, cancel or delete; the turn lock order starts here. */
export async function lockSession<T extends Record<string, unknown>>(
  tx: Tx,
  sessionId: string,
): Promise<T | undefined> {
  const [row] = await tx<T[]>`select * from agent_sessions where id = ${sessionId} for update`;
  return row;
}

/**
 * Fences a session's running turn (§6.5): a new generation, so its token
 * is refused from now on, and `cancelled` recorded at once. The runtime
 * notices within 5 seconds and closes, which only records that it stopped.
 * Returns whether a turn was running.
 */
export async function cancelTurn(tx: Tx, sessionId: string): Promise<boolean> {
  const cancelled = await tx`
    update agent_turns set status = 'cancelled', error_code = 'cancelled', finished_at = clock_timestamp()
    where session_id = ${sessionId} and status = 'running' returning id`;
  if (cancelled.length === 0) return false;
  await tx`update agent_sessions set generation = generation + 1 where id = ${sessionId}`;
  return true;
}

/** Releases a turn's hosted writer lease once its runtime has stopped. */
async function releaseLease(tx: Tx, turn: Pick<TurnRow, 'lease_id' | 'lease_build'>) {
  if (turn.lease_id && turn.lease_build)
    await tx`select retainer_deploy.release_writer(${turn.lease_id}::uuid, ${turn.lease_build})`;
}

export type CloseInput = {
  status: (typeof CLOSE_STATUSES)[number];
  errorCode: string | null;
  durationMs: number;
};

/**
 * The runtime's close (§6.2, §6.3). A turn the API already ended (cancelled
 * or timed out) only records that its runtime stopped, which ends
 * `turn_stopping`. A running turn takes the runtime's status, if no newer
 * claim exists; a close from an older claim is refused.
 */
export async function closeTurn(
  sql: Sql,
  token: string,
  sessionId: string,
  input: CloseInput,
  /** Runs in the close's transaction; `closed` is whether this close ended the running turn. */
  after?: (tx: Tx, closed: boolean) => Promise<void>,
): Promise<{ status: TurnStatus }> {
  return inWorkspace(sql, turnTokenWorkspace(token), async (tx) => {
    const verified = await verifyTurnToken(tx, token, sessionId, { lock: true });
    const { turn } = verified;
    if (turn.status === 'running' && !verified.current)
      throw new AppError(409, 'stale', 'a newer turn replaced this one');
    if (turn.status === 'running') {
      await tx`update agent_turns set status = ${input.status}, error_code = ${input.errorCode},
        duration_ms = ${input.durationMs}, finished_at = clock_timestamp(), stopped_at = clock_timestamp()
        where id = ${turn.id}`;
    } else if (!turn.stopped_at) {
      await tx`update agent_turns set stopped_at = clock_timestamp(),
        duration_ms = coalesce(duration_ms, ${input.durationMs}) where id = ${turn.id}`;
    }
    await releaseLease(tx, turn);
    const status = turn.status === 'running' ? input.status : turn.status;
    await after?.(tx, turn.status === 'running');
    return { status };
  });
}

/** The turn's state, for the runtime's poll (§6.5). */
export async function turnState(sql: Sql, token: string, sessionId: string) {
  return inWorkspace(sql, turnTokenWorkspace(token), async (tx) => {
    const verified = await verifyTurnToken(tx, token, sessionId);
    const { status } = verified.turn;
    // `closed` once the runtime's own close was recorded for a turn it ended.
    return {
      status:
        status === 'running' || status === 'cancelled' || status === 'timed_out'
          ? status
          : 'closed',
      current: verified.current,
    };
  });
}

/**
 * Closes turns whose runtime vanished: running past their deadline plus the
 * grace (§6.3). The next claim does the same for its own session; this is the
 * sweep for sessions nobody claims again.
 */
export async function timeOutTurns(tx: Tx): Promise<number> {
  const rows = await tx`
    update agent_turns set status = 'timed_out', error_code = 'timed_out', finished_at = clock_timestamp()
    where status = 'running'
      and deadline + make_interval(secs => ${GRACE_MS / 1000}) <= clock_timestamp()
    returning id`;
  return rows.length;
}

/**
 * Re-checks the turn inside a write's own transaction (§5.2): a write from a
 * cancelled, timed-out or replaced turn is refused. A turn minted from the
 * CLI login also needs that login's elevation in the workspace for each
 * write (§6.7), checked by the caller with `recheckElevation`.
 */
export async function admitAgentTurn(tx: Tx, binding: AgentBinding): Promise<void> {
  const [row] = await tx<{ ok: boolean }[]>`
    select t.status = 'running' and t.generation = ${binding.generation}
      and s.generation = t.generation and t.deadline > clock_timestamp() as ok
    from agent_turns t join agent_sessions s on s.id = t.session_id
    where t.id = ${binding.turnId} and t.session_id = ${binding.sessionId}
    for share of t`;
  if (!row?.ok) throw turnCancelled();
  // A task's grant is bound to its waiting parent (spec §9.2): a run that was
  // cancelled, erased or expired, or replayed past the effect, ends it.
  if (binding.task) {
    const [grant] = await tx<{ ok: boolean }[]>`
      select t.state = 'running' and t.expires_at > clock_timestamp() and (
        (t.caller_kind = 'routine' and exists (
          select 1 from routine_runs r join routine_run_results x on x.run_id = r.id
          where r.id = t.routine_run_id and r.status = 'waiting'
            and x.position = t.position and x.agent_task_id = t.session_id and x.state = 'started'))
        or (t.caller_kind = 'extension' and exists (
          select 1 from extension_jobs j where j.id = t.extension_job_id and j.status = 'waiting'
            and j.agent_task_id = t.session_id))
      ) as ok
      from agent_tasks t where t.session_id = ${binding.sessionId} for share of t`;
    if (!grant?.ok) throw turnCancelled("the task's caller no longer waits for it");
  }
}
