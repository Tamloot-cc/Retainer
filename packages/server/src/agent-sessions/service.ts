import { randomUUID } from 'node:crypto';
import {
  BASE_SYSTEM_PROMPT,
  createMastraStore,
  type MastraStoreHandle,
  readChatMessages,
} from '@retainer/agent';
import { z } from 'zod';
import {
  type AgentAccess,
  agentAccessOf,
  agentAccessSchema,
  agentCaller,
} from '../agent-runtime/access.js';
import { eraseAgentContent } from '../agent-runtime/erasure.js';
import {
  isRuntimeCredential,
  mintToken,
  parseToken,
  STREAM_TOKEN_PREFIX,
  secretMatches,
} from '../agent-runtime/tokens.js';
import {
  admitAgentTurn,
  CLOSE_STATUSES,
  cancelTurn,
  claimTurn,
  closeTurn,
  lockSession,
  turnCancelled,
  turnState,
  turnTokenWorkspace,
  verifyTurnToken,
} from '../agent-runtime/turns.js';
import type { Caller } from '../caller.js';
import { recheckElevation } from '../db/cli.js';
import type { Sql } from '../db/client.js';
import type { WorkspaceSettings } from '../db/schema.js';
import { inWorkspace, jsonValue, type Tx } from '../db/tx.js';
import { AppError, notFound } from '../errors.js';
import type { RuntimeCatalog } from '../extension-runtime/availability.js';
import type { ExtensionQueue } from '../extension-runtime/queue.js';
import { installedTools } from '../extensions/tools.js';
import { getSchema } from '../schema/compiled.js';
import { chatContext, datePart, workspaceDate } from './context.js';
import {
  CHAT_LIMITS,
  type ExtensionToolRef,
  pinnedTools,
  type RetainerToolHost,
  type RetainerToolResult,
} from './tools.js';

/** A stream token's life (agent spec §6.1, §7.3). */
const STREAM_TOKEN_MS = 15 * 60_000;
/** How long an extension tool's job may take (§8.1); never past the turn's deadline. */
const EXTENSION_CALL_MS = 5 * 60_000;
/**
 * How long one tool request waits for an extension job before answering
 * `pending`, inside API Gateway's 29 seconds. The runtime asks again with the
 * same tool call ID, which finds the same job.
 */
const EXTENSION_WAIT_MS = 20_000;
/** The model every agent session runs on (§3.4), for usage rows without one. */
const AGENT_MODEL = 'claude-sonnet-5-5';
const TITLE_LENGTH = 80;

export type AgentConfig = {
  /** RETAINER_AGENT_RUNTIME_SECRET: the runtime credential. */
  runtimeSecret: string;
  /** Hosted: the agent function URL's origin. Unset: the stream runs through this API. */
  agentOrigin?: string | undefined;
  /** RETAINER_MASTRA_DATABASE_URL: the read-only store for a chat's messages. */
  readStoreUrl?: string | undefined;
  personDailySteps: number;
  workspaceDailySteps: number;
  /** Key mode: an API key may open chats, since nobody signs in. */
  keys: boolean;
  /** How long one tool request waits for an extension job; tests shorten it. */
  extensionWaitMs?: number | undefined;
};

const unavailable = () =>
  new AppError(503, 'agent_unavailable', 'the workspace agent is not set up on this server');

type SessionRow = {
  id: string;
  workspace_id: string;
  kind: 'chat' | 'task';
  owner: string;
  person_id: string | null;
  title: string;
  tools: unknown[];
  extension_tools: Record<string, ExtensionToolRef>;
  system_blocks: string[];
  last_date: string | null;
  generation: number;
  limits: Record<string, number>;
  created_at: Date;
  last_active_at: Date;
};

const claimBody = z.strictObject({
  streamToken: z.string().min(1).max(500),
  /** The latest deadline the runtime's invocation allows (§6.3). */
  notAfter: z.iso.datetime().optional(),
  /** The agent function's build, for the hosted writer lease (§10.2). */
  build: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  /** The first message's start, kept when the chat has no title yet (§3.1). */
  title: z.string().max(1000).optional(),
});

const toolBody = z.strictObject({
  toolCallId: z.string().min(1).max(200),
  input: z.unknown().optional(),
});

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const reportBody = z.strictObject({
  stepId: z.string().min(1).max(200),
  usage: z.strictObject({ input: count, cacheRead: count, cacheWrite: count, output: count }),
  webSearches: count.nullable(),
  webFetches: count.nullable(),
  toolCalls: count,
  finishReason: z.string().max(100).optional(),
  rawFinishReason: z.string().max(100).nullable().optional(),
  model: z.string().min(1).max(200).optional(),
});

const closeBody = z.strictObject({
  status: z.enum(CLOSE_STATUSES as unknown as [string, ...string[]]),
  errorCode: z.string().max(100).nullable().optional(),
  durationMs: count,
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new AppError(400, 'invalid_request', parsed.error.issues[0]?.message ?? 'invalid body');
  return parsed.data;
}

/**
 * The workspace agent's sessions on the API (agent spec §6.1): a person's
 * chats, and the runtime routes the agent runtime calls for each turn. The
 * history itself lives in Mastra's tables, which only the runtime writes;
 * this module reads them for the chat read endpoint and erases them through
 * `agent-runtime`.
 */
export class AgentSessions {
  private store: MastraStoreHandle | undefined;
  constructor(
    private readonly sql: Sql,
    private readonly host: RetainerToolHost,
    private readonly config: AgentConfig,
    private readonly extensions: {
      catalog?: RuntimeCatalog | undefined;
      queue?: ExtensionQueue | undefined;
    } = {},
  ) {}

  /** Closes the read store's pool. */
  async dispose() {
    await this.store?.close();
    this.store = undefined;
  }

  private owner(caller: Caller) {
    const owned = agentAccessOf(caller, { keys: this.config.keys });
    if (!owned)
      throw new AppError(
        403,
        'forbidden',
        'Chats with the workspace agent are for people: sign in to the web app or use the Retainer CLI.',
      );
    if (!caller.scopes.includes('read') && !caller.scopes.includes('admin'))
      throw new AppError(403, 'forbidden', 'You need access to this workspace to chat in it.');
    return owned;
  }

  private async session(tx: Tx, owner: string, id: string, lock = false) {
    if (!z.uuid().safeParse(id).success) throw notFound('chat');
    const row = lock
      ? await lockSession<SessionRow>(tx, id)
      : (await tx<SessionRow[]>`select * from agent_sessions where id = ${id}`)[0];
    if (row?.kind !== 'chat' || row.owner !== owner) throw notFound('chat');
    return row;
  }

  // ------------------------------------------------------------------ chats

  /** Creates a chat with its tools and system blocks pinned (§3.5, §8.3). */
  async createChat(caller: Caller) {
    const owned = this.owner(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      const { tools, extensionTools } = await pinnedTools(
        tx,
        caller,
        this.host,
        this.extensions.catalog,
      );
      const [row] = await tx<SessionRow[]>`
        insert into agent_sessions (workspace_id, kind, owner, person_id, tools, extension_tools, system_blocks, limits)
        values (${caller.workspaceId}, 'chat', ${owned.owner}, ${owned.personId},
          ${tx.json(jsonValue(tools))}, ${tx.json(jsonValue(extensionTools))},
          ${tx.json([BASE_SYSTEM_PROMPT])}, ${tx.json(jsonValue(CHAT_LIMITS))})
        returning *`;
      if (!row) throw new Error('chat insert returned no row');
      return { id: row.id, title: row.title, createdAt: row.created_at.toISOString() };
    });
  }

  async listChats(caller: Caller) {
    const owned = this.owner(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      const rows = await tx<
        { id: string; title: string; created_at: Date; last_active_at: Date; running: boolean }[]
      >`
        select s.id, s.title, s.created_at, s.last_active_at,
          exists(select 1 from agent_turns t where t.session_id = s.id and t.status = 'running') as running
        from agent_sessions s where s.owner = ${owned.owner} and s.kind = 'chat'
        order by s.last_active_at desc, s.id desc limit 200`;
      return {
        chats: rows.map((row) => ({
          id: row.id,
          title: row.title,
          createdAt: row.created_at.toISOString(),
          lastActiveAt: row.last_active_at.toISOString(),
          status: row.running ? 'running' : 'idle',
        })),
      };
    });
  }

  /** The chat and its messages, without the parts the server added (§6.1). */
  async getChat(caller: Caller, id: string) {
    const owned = this.owner(caller);
    const chat = await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      const row = await this.session(tx, owned.owner, id);
      const [turn] = await tx<{ running: boolean }[]>`
        select exists(select 1 from agent_turns where session_id = ${id} and status = 'running') as running`;
      return { row, running: turn?.running === true };
    });
    if (!this.config.readStoreUrl) throw unavailable();
    this.store ??= createMastraStore({ connectionString: this.config.readStoreUrl, max: 2 });
    const messages = await readChatMessages(this.store, id);
    return { id: chat.row.id, title: chat.row.title, running: chat.running, messages };
  }

  /** A stream token: it can start a turn on this chat and nothing else (§7.3). */
  async streamToken(caller: Caller, id: string, origin: string) {
    const owned = this.owner(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await this.session(tx, owned.owner, id);
      // Refused at once for a person who has lost access.
      await agentCaller(tx, caller.workspaceId, owned.access);
      const tokenId = randomUUID();
      const { token, hash } = mintToken(STREAM_TOKEN_PREFIX, caller.workspaceId, tokenId);
      const [row] = await tx<{ expires_at: Date }[]>`
        insert into agent_stream_tokens (id, workspace_id, session_id, token_hash, access, expires_at)
        values (${tokenId}, ${caller.workspaceId}, ${id}, ${hash}, ${tx.json(owned.access)},
          clock_timestamp() + make_interval(secs => ${STREAM_TOKEN_MS / 1000}))
        returning expires_at`;
      const streamUrl = this.config.agentOrigin
        ? `${this.config.agentOrigin}/chats/${id}/stream`
        : `${origin}/v1/agent/chats/${id}/stream`;
      return { token, expiresAt: row?.expires_at.toISOString(), streamUrl };
    });
  }

  /** Stops a running turn (§6.5): fenced and recorded as `cancelled` at once. */
  async cancel(caller: Caller, id: string) {
    const owned = this.owner(caller);
    return inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await this.session(tx, owned.owner, id, true);
      return { cancelled: await cancelTurn(tx, id) };
    });
  }

  /** Deletes a chat: cancels its turn, erases its stored content, then the session (§5.4). */
  async deleteChat(caller: Caller, id: string) {
    const owned = this.owner(caller);
    await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await this.session(tx, owned.owner, id, true);
      await cancelTurn(tx, id);
      await eraseAgentContent(tx, caller.workspaceId, [id]);
      await tx`delete from agent_sessions where id = ${id}`;
    });
  }

  // --------------------------------------------------------- runtime routes

  /**
   * Claims a turn for the runtime (§6.2, §7.3): it presents the runtime
   * credential and the client's stream token, and gets a turn token, the run
   * ID, the pinned tools and system blocks, and any server-added parts. The
   * day's limits are checked first (§10.2).
   */
  async claim(credential: string | undefined, sessionId: string, body: unknown) {
    if (!isRuntimeCredential(this.config.runtimeSecret, credential))
      throw new AppError(401, 'unauthorized', 'the agent runtime credential is missing or wrong');
    const input = parse(claimBody, body);
    const parsed = parseToken(STREAM_TOKEN_PREFIX, input.streamToken);
    if (!parsed || !z.uuid().safeParse(sessionId).success)
      throw new AppError(401, 'unauthorized', 'the stream token is invalid or expired');
    const workspaceId = parsed.workspaceId;
    return inWorkspace(this.sql, workspaceId, async (tx) => {
      const [stream] = await tx<{ token_hash: string; access: unknown }[]>`
        select token_hash, access from agent_stream_tokens
        where id = ${parsed.id} and session_id = ${sessionId} and expires_at > clock_timestamp()`;
      if (!stream || !secretMatches(stream.token_hash, parsed.secret))
        throw new AppError(401, 'unauthorized', 'the stream token is invalid or expired');
      const access = agentAccessSchema.parse(stream.access);
      const session = await lockSession<SessionRow>(tx, sessionId);
      if (!session) throw notFound('chat');
      // Access follows the credential that minted the turn, as it is now (§6.7).
      const caller = await agentCaller(tx, workspaceId, access);
      await this.checkDay(tx, session);
      const claimed = await claimTurn(tx, workspaceId, {
        sessionId,
        access,
        ...(input.notAfter ? { notAfter: new Date(input.notAfter) } : {}),
        ...(input.build ? { build: input.build } : {}),
      });
      const addedParts = await this.addedParts(tx, session, caller, claimed.turn.generation === 1);
      const title = input.title?.replace(/\s+/g, ' ').trim().slice(0, TITLE_LENGTH);
      if (!session.title && title)
        await tx`update agent_sessions set title = ${title} where id = ${sessionId} and title = ''`;
      const { maxSteps, maxOutputTokens, maxToolCalls, webMaxUses } = sessionLimits(session);
      return {
        turnToken: claimed.token,
        turnId: claimed.turn.id,
        generation: claimed.turn.generation,
        runId: claimed.turn.run_id,
        deadline: claimed.turn.deadline.toISOString(),
        session: {
          id: session.id,
          kind: session.kind,
          firstTurn: claimed.turn.generation === 1,
          systemBlocks: session.system_blocks,
          tools: session.tools,
        },
        addedParts,
        limits: { maxSteps, maxOutputTokens, maxToolCalls, webMaxUses },
      };
    });
  }

  /** The per-chat context on the first turn, or "Today is …" on a later date (§3.5). */
  private async addedParts(tx: Tx, session: SessionRow, caller: Caller, first: boolean) {
    const [workspace] = await tx<{ name: string; settings: WorkspaceSettings }[]>`
      select name, settings from workspaces where id = ${session.workspace_id}`;
    const date = workspaceDate(new Date(), workspace?.settings.timeZone);
    if (!first && session.last_date === date.day) return [];
    await tx`update agent_sessions set last_date = ${date.day} where id = ${session.id}`;
    if (!first) return [datePart(date)];
    const schema = await getSchema(tx, session.workspace_id);
    const names = (ids: string[]) =>
      ids.map((id) => schema.objectsById.get(id)?.name).filter((name): name is string => !!name);
    return [
      chatContext({
        ownerName:
          caller.person?.name ?? caller.actor.name?.replace(/^Retainer agent for /, '') ?? '',
        personal: !!caller.person,
        workspaceName: workspace?.name ?? '',
        objects: names(schema.entityTypeIds),
        eventTypes: names(schema.eventTypeIds),
        date,
      }),
    ];
  }

  /** Agent steps already spent today, for the workspace and the chat's person (§10.1). */
  private async dayUse(tx: Tx, session: Pick<SessionRow, 'owner' | 'kind'>) {
    const rows = await tx<{ subject: string; steps: number }[]>`
      select subject, steps from agent_days
      where day = (now() at time zone 'utc')::date and subject in ('workspace', ${session.owner})`;
    const workspace = rows.find((row) => row.subject === 'workspace')?.steps ?? 0;
    const person =
      session.kind === 'chat' ? (rows.find((row) => row.subject === session.owner)?.steps ?? 0) : 0;
    return (
      workspace >= this.config.workspaceDailySteps ||
      (session.kind === 'chat' && person >= this.config.personDailySteps)
    );
  }

  private async checkDay(tx: Tx, session: SessionRow) {
    if (await this.dayUse(tx, session))
      throw new AppError(
        429,
        'limit_reached',
        "today's agent steps for this workspace or person are used up; try again tomorrow",
      );
  }

  /**
   * One Retainer or extension tool call (§8.1). Only tools pinned on the
   * session, under the caller's current access. A tool the caller can't use
   * now gives an error result for the model; a turn that was cancelled or
   * replaced gets 409 `turn_cancelled`, and the runtime aborts.
   */
  async tool(
    token: string,
    sessionId: string,
    name: string,
    body: unknown,
  ): Promise<RetainerToolResult | { pending: true }> {
    const workspaceId = turnTokenWorkspace(token);
    const input = parse(toolBody, body);
    const { verified, session } = await inWorkspace(this.sql, workspaceId, async (tx) => {
      const verified = await verifyTurnToken(tx, token, sessionId);
      if (!verified.live) throw turnCancelled();
      const [session] = await tx<
        SessionRow[]
      >`select * from agent_sessions where id = ${sessionId}`;
      if (!session) throw turnCancelled();
      return { verified, session };
    });
    const pinned = (session.tools as { kind: string; name: string }[]).find(
      (tool) => tool.name === name,
    );
    if (!pinned || (pinned.kind !== 'retainer' && pinned.kind !== 'extension'))
      return toolError('tool_not_available', `"${name}" is not one of this session's tools`);
    let caller: Caller;
    try {
      caller = await agentCaller(this.sql, workspaceId, verified.access, verified.binding);
    } catch (error) {
      if (error instanceof AppError) return toolError(error.code, error.message);
      throw error;
    }
    if (pinned.kind === 'retainer') {
      const result = await this.host.call(caller, name, input.input ?? {});
      if (!result.ok && result.error.code === 'turn_cancelled') throw turnCancelled();
      return result;
    }
    const ref = session.extension_tools[name];
    if (!ref) return toolError('extension_removed', `the tool "${name}" is no longer installed`);
    return this.extensionTool(caller, verified.access, verified.turn.deadline, ref, {
      toolCallId: input.toolCallId,
      input: input.input ?? {},
    });
  }

  /** An extension `read` tool, run as its own job through Retainer (§8.1), and waited for. */
  private async extensionTool(
    caller: Caller,
    access: AgentAccess,
    deadline: Date,
    ref: ExtensionToolRef,
    call: { toolCallId: string; input: unknown },
  ): Promise<RetainerToolResult | { pending: true }> {
    const { catalog, queue } = this.extensions;
    const binding = caller.agent;
    if (!catalog || !queue || !binding)
      return toolError('tool_unavailable', 'extension tools are not available on this server');
    const until = new Date(Math.min(deadline.getTime(), Date.now() + EXTENSION_CALL_MS));
    const started = await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
      await admitAgentTurn(tx, binding);
      if (access.kind === 'cli') {
        try {
          await recheckElevation(tx, binding.cli, 'editor');
        } catch (error) {
          if (error instanceof AppError) return toolError(error.code, error.message);
          throw error;
        }
      }
      const tool = (await installedTools(tx, catalog)).find(
        (entry) => entry.registrationId === ref.registrationId && entry.name === ref.tool,
      );
      if (!tool || tool.status === 'conflict')
        return toolError('extension_removed', `the tool "${ref.tool}" is no longer installed`);
      if (tool.effect !== 'read')
        return toolError('tool_not_available', 'only extension tools that read are available');
      let connectionId: string | null = null;
      if (tool.connection === 'member') {
        const [connection] = caller.person
          ? await tx<{ id: string }[]>`
              select id from extension_connections where installation_id = ${tool.installationId}
                and owner_id = ${caller.person.id} and state = 'active'`
          : [];
        if (!connection)
          return toolError('tool_not_connected', 'connect your account to use this tool');
        connectionId = connection.id;
      } else if (tool.status !== 'ready') {
        return toolError('tool_not_connected', `the tool "${ref.tool}" is not connected`);
      }
      try {
        // The same tool call ID finds the same job: asking again after `pending` waits on.
        const jobId = await queue.enqueueTool(tx, caller.workspaceId, {
          installationId: tool.installationId,
          connectionId,
          functionId: tool.functionId,
          input: call.input,
          dedupeKey: `agent:${binding.turnId}:${call.toolCallId}`,
          cause: [],
          depth: 1,
          expiresAt: until,
          callerUserId: connectionId ? (caller.person?.id ?? null) : null,
        });
        return { jobId };
      } catch (error) {
        if (error instanceof AppError && error.status < 500)
          return toolError(error.code, error.message);
        throw error;
      }
    });
    if ('ok' in started) return started;
    const waitUntil = Date.now() + (this.config.extensionWaitMs ?? EXTENSION_WAIT_MS);
    for (;;) {
      const polled = await inWorkspace(this.sql, caller.workspaceId, async (tx) => {
        await admitAgentTurn(tx, binding);
        const [job] = await tx<{ status: string; code: string | null; output: unknown }[]>`
          select status, code, output from extension_jobs where id = ${started.jobId}`;
        return job;
      });
      if (!polled) return toolError('tool_failed', 'the tool call disappeared');
      if (polled.status === 'succeeded') return { ok: true, output: polled.output ?? null };
      if (polled.status !== 'queued' && polled.status !== 'running')
        return toolError(polled.code ?? 'tool_failed', 'the tool call failed');
      if (Date.now() >= waitUntil) return { pending: true };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /**
   * One step's usage (§10.2): counted once per step ID against the turn, the
   * workspace's day and the person's, written to `ai_usage`, and answered
   * `continue` or `stop`. A late report from an older claim still counts, and
   * is answered `stop`.
   */
  async report(token: string, sessionId: string, body: unknown) {
    const workspaceId = turnTokenWorkspace(token);
    const input = parse(reportBody, body);
    return inWorkspace(this.sql, workspaceId, async (tx) => {
      const verified = await verifyTurnToken(tx, token, sessionId, { lock: true });
      const { turn } = verified;
      const [session] = await tx<
        SessionRow[]
      >`select * from agent_sessions where id = ${sessionId}`;
      if (!session) throw notFound('session');
      const carries = (kind: string) =>
        (session.tools as { kind: string }[]).some((tool) => tool.kind === kind);
      const limits = sessionLimits(session);
      const allowance = limits.webMaxUses;
      // Missing counts charge the whole allowance of a web tool the session carries.
      const searches = input.webSearches ?? (carries('web_search') ? allowance : 0);
      const fetches = input.webFetches ?? (carries('web_fetch') ? allowance : 0);
      const inserted = await tx`
        insert into ai_usage (workspace_id, kind, attempt, model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, usage, partial, agent_session_id, agent_turn_id,
          agent_step_id, user_id)
        values (${turn.workspace_id}, 'agent', 1, ${input.model ?? AGENT_MODEL}, ${input.usage.input},
          ${input.usage.output}, ${input.usage.cacheRead}, ${input.usage.cacheWrite},
          ${tx.json({
            server_tool_use: { web_search_requests: searches, web_fetch_requests: fetches },
            tool_calls: input.toolCalls,
            ...(input.finishReason ? { finish_reason: input.finishReason } : {}),
            ...(input.rawFinishReason ? { raw_finish_reason: input.rawFinishReason } : {}),
          })}, false, ${session.id}, ${turn.id}, ${input.stepId}, ${session.person_id})
        on conflict (agent_session_id, agent_step_id) where kind = 'agent' do nothing
        returning id`;
      let totals = turn;
      if (inserted.length > 0) {
        const [updated] = await tx<(typeof turn)[]>`
          update agent_turns set steps = steps + 1, tool_calls = tool_calls + ${input.toolCalls},
            web_searches = web_searches + ${searches}, web_fetches = web_fetches + ${fetches},
            input_tokens = input_tokens + ${input.usage.input},
            output_tokens = output_tokens + ${input.usage.output},
            cache_read_tokens = cache_read_tokens + ${input.usage.cacheRead},
            cache_write_tokens = cache_write_tokens + ${input.usage.cacheWrite}
          where id = ${turn.id} returning *`;
        if (updated) totals = updated;
        const subjects = session.kind === 'chat' ? ['workspace', session.owner] : ['workspace'];
        for (const subject of subjects)
          await tx`
            insert into agent_days (workspace_id, day, subject, steps)
            values (${turn.workspace_id}, (now() at time zone 'utc')::date, ${subject}, 1)
            on conflict (workspace_id, day, subject) do update set steps = agent_days.steps + 1`;
      }
      if (!verified.live)
        return {
          action: 'stop' as const,
          reason: turn.status === 'cancelled' ? ('cancelled' as const) : ('stale' as const),
        };
      const over =
        totals.steps >= limits.maxSteps ||
        totals.tool_calls >= limits.maxToolCalls ||
        totals.web_searches >= limits.webSearches ||
        totals.web_fetches >= limits.webFetches ||
        (await this.dayUse(tx, session));
      return over
        ? { action: 'stop' as const, reason: 'limit_reached' as const }
        : { action: 'continue' as const };
    });
  }

  turn(token: string, sessionId: string) {
    return turnState(this.sql, token, sessionId);
  }

  close(token: string, sessionId: string, body: unknown) {
    turnTokenWorkspace(token);
    const input = parse(closeBody, body);
    return closeTurn(this.sql, token, sessionId, {
      status: input.status as (typeof CLOSE_STATUSES)[number],
      errorCode: input.errorCode ?? null,
      durationMs: input.durationMs,
    });
  }
}

/** A session's limits: the chat defaults, lowered where the session says so (§10.1). */
function sessionLimits(session: Pick<SessionRow, 'limits'>) {
  return { ...CHAT_LIMITS, ...session.limits };
}

function toolError(code: string, message: string): RetainerToolResult {
  return { ok: false, error: { code, message } };
}
