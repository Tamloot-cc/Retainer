import type { PinnedTool } from './tools.js';

/** Statuses a turn can be closed with (contract: "close"). */
export type TurnCloseStatus =
  | 'completed'
  | 'refused'
  | 'incomplete'
  | 'context_limit_reached'
  | 'model_unavailable'
  | 'history_rejected'
  | 'limit_reached'
  | 'cancelled'
  | 'failed';

export type TurnLimits = {
  maxSteps: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  webMaxUses: number;
};

export type Claim = {
  turnToken: string;
  turnId: string;
  generation: number;
  runId: string;
  deadline: string;
  session: {
    id: string;
    kind: 'chat' | 'task';
    firstTurn: boolean;
    systemBlocks: string[];
    tools: PinnedTool[];
  };
  addedParts: string[];
  limits: TurnLimits;
};

export type StepReport = {
  stepId: string;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number };
  webSearches: number | null;
  webFetches: number | null;
  toolCalls: number;
  finishReason: string;
  rawFinishReason: string | null;
};

export type ReportAnswer = { action: 'continue' | 'stop'; reason?: string };

export type ToolAnswer =
  | { ok: true; output: unknown }
  | { ok: false; error: { code: string; message: string } };

export type TurnState = {
  status: 'running' | 'cancelled' | 'timed_out' | 'closed';
  current: boolean;
};

/** An API answer that isn't 2xx, with the API's error code. */
export class RuntimeApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Retainer API answered ${status} ${code}`);
    this.name = 'RuntimeApiError';
  }
}

/** A tool call the API fenced: the turn was cancelled, timed out or replaced. */
export class TurnFencedError extends Error {
  constructor(readonly code: string) {
    super(`turn fenced: ${code}`);
    this.name = 'TurnFencedError';
  }
}

type Fetch = typeof fetch;

/**
 * The agent runtime's client for Retainer's runtime routes (spec §6.1).
 * It never logs bodies: they carry CRM content.
 */
export class RuntimeApi {
  readonly #origin: string;
  readonly #runtimeSecret: string;
  readonly #fetch: Fetch;

  constructor(options: { origin: string; runtimeSecret: string; fetch?: Fetch }) {
    this.#origin = options.origin.replace(/\/+$/, '');
    this.#runtimeSecret = options.runtimeSecret;
    this.#fetch = options.fetch ?? fetch;
  }

  #url(sessionId: string, path: string): string {
    return `${this.#origin}/v1/agent/runtime/sessions/${encodeURIComponent(sessionId)}/${path}`;
  }

  async #call<T>(
    method: 'GET' | 'POST',
    url: string,
    bearer: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: T }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json: json as T };
  }

  static #code(json: unknown, fallback: string): string {
    const code = (json as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : fallback;
  }

  /** Trades a stream token, with the runtime credential, for a turn (spec §7.3). */
  async claim(sessionId: string, body: { streamToken: string; title?: string }): Promise<Claim> {
    const { status, json } = await this.#call<Claim>(
      'POST',
      this.#url(sessionId, 'claim'),
      this.#runtimeSecret,
      body,
      15_000,
    );
    if (status !== 200) throw new RuntimeApiError(status, RuntimeApi.#code(json, 'claim_failed'));
    return json;
  }

  async tool(
    sessionId: string,
    turnToken: string,
    name: string,
    body: { toolCallId: string; input: unknown },
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<ToolAnswer> {
    const { status, json } = await this.#call<ToolAnswer>(
      'POST',
      this.#url(sessionId, `tools/${encodeURIComponent(name)}`),
      turnToken,
      body,
      options.timeoutMs,
      options.signal,
    );
    if (status === 409) throw new TurnFencedError(RuntimeApi.#code(json, 'turn_cancelled'));
    if (status !== 200) throw new RuntimeApiError(status, RuntimeApi.#code(json, 'tool_failed'));
    return json;
  }

  async report(sessionId: string, turnToken: string, report: StepReport): Promise<ReportAnswer> {
    const { status, json } = await this.#call<ReportAnswer>(
      'POST',
      this.#url(sessionId, 'report'),
      turnToken,
      report,
      10_000,
    );
    if (status !== 200) throw new RuntimeApiError(status, RuntimeApi.#code(json, 'report_failed'));
    return json;
  }

  async turn(sessionId: string, turnToken: string): Promise<TurnState> {
    const { status, json } = await this.#call<TurnState>(
      'GET',
      this.#url(sessionId, 'turn'),
      turnToken,
      undefined,
      2_000,
    );
    if (status !== 200) throw new RuntimeApiError(status, RuntimeApi.#code(json, 'turn_failed'));
    return json;
  }

  async close(
    sessionId: string,
    turnToken: string,
    body: { status: TurnCloseStatus; errorCode: string | null; durationMs: number },
  ): Promise<{ status: string }> {
    const { status, json } = await this.#call<{ status: string }>(
      'POST',
      this.#url(sessionId, 'close'),
      turnToken,
      body,
      10_000,
    );
    if (status !== 200) throw new RuntimeApiError(status, RuntimeApi.#code(json, 'close_failed'));
    return json;
  }
}
