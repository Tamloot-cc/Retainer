/**
 * From packages/server, with a local Postgres login that can create databases:
 * pnpm exec tsx --env-file-if-exists=../../.env scripts/dashboard-eval.ts
 *
 * Sends synthetic CRM data to Anthropic and incurs model usage.
 */
import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { mergeStatements } from '@openuidev/lang-core';
import { BASE_SYSTEM_PROMPT } from '@retainer/agent';
import { chatContext, workspaceDate } from '../src/agent-sessions/context.js';
import type { RetainerToolResult } from '../src/agent-sessions/tools.js';
import { createApp } from '../src/api/app.js';
import { createApiKey } from '../src/auth/keys.js';
import { inspectDashboard } from '../src/dashboards/program.js';
import { createSql, RUNTIME_ROLE } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { agentToolHost } from '../src/mcp/agent-tools.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';

const inputUrl = process.env.DATABASE_URL;
if (!inputUrl || !process.env.ANTHROPIC_API_KEY)
  throw new Error('Set DATABASE_URL and ANTHROPIC_API_KEY before running the dashboard eval.');
const database = `retainer_dashboard_eval_${randomBytes(6).toString('hex')}`;
const url = new URL(inputUrl);
url.pathname = `/${database}`;
const admin = createSql(inputUrl, { max: 1 });
const owner = createSql(url.toString(), { max: 1 });
const runtime = createSql(url.toString(), { role: RUNTIME_ROLE, max: 2 });
const anthropic = new Anthropic({ maxRetries: 1, timeout: 90_000 });
const model = 'claude-sonnet-5-5';
const cases = [
  {
    prompts: [
      'Build a dashboard of our deals by stage with total pipeline and the biggest deals.',
      'Make the bar chart show amount per stage instead of count and add a headline for won revenue.',
    ],
    dashboard: true,
  },
  {
    prompts: ['Show tasks by status and a table of overdue open tasks as of November 26, 2026.'],
    dashboard: true,
  },
  {
    prompts: ['Build a dashboard of companies with a table of the ten largest by headcount.'],
    dashboard: true,
  },
  {
    prompts: ['Show deals closing in Q4 2026 with a monthly line chart and a breakdown by stage.'],
    dashboard: true,
  },
  { prompts: ['Which stage is the Acme renewal deal in?'], dashboard: false },
];
const usd = (amount: number) => ({ amountMicros: amount * 1_000_000, currency: 'USD' });
const sample = {
  deal: [
    { name: 'Acme renewal', stage: 'won', amount: usd(48_000), closeDate: '2026-10-14' },
    { name: 'Globex pilot', stage: 'proposal', amount: usd(12_500), closeDate: '2026-12-05' },
  ],
  company: [
    { name: 'Acme', industry: 'Software', employeeCount: 420 },
    { name: 'Globex', industry: 'Manufacturing', employeeCount: 75 },
  ],
  task: [
    { title: 'Send proposal', status: 'todo', dueDate: '2026-11-20' },
    { title: 'Confirm renewal', status: 'in_progress', dueDate: '2026-11-22' },
  ],
};

async function fixture() {
  const workspace = await createWorkspace(owner, { name: 'Synthetic sales', template: 'sales' });
  const actor = { type: 'user', id: 'dashboard-eval', name: 'Dana' } as const;
  const { key } = await createApiKey(owner, {
    workspace: workspace.id,
    name: 'Dashboard eval',
    actor,
    scopes: ['admin'],
  });
  const app = createApp({ sql: runtime });
  for (const [object, records] of Object.entries(sample)) {
    for (const values of records) {
      const response = await app.request(`/v1/objects/${object}/records`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ values }),
      });
      if (!response.ok) throw new Error(await response.text());
    }
  }
  const context = chatContext({
    client: 'web',
    ownerName: actor.name,
    personal: false,
    workspaceName: workspace.name,
    objects: ['company', 'deal', 'person', 'task'],
    eventTypes: ['conversation'],
    date: workspaceDate(new Date('2026-11-26T12:00:00Z'), 'UTC'),
  });
  const caller = { workspaceId: workspace.id, actor, scopes: ['read'] as const };
  const host = agentToolHost(runtime);
  const names = [
    'describe_schema',
    'get_guide',
    'query_records',
    'aggregate_records',
    'check_dashboard',
  ];
  const tools = (await host.list(caller, names)).map(
    (tool): Anthropic.Tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    }),
  );
  return { context, tools, call: (name: string, args: object) => host.call(caller, name, args) };
}

const isChecked = (result: RetainerToolResult) =>
  result.ok && (result.output as { ok?: unknown })?.ok === true;

async function run() {
  await runMigrations(url.toString());
  const { context, tools, call } = await fixture();
  let passed = 0;
  let total = 0;
  for (const scenario of cases) {
    const messages: Anthropic.MessageParam[] = [];
    let program = '';
    let readGuide = false;
    for (const [index, prompt] of scenario.prompts.entries()) {
      const started = Date.now();
      messages.push({ role: 'user', content: index ? prompt : `${context}\n\n${prompt}` });
      let checked = false;
      let answer = '';
      let finished = false;
      for (let round = 0; round < 10; round++) {
        const reply = await anthropic.messages.create({
          model,
          max_tokens: 16_000,
          system: [
            {
              type: 'text',
              text: BASE_SYSTEM_PROMPT,
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'medium' },
          messages,
          tools,
        });
        messages.push({ role: 'assistant', content: reply.content });
        const calls = reply.content.filter((block) => block.type === 'tool_use');
        if (reply.stop_reason !== 'tool_use' || !calls.length) {
          answer = reply.content
            .flatMap((block) => (block.type === 'text' ? [block.text] : []))
            .join('');
          finished = reply.stop_reason === 'end_turn';
          break;
        }
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const request of calls) {
          const input = request.input as Record<string, unknown>;
          const result = await call(request.name, input);
          if (request.name === 'get_guide' && input.name === 'dashboards' && result.ok)
            readGuide = true;
          if (request.name === 'check_dashboard' && isChecked(result)) checked = true;
          results.push({
            type: 'tool_result',
            tool_use_id: request.id,
            is_error: !result.ok,
            content: result.ok ? JSON.stringify(result.output) : result.error.message,
          });
        }
        messages.push({ role: 'user', content: results });
      }
      const blocks = [...answer.matchAll(/^```openui-lang[^\n]*\n([\s\S]*?)^```/gm)].map(
        (match) => match[1] ?? '',
      );
      const problems: string[] = [];
      if (!finished) problems.push('The agent did not complete its answer');
      if (scenario.dashboard) {
        if (!readGuide) problems.push('The dashboard guide was not read');
        if (!blocks.length) problems.push('The answer contained no dashboard');
        if (!checked) problems.push('The agent did not get a successful check_dashboard result');
        for (const block of blocks)
          program = program ? mergeStatements(program, block) : block.trim();
        if (program) {
          const validated = await call('check_dashboard', { program });
          if (!isChecked(validated)) problems.push(JSON.stringify(validated));
          if (!inspectDashboard(program).queries.length)
            problems.push('The program had no live queries');
        }
      } else if (readGuide || blocks.length || checked)
        problems.push('The plain question triggered dashboard work');
      total++;
      if (!problems.length) passed++;
      console.log(
        `${problems.length ? 'FAIL' : 'PASS'} (${((Date.now() - started) / 1000).toFixed(1)}s) ${prompt}`,
      );
      for (const problem of problems) console.log(`  ${problem}`);
    }
  }
  console.log(`${passed}/${total} passed`);
  if (passed !== total) process.exitCode = 1;
}

await admin.unsafe(`create database "${database}"`);
try {
  await run();
} finally {
  await Promise.all([owner.end(), runtime.end()]);
  await admin.unsafe(`drop database "${database}" with (force)`);
  await admin.end();
}
