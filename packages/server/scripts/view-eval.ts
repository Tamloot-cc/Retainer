/**
 * From packages/server: pnpm exec tsx --env-file-if-exists=../../.env scripts/view-eval.ts
 * Uses a temporary local database and sends synthetic records to Anthropic.
 */
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { BASE_SYSTEM_PROMPT } from '@retainer/agent';
import { chatContext, workspaceDate } from '../src/agent-sessions/context.js';
import { createSql, RUNTIME_ROLE } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { agentToolHost } from '../src/mcp/agent-tools.js';
import { createRecord } from '../src/records/service.js';
import { createView } from '../src/views/service.js';
import { createWorkspace } from '../src/workspaces/workspaces.js';

const inputUrl = process.env.DATABASE_URL;
if (!inputUrl || !process.env.ANTHROPIC_API_KEY)
  throw new Error('Set DATABASE_URL and ANTHROPIC_API_KEY to run the view eval.');

const database = `retainer_view_eval_${randomBytes(6).toString('hex')}`;
const url = new URL(inputUrl);
url.pathname = `/${database}`;
const admin = createSql(inputUrl, { max: 1 });
const owner = createSql(url.toString(), { max: 1 });
const sql = createSql(url.toString(), { role: RUNTIME_ROLE, max: 2 });
const anthropic = new Anthropic({ maxRetries: 1, timeout: 90_000 });
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';

const scenario = (prompt: string, verify: (draft: Record<string, unknown>) => boolean) => ({
  prompt,
  kind: 'view' as const,
  verify,
});

async function run() {
  await runMigrations(url.toString());
  const space = await createWorkspace(owner, { name: 'View eval', template: 'sales' });
  const caller = {
    workspaceId: space.id,
    actor: { type: 'user', id: 'view-eval', name: 'Dana' } as const,
    scopes: ['read', 'write'] as const,
  };
  const company = await createRecord(sql, caller, 'company', { name: 'Acme' });
  const date = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  for (const [name, stage, closeDate] of [
    ['Acme renewal', 'proposal', date(0)],
    ['Acme expansion', 'qualified', date(2)],
    ['Acme pilot', 'won', date(-7)],
  ])
    await createRecord(sql, caller, 'deal', { name, stage, closeDate, company: company.id });
  await createRecord(sql, caller, 'deal', {
    name: 'Undated inbound',
    stage: 'lead',
    company: company.id,
  });
  await createRecord(sql, caller, 'task', {
    title: 'Send a proposal',
    status: 'todo',
    dueDate: date(-2),
  });
  const existing = await createView(sql, caller, 'deal', {
    name: 'Open pipeline',
    description: 'Open deals for the weekly meeting',
    kind: 'table',
    visibility: 'private',
    filter: { stage: { in: ['lead', 'qualified', 'proposal'] } },
  });
  const context = chatContext({
    client: 'web',
    ownerName: 'Dana',
    personal: false,
    workspaceName: space.name,
    objects: ['company', 'deal', 'task', 'person'],
    eventTypes: ['conversation'],
    date: workspaceDate(new Date(), 'UTC'),
  });
  const host = agentToolHost(sql);
  const names = [
    'describe_schema',
    'get_guide',
    'query_records',
    'aggregate_records',
    'list_views',
    'check_view',
    'check_dashboard',
  ];
  const tools = (await host.list(caller, names)).map(
    (tool): Anthropic.Tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    }),
  );
  const cases = [
    scenario(
      'Make a table view of deals grouped by company.',
      (draft) => draft.kind === 'table' && draft.groupBy === 'company',
    ),
    scenario('Make a view of deals closing this quarter.', (draft) =>
      JSON.stringify(draft.filter).includes('"this_quarter"'),
    ),
    scenario('Make a view of open tasks that are overdue.', (draft) =>
      JSON.stringify(draft.filter).includes('"lt":"today"'),
    ),
    scenario('Make a view of deals that are either proposals or have no close date.', (draft) =>
      ['"or"', '"proposal"', '"closeDate":{"isNull":true}'].every((word) =>
        JSON.stringify(draft.filter).includes(word),
      ),
    ),
    scenario(
      'Edit my Open pipeline view to sort by close date, earliest first.',
      (draft) => draft.view === existing.id && JSON.stringify(draft.sort).includes('closeDate'),
    ),
    {
      prompt: 'Build a dashboard with an open deal count and a chart of companies by industry.',
      kind: 'dashboard' as const,
    },
    { prompt: 'What stage is the Acme renewal in?', kind: 'answer' as const },
  ];
  let passed = 0;
  for (const test of cases) {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: `${context}\n\n${test.prompt}` },
    ];
    const checked: unknown[] = [];
    let readGuide = false;
    let checkedDashboard = false;
    let answer = '';
    for (let round = 0; round < 12; round++) {
      const reply = await anthropic.messages.create({
        model,
        max_tokens: 8000,
        system: BASE_SYSTEM_PROMPT,
        messages,
        tools,
      });
      messages.push({ role: 'assistant', content: reply.content });
      if (reply.stop_reason === 'end_turn') {
        answer = reply.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('');
        break;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tool of reply.content) {
        if (tool.type !== 'tool_use') continue;
        const args = tool.input as Record<string, unknown>;
        const result = await host.call(caller, tool.name, args);
        if (result.ok) {
          if (tool.name === 'get_guide' && args.name === 'views') readGuide = true;
          if ((result.output as { ok?: boolean })?.ok === true) {
            if (tool.name === 'check_view') checked.push(args.draft);
            if (tool.name === 'check_dashboard') checkedDashboard = true;
          }
        }
        results.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          is_error: !result.ok,
          content: result.ok
            ? typeof result.output === 'string'
              ? result.output
              : JSON.stringify(result.output)
            : result.error.message,
        });
      }
      if (!results.length) break;
      messages.push({ role: 'user', content: results });
    }
    const view = /^\x60\x60\x60retainer-view[^\n]*\n([\s\S]*?)^\x60\x60\x60/m.exec(answer);
    const dashboard = /^\x60\x60\x60openui-lang/m.test(answer);
    const problems: string[] = [];
    try {
      if (test.kind === 'view') {
        if (!readGuide) problems.push('Views guide was not read.');
        if (!view?.[1]) problems.push('Missing retainer-view fence.');
        else {
          const draft = JSON.parse(view[1]) as Record<string, unknown>;
          if (!checked.some((value) => isDeepStrictEqual(value, draft)))
            problems.push('No successful check for the exact emitted draft.');
          if (!test.verify(draft))
            problems.push('The draft does not match the requested settings.');
        }
      } else if (test.kind === 'dashboard') {
        if (!checkedDashboard || !dashboard || view) problems.push('Expected a checked dashboard.');
      } else if (!/proposal/i.test(answer) || view || dashboard) {
        problems.push('Expected a plain answer with the proposal stage.');
      }
    } catch {
      problems.push('Invalid draft JSON.');
    }
    const success = !problems.length;
    if (success) passed++;
    console.log(`${success ? 'PASS' : 'FAIL'} ${test.prompt}`);
    if (!success) console.log(...problems, '\n', answer || 'No completed answer.');
  }
  console.log(`${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exitCode = 1;
}

await admin.unsafe(`create database "${database}"`);
try {
  await run();
} finally {
  await Promise.all([owner.end(), sql.end()]);
  await admin.unsafe(`drop database "${database}" with (force)`);
  await admin.end();
}
