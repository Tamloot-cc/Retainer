import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANTHROPIC_PROVIDER_OPTIONS } from '../src/agent.js';
import { RuntimeApi, type StepReport } from '../src/api-client.js';
import { setLogSink } from '../src/logger.js';
import { runTurn } from '../src/turn.js';
import { createMastraTestDatabase, type MastraTestDatabase } from './db.js';
import { FakeApi, RUNTIME_SECRET } from './fake-api.js';

/**
 * The "PR 1 checks" of docs/specs/agent.md §17 against the real Anthropic API.
 * Off unless RETAINER_AGENT_LIVE=1, since it spends money and needs the key:
 *   RETAINER_AGENT_LIVE=1 pnpm --filter @retainer/agent exec vitest run test/live.test.ts
 * Writes what it measured to RETAINER_AGENT_LIVE_OUT when that is set, the
 * runtime's (content-free) log lines to RETAINER_AGENT_DEBUG, and sends the
 * model requests through RETAINER_AGENT_LIVE_BASE_URL (a recording proxy).
 */
const live = process.env.RETAINER_AGENT_LIVE === '1';

describe.skipIf(!live)('PR 1 checks against Anthropic', () => {
  let db: MastraTestDatabase;
  let api: FakeApi;
  let client: RuntimeApi;
  const results: Record<string, unknown> = {};

  beforeAll(async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    // A recording proxy in front of Anthropic, when diagnosing the cache.
    if (process.env.RETAINER_AGENT_LIVE_BASE_URL) {
      process.env.ANTHROPIC_BASE_URL = process.env.RETAINER_AGENT_LIVE_BASE_URL;
    }
    setLogSink(
      process.env.RETAINER_AGENT_DEBUG
        ? (line) =>
            process
              .getBuiltinModule('node:fs')
              .appendFileSync(process.env.RETAINER_AGENT_DEBUG as string, `${line}\n`)
        : () => {},
    );
    db = await createMastraTestDatabase();
    api = await new FakeApi().start();
    client = new RuntimeApi({ origin: api.url, runtimeSecret: RUNTIME_SECRET });
    api.limits = { ...api.limits, maxSteps: 8, maxOutputTokens: 4000 };
  });
  /**
   * Sonnet 5.5 at the runtime's `medium` effort rarely thinks on prompts this
   * small, so the thinking checks raise it to `max` to get a thinking block.
   */
  const withEffort = async <T>(effort: string, run: () => Promise<T>) => {
    const options = ANTHROPIC_PROVIDER_OPTIONS as unknown as { effort: string };
    const before = options.effort;
    options.effort = effort;
    try {
      return await run();
    } finally {
      options.effort = before;
    }
  };
  /** Pinned tools without the web tools, for the checks that don't need them. */
  const withoutWeb = () => {
    api.tools = api.tools.filter((tool) => tool.kind !== 'web_search' && tool.kind !== 'web_fetch');
  };
  const webTools = (kinds: Array<'web_search' | 'web_fetch'>) => {
    withoutWeb();
    for (const kind of kinds) api.tools.push({ kind, name: kind, maxUses: 10 });
  };
  afterAll(async () => {
    if (process.env.RETAINER_AGENT_LIVE_OUT) {
      writeFileSync(process.env.RETAINER_AGENT_LIVE_OUT, `${JSON.stringify(results, null, 2)}\n`);
    }
    await api?.stop();
    await db?.drop();
  });

  const reports = (from: number) =>
    api
      .ofPath('/report')
      .slice(from)
      .map((call) => call.body as StepReport);

  async function turn(sessionId: string, text: string) {
    const before = api.ofPath('/report').length;
    const claim = await client.claim(sessionId, { streamToken: 'stream-token' });
    const running = await runTurn({ api: client, mastraUrl: db.mastraUrl }, { claim, text });
    const sse = await new Response(running.stream).text();
    const outcome = await running.done;
    return { outcome, sse, reports: reports(before) };
  }

  it('round-trips thinking through Mastra, reads raw stop reasons, and caches', async () => {
    api.toolAnswer = (_name, input) => ({
      ok: true,
      output: {
        hits: [
          {
            type: 'record',
            object: 'company',
            name: 'Acme Robotics',
            note: `Series A of $12M led by Northwind Ventures, closed 2026-09-14 (query ${JSON.stringify(input)})`,
          },
        ],
      },
    });
    withoutWeb();
    const sessionId = crypto.randomUUID();
    const first = await withEffort('max', () =>
      turn(
        sessionId,
        'Use the search tool to find what we know about Acme Robotics. Then count the integer solutions (x, y) with 1 <= x <= y <= 60 of 1/x + 1/y = 1/12, verifying each. Answer in two sentences: the round, and the count.',
      ),
    );
    const second = await turn(sessionId, 'And who led that round? One short sentence.');
    const third = await turn(sessionId, 'Thanks. Reply with just "ok".');
    results.roundTrip = {
      first: { outcome: first.outcome, reports: first.reports },
      second: { outcome: second.outcome, reports: second.reports },
      third: { outcome: third.outcome, reports: third.reports },
    };
    expect(first.outcome.status).toBe('completed');
    expect(second.outcome.status).toBe('completed');
    expect(third.outcome.status).toBe('completed');
    expect(first.reports.map((r) => r.rawFinishReason)).toContain('tool_use');
    expect(first.reports.at(-1)?.rawFinishReason).toBe('end_turn');
    const stored = await db.query(
      `select count(*)::int as n from mastra.mastra_messages
       where thread_id = $1 and content::text like '%"signature"%'`,
      [sessionId],
    );
    results.roundTrip = {
      ...(results.roundTrip as object),
      reasoningStreamed: first.sse.includes('reasoning-delta'),
      messagesWithSignatures: stored.rows[0]?.n,
    };
    expect(stored.rows[0]?.n).toBeGreaterThan(0);
  }, 180_000);

  it('accepts a request whose earlier message changed, with drop_block', async () => {
    withoutWeb();
    const sessionId = crypto.randomUUID();
    api.toolAnswer = () => ({ ok: true, output: { hits: [] } });
    const first = await turn(
      sessionId,
      'Use the search tool once for "Globex". Then think it through: if it found nothing, list three careful reasons why a CRM search might miss a company, and pick the likeliest.',
    );
    // Change the person's first message under the stored thinking blocks.
    await db.query(
      `update mastra.mastra_messages set content = replace(content::text, 'Globex', 'Initech')::json
       where thread_id = $1 and role = 'user'`,
      [sessionId],
    );
    const second = await turn(sessionId, 'Say "done".');
    results.dropBlock = { first: first.outcome, second: second.outcome, reports: second.reports };
    expect(second.outcome.status).toBe('completed');
  }, 120_000);

  it('runs Anthropic web search and fetch without a container', async () => {
    const outcomes: Record<string, unknown> = {};
    for (const kinds of [['web_search'], ['web_fetch'], ['web_search', 'web_fetch']] as const) {
      webTools([...kinds]);
      const result = await turn(
        crypto.randomUUID(),
        kinds.includes('web_search')
          ? 'Search the web for the Anthropic homepage and tell me its page title in five words or fewer.'
          : 'Fetch https://www.anthropic.com and tell me its page title in five words or fewer.',
      );
      outcomes[kinds.join('+')] = { outcome: result.outcome, reports: result.reports };
    }
    results.web = outcomes;
    expect(Object.keys(outcomes)).toHaveLength(3);
  }, 300_000);

  it('records which Mastra tables a turn writes', async () => {
    const { rows } = await db.query(
      `select relname as table, n_live_tup as rows from pg_stat_user_tables
       where schemaname = 'mastra' order by relname`,
    );
    const counts: Record<string, number> = {};
    for (const table of [
      'mastra_threads',
      'mastra_messages',
      'mastra_resources',
      'mastra_observational_memory',
      'mastra_memory_run_fences',
    ]) {
      const result = await db.query(`select count(*)::int as n from mastra.${table}`);
      counts[table] = result.rows[0]?.n ?? 0;
    }
    results.tables = { counts, stats: rows };
    expect(counts.mastra_messages).toBeGreaterThan(0);
  });
});
