/**
 * From packages/server, with a local Postgres login that can create databases:
 * pnpm exec tsx --env-file-if-exists=../../.env scripts/routine-eval.ts
 *
 * The routine eval (routines-in-chat spec §9): the chat agent drafts
 * routines with the routines guide and the chat's routine tools, against a
 * temporary database, with the real routine runner type-checking and
 * dry-running in process. Sends synthetic CRM data to Anthropic and incurs
 * model usage (the agent's turns and any dry run's model calls).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  BASE_SYSTEM_PROMPT,
  RETAINER_READ_TOOL_NAMES,
  RETAINER_ROUTINE_TOOL_NAMES,
  RETAINER_WRITE_TOOL_NAMES,
} from '@retainer/agent';
import { executeRoutine } from '@retainer/runner/routine';
import type { RoutineManifest } from '@retainer/shared';
import { chatContext, workspaceDate } from '../src/agent-sessions/context.js';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/auth/keys.js';
import { createSql, RUNTIME_ROLE } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { MODEL_PROXY_PATH } from '../src/extension-runtime/tokens.js';
import { agentToolHost } from '../src/mcp/agent-tools.js';
import { Routines } from '../src/routines/service.js';
import { RoutineExecutor } from '../src/worker/routines.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';
import { testRunTokens } from '../test/helpers/model.js';

const inputUrl = process.env.DATABASE_URL;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!inputUrl || !apiKey)
  throw new Error('Set DATABASE_URL and ANTHROPIC_API_KEY before running the routine eval.');
const database = `retainer_routine_eval_${randomBytes(6).toString('hex')}`;
const url = new URL(inputUrl);
url.pathname = `/${database}`;
const admin = createSql(inputUrl, { max: 1 });
const owner = createSql(url.toString(), { max: 2 });
const runtime = createSql(url.toString(), { role: RUNTIME_ROLE, max: 10 });
const discovery = createSql(url.toString(), { role: 'retainer_executor', max: 2 });
const anthropic = new Anthropic({ maxRetries: 1, timeout: 120_000 });
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
const only = process.env.ROUTINE_EVAL_CASE;

type Fence = {
  source: string;
  preview: string | null;
  name: string;
  description: string;
  summary: string;
  report: { verdict: string; gaps: { reason: string }[] };
  routine?: string;
};
type Outcome = {
  answer: string;
  fences: Fence[];
  called: string[];
  readGuide: boolean;
  manifest?: RoutineManifest;
  draftOk?: boolean;
};
type Case = {
  name: string;
  prompt: (ids: Ids) => string;
  verify: (outcome: Outcome, ids: Ids) => string[];
};
type Ids = { routine: string; view: string };

const ROUTINE_TOOLS = new Set<string>(RETAINER_ROUTINE_TOOL_NAMES);
const needsDraft = (outcome: Outcome) => {
  const problems: string[] = [];
  if (!outcome.readGuide) problems.push('the routines guide was not read');
  if (outcome.fences.length !== 1)
    problems.push(`expected one fence, got ${outcome.fences.length}`);
  if (outcome.draftOk !== true) problems.push('the draft does not pass the check Propose runs');
  return problems;
};
const noDraft = (outcome: Outcome) =>
  outcome.fences.length ? [`expected no fence, got ${outcome.fences.length}`] : [];
const when = (outcome: Outcome) => outcome.manifest?.when;

const cases: Case[] = [
  {
    name: 'record trigger',
    prompt: () =>
      'When a deal moves to the Won stage, create a task to send a thank-you note, due two days later.',
    verify: (o) => [
      ...needsDraft(o),
      ...(when(o)?.kind === 'record' ? [] : ['expected a record trigger']),
    ],
  },
  {
    name: 'schedule',
    prompt: () =>
      'Every Monday at 09:00, create a follow-up task for each deal in the proposal stage.',
    verify: (o) => [
      ...needsDraft(o),
      ...(when(o)?.kind === 'schedule' ? [] : ['expected a schedule trigger']),
    ],
  },
  {
    name: 'manual button',
    prompt: () => 'Give each deal a "Kickoff" button that creates a kickoff task for the deal.',
    verify: (o) => [
      ...needsDraft(o),
      ...(when(o)?.kind === 'manual' ? [] : ['expected a manual trigger']),
    ],
  },
  {
    name: 'model call',
    prompt: () =>
      'When a company is created, ask the model for a one-sentence summary of what the company does and save it as a task titled with that sentence.',
    verify: (o) => [
      ...needsDraft(o),
      ...(o.manifest?.uses.model ? [] : ['expected uses.model in the manifest']),
    ],
  },
  {
    name: 'once per deal',
    prompt: () =>
      'When a deal moves to the proposal stage, create a task to send the proposal. Only ever once per deal.',
    verify: (o) => [
      ...needsDraft(o),
      ...(when(o)?.oncePerRecord ? [] : ['expected oncePerRecord in the manifest']),
    ],
  },
  {
    name: 'partial: no tool',
    prompt: () =>
      'When a deal is won, send its owner a WhatsApp message and create a task to invoice the customer.',
    verify: (o) => {
      const fence = o.fences[0];
      return [
        ...needsDraft(o),
        ...(fence?.report.verdict === 'partial' ? [] : ['expected a partial verdict']),
        ...(fence?.report.gaps.some((g) => g.reason === 'no_tool')
          ? []
          : ['expected a no_tool gap']),
        ...(fence?.report.gaps.every((g) => Object.keys(g).sort().join() === 'fix,part,reason')
          ? []
          : ['a gap does not have exactly part, reason and fix']),
      ];
    },
  },
  {
    name: 'not possible: blocking',
    prompt: () => 'Stop anyone from saving a deal that has no amount.',
    verify: (o) => noDraft(o),
  },
  {
    name: 'unclear: asks',
    prompt: () => 'Set up a routine to remind me about deals.',
    verify: (o) => [...noDraft(o), ...(o.answer.includes('?') ? [] : ['expected a question back'])],
  },
  {
    name: 'edit an existing routine',
    prompt: () => 'Change my "Thank won deals" routine so it only acts on deals over $10,000.',
    verify: (o, ids) => [
      ...needsDraft(o),
      ...(o.fences[0]?.routine === ids.routine ? [] : ['expected the draft to name the routine']),
    ],
  },
  {
    name: 'from a view',
    prompt: () =>
      'Every morning at 08:00, create a review task for each deal in my "Big open deals" view.',
    verify: (o) => {
      const w = when(o);
      return [
        ...needsDraft(o),
        ...(o.called.includes('list_views') ? [] : ['expected list_views']),
        ...(w?.kind === 'schedule' && w.filter
          ? []
          : ['expected a schedule with the view’s filter']),
      ];
    },
  },
  {
    name: 'a question',
    prompt: () => 'How many open deals do we have?',
    verify: (o) => [
      ...noDraft(o),
      ...(o.called.some((name) => ROUTINE_TOOLS.has(name))
        ? ['a question used routine tools']
        : []),
    ],
  },
  {
    name: 'a one-off change',
    prompt: () => 'Mark the Globex pilot deal as lost.',
    verify: (o) => [
      ...noDraft(o),
      ...(o.called.includes('upsert_record') || o.called.includes('upsert_records')
        ? []
        : ['expected the change made now']),
    ],
  },
];

async function fixture() {
  const { tokens } = await testRunTokens();
  const workspace = await createWorkspace(owner, { name: 'Routine eval', template: 'sales' });
  const actor = { type: 'user', id: 'routine-eval', name: 'Dana' } as const;
  const { key } = await createApiKey(owner, {
    workspace: workspace.id,
    name: 'Routine eval',
    actor,
    scopes: ['admin'],
  });
  const routineConfig = { modelAvailable: true, agentAvailable: false };
  const app = createApp({
    sql: runtime,
    runTokens: tokens,
    model: { apiKey, upstream: 'https://api.anthropic.com' },
    routines: {
      available: true,
      modelAvailable: true,
      modelOrigin: MODEL_PROXY_PATH,
      modelName: 'claude-opus-5-5',
      modelCallsPerDay: 1000,
    },
  });
  const inProcess = (input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(app.request(input.toString(), init));
  const executor = new RoutineExecutor({
    sql: runtime,
    discoverySql: discovery,
    tokens,
    driver: {
      invoke: (_exe, invocation, signal) =>
        executeRoutine(invocation, signal, inProcess as typeof fetch),
    },
    executable: {
      registrationId: randomUUID(),
      functionId: randomUUID(),
      releaseDigest: 'a'.repeat(64),
      driverTarget: 'routine-runner',
    } as never,
    apiOrigin: 'http://retainer.test/',
    owner: 'routine-eval',
    config: routineConfig,
  });
  // The sandbox jobs the tools queue run while the tools wait for them.
  const ticking = setInterval(() => void executor.tick().catch(() => {}), 500);
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const usd = (amount: number) => ({ amountMicros: amount * 1_000_000, currency: 'USD' });
  const acme = (await post('/v1/objects/company/records', { values: { name: 'Acme' } })) as {
    id: string;
  };
  for (const [name, stage, amount] of [
    ['Acme renewal', 'won', 48_000],
    ['Globex pilot', 'proposal', 12_500],
    ['Initech expansion', 'qualified', 30_000],
    ['Small add-on', 'proposal', 2_000],
  ] as const)
    await post('/v1/objects/deal/records', {
      values: { name, stage, amount: usd(amount), company: acme.id },
    });
  const view = (await post('/v1/objects/deal/views', {
    name: 'Big open deals',
    description: 'Open deals over $10,000.',
    kind: 'table',
    visibility: 'workspace',
    filter: {
      and: [
        { stage: { in: ['lead', 'qualified', 'proposal'] } },
        { amount: { gt: 10_000_000_000 } },
      ],
    },
  })) as { id: string };
  // An existing routine to edit: checked, then proposed.
  const caller = {
    workspaceId: workspace.id,
    actor: { type: 'agent', id: 'retainer-agent:dana', name: 'Retainer agent for Dana' },
    scopes: ['read', 'write'],
  } as const;
  const routines = new Routines(runtime, routineConfig);
  const caps = (await routines.capabilities(caller as never)) as {
    objects: { name: string; universalId: string; fields: { name: string; key: string }[] }[];
  };
  const deal = caps.objects.find((o) => o.name === 'deal');
  const task = caps.objects.find((o) => o.name === 'task');
  const stage = deal?.fields.find((f) => f.name === 'stage')?.key;
  const title = task?.fields.find((f) => f.name === 'title')?.key;
  const source = {
    manifest: {
      when: { kind: 'record', object: 'deal', on: ['updated'], fields: [stage] },
      if: { [stage as string]: { eq: 'won' } },
      uses: { tools: [], model: false },
    },
    code: `export async function main({ retainer, record }: RoutineContext<'deal'>) {
  await retainer.task.create({ ${JSON.stringify(title)}: 'Send a thank-you note' });
  return { thanked: record.id };
}
`,
  };
  const checked = await post('/v1/routines/validate?wait=20', source);
  if (checked.valid !== true) throw new Error(`fixture routine: ${JSON.stringify(checked)}`);
  const proposed = (await post('/v1/routines', {
    sourceId: checked.sourceId,
    name: 'Thank won deals',
    description: 'When a deal is won, create a task to send a thank-you note.',
    summary: 'Creates a thank-you task when a deal is won.',
    report: { verdict: 'full', gaps: [] },
  })) as { routineId: string };

  const host = agentToolHost(runtime, { routines: routineConfig });
  const names = [
    ...RETAINER_READ_TOOL_NAMES,
    ...RETAINER_WRITE_TOOL_NAMES,
    ...RETAINER_ROUTINE_TOOL_NAMES,
  ];
  const tools = (await host.list(caller as never, names)).map(
    (tool): Anthropic.Tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    }),
  );
  const context = chatContext({
    client: 'web',
    routines: true,
    ownerName: actor.name,
    personal: false,
    workspaceName: workspace.name,
    objects: ['company', 'deal', 'person', 'task'],
    eventTypes: ['conversation'],
    date: workspaceDate(new Date(), 'UTC'),
  });
  return {
    context,
    tools,
    ids: { routine: proposed.routineId, view: view.id },
    call: (name: string, args: object) => host.call(caller as never, name, args),
    draft: (fence: Fence) =>
      routines.draft(caller as never, fence.source, {
        previewId: fence.preview ?? undefined,
        routineId: fence.routine,
      }),
    stop: () => {
      clearInterval(ticking);
      executor.stop();
    },
  };
}

async function converse(fx: Awaited<ReturnType<typeof fixture>>, prompt: string): Promise<Outcome> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `${fx.context}\n\n${prompt}` },
  ];
  const called: string[] = [];
  let readGuide = false;
  let answer = '';
  for (let round = 0; round < 30; round++) {
    const reply = await anthropic.messages.create({
      model,
      max_tokens: 32_000,
      system: [
        { type: 'text', text: BASE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      messages,
      tools: fx.tools,
    });
    messages.push({ role: 'assistant', content: reply.content });
    const calls = reply.content.filter((block) => block.type === 'tool_use');
    if (reply.stop_reason !== 'tool_use' || !calls.length) {
      answer = reply.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      break;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const request of calls) {
      const input = request.input as Record<string, unknown>;
      called.push(request.name);
      const result = await fx.call(request.name, input);
      if (request.name === 'get_guide' && input.name === 'routines' && result.ok) readGuide = true;
      results.push({
        type: 'tool_result',
        tool_use_id: request.id,
        is_error: !result.ok,
        content: result.ok ? JSON.stringify(result.output) : JSON.stringify(result.error),
      });
    }
    messages.push({ role: 'user', content: results });
  }
  const fences: Fence[] = [];
  for (const match of answer.matchAll(/^```retainer-routine[^\n]*\n([\s\S]*?)^```/gm)) {
    try {
      fences.push(JSON.parse(match[1] ?? '') as Fence);
    } catch {
      fences.push({ source: 'unparsable' } as Fence);
    }
  }
  const outcome: Outcome = { answer, fences, called, readGuide };
  const fence = fences[0];
  if (fence && fence.source !== 'unparsable') {
    try {
      const draft = await fx.draft(fence);
      outcome.manifest = draft.manifest as RoutineManifest;
      outcome.draftOk = draft.ok;
    } catch (error) {
      outcome.draftOk = false;
      console.log(`  draft route: ${(error as Error).message}`);
    }
  }
  return outcome;
}

async function run() {
  await runMigrations(url.toString());
  const fx = await fixture();
  let passed = 0;
  let total = 0;
  try {
    for (const scenario of cases) {
      if (only && !only.split(',').includes(scenario.name)) continue;
      const started = Date.now();
      const outcome = await converse(fx, scenario.prompt(fx.ids));
      const problems = scenario.verify(outcome, fx.ids);
      total++;
      if (!problems.length) passed++;
      console.log(
        `${problems.length ? 'FAIL' : 'PASS'} (${((Date.now() - started) / 1000).toFixed(1)}s) ${scenario.name}`,
      );
      for (const problem of problems) console.log(`  ${problem}`);
      if (problems.length || process.env.ROUTINE_EVAL_VERBOSE)
        console.log(
          `  tools: ${outcome.called.join(', ')}\n  answer: ${outcome.answer.slice(0, 1500)}`,
        );
    }
  } finally {
    fx.stop();
  }
  console.log(`${passed}/${total} passed`);
  if (passed !== total) process.exitCode = 1;
}

await admin.unsafe(`create database "${database}"`);
try {
  await run();
} finally {
  await Promise.all([owner.end(), runtime.end(), discovery.end()]);
  await admin.unsafe(`drop database "${database}" with (force)`);
  await admin.end();
}
