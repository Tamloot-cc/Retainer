import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  Claim,
  ReportAnswer,
  StepReport,
  ToolAnswer,
  ToolPending,
  TurnState,
} from '../src/api-client.js';
import { BASE_SYSTEM_PROMPT } from '../src/prompt.js';
import type { PinnedTool } from '../src/tools.js';

export const RUNTIME_SECRET = 'test-runtime-secret';

export type FakeApiCall = { method: string; path: string; auth: string | undefined; body: unknown };

/**
 * A fake Retainer API with the runtime routes of the contract, for the
 * runtime's tests. Every call is recorded.
 */
export class FakeApi {
  readonly calls: FakeApiCall[] = [];
  #server: Server | undefined;
  url = '';
  generation = 0;
  turnToken = 'turn-token-1';
  turnState: TurnState = { status: 'running', current: true };
  claimError: { status: number; code: string } | undefined;
  firstTurn = true;
  tools: PinnedTool[] = [
    {
      kind: 'retainer',
      name: 'search',
      description: 'Search records, events and facts by keywords.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    { kind: 'web_search', name: 'web_search', maxUses: 10 },
  ];
  systemBlocks = [BASE_SYSTEM_PROMPT];
  addedParts: string[] = [
    'You are working for Dana Levi in the workspace Acme. Today is 2026-11-26.',
  ];
  limits = { maxSteps: 50, maxOutputTokens: 32000, maxToolCalls: 200, webMaxUses: 10 };
  deadlineMs = 14 * 60_000;
  /** Answers each report; may be slow. */
  reportAnswer: (report: StepReport) => Promise<ReportAnswer> | ReportAnswer = () => ({
    action: 'continue',
  });
  reportStatus = 200;
  /** The turn route's status: 401 when the turn's chat was deleted outright. */
  turnStatus = 200;
  toolAnswer: (
    name: string,
    input: unknown,
  ) => Promise<ToolAnswer | ToolPending> | ToolAnswer | ToolPending | 'fenced' = (
    _name,
    input,
  ) => ({ ok: true, output: { hits: [], echo: input } });

  async start(): Promise<this> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  /** Every claim handed out, oldest first. */
  readonly claimed: Claim[] = [];

  claimFor(sessionId: string): Claim {
    this.generation++;
    const claim: Claim = {
      turnToken: this.turnToken,
      turnId: crypto.randomUUID(),
      generation: this.generation,
      runId: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      deadline: new Date(Date.now() + this.deadlineMs).toISOString(),
      session: {
        id: sessionId,
        kind: 'chat',
        firstTurn: this.firstTurn,
        systemBlocks: this.systemBlocks,
        tools: this.tools,
      },
      addedParts: this.addedParts,
      limits: this.limits,
    };
    this.firstTurn = false;
    this.claimed.push(claim);
    return claim;
  }

  ofPath(suffix: string): FakeApiCall[] {
    return this.calls.filter((call) => call.path.endsWith(suffix));
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    const auth = req.headers.authorization?.replace(/^Bearer /, '');
    const path = req.url ?? '';
    this.calls.push({ method: req.method ?? '', path, auth, body });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const match = path.match(/^\/v1\/agent\/runtime\/sessions\/([^/]+)\/(.+)$/);
    if (!match) return json(404, { code: 'not_found' });
    const [, sessionId, rest] = match as unknown as [string, string, string];
    if (rest === 'claim') {
      if (auth !== RUNTIME_SECRET) return json(401, { code: 'unauthorized' });
      if (this.claimError) return json(this.claimError.status, { code: this.claimError.code });
      return json(200, this.claimFor(sessionId));
    }
    if (auth !== this.turnToken) return json(401, { code: 'unauthorized' });
    if (rest === 'report') {
      if (this.reportStatus !== 200) return json(this.reportStatus, { code: 'boom' });
      return json(200, await this.reportAnswer(body as StepReport));
    }
    if (rest === 'turn')
      return this.turnStatus === 200
        ? json(200, this.turnState)
        : json(this.turnStatus, { code: 'unauthorized' });
    if (rest === 'close') return json(200, { status: (body as { status: string }).status });
    if (rest.startsWith('tools/')) {
      const name = decodeURIComponent(rest.slice('tools/'.length));
      const answer = await this.toolAnswer(name, (body as { input: unknown }).input);
      if (answer === 'fenced') return json(409, { code: 'turn_cancelled' });
      return json(200, answer);
    }
    return json(404, { code: 'not_found' });
  }
}
