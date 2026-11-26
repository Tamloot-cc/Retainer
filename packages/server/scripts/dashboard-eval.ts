/**
 * Dashboard spike eval: does the workspace agent write dashboards that parse
 * and use real object and field names? Sends the chat's two system blocks to
 * the agent's model with the production thinking settings, and answers its
 * describe_schema and query_records calls from a fake CRM workspace. Each
 * program is checked with `checkDashboard`, then against the fake schema.
 *
 *   set -a; . ../../.env; set +a
 *   node scripts/dashboard-eval.ts
 *
 * Costs a few cents a run (Sonnet 5.5, about ten requests).
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  BASE_SYSTEM_PROMPT,
  checkDashboard,
  DASHBOARD_PROMPT,
  mergeDashboard,
} from '@retainer/agent';

const MODEL = 'claude-sonnet-5-5';

type Field = { name: string; type: string; options?: string[] };
const SCHEMA: Record<string, Field[]> = {
  deal: [
    { name: 'name', type: 'text' },
    { name: 'stage', type: 'select', options: ['lead', 'qualified', 'proposal', 'won', 'lost'] },
    { name: 'amount', type: 'money' },
    { name: 'closeDate', type: 'date' },
    { name: 'company', type: 'relation' },
    { name: 'owner', type: 'relation' },
  ],
  company: [
    { name: 'name', type: 'text' },
    { name: 'industry', type: 'select', options: ['saas', 'fintech', 'health', 'retail'] },
    { name: 'employees', type: 'number' },
    { name: 'domain', type: 'text' },
  ],
  task: [
    { name: 'title', type: 'text' },
    { name: 'status', type: 'select', options: ['todo', 'in_progress', 'done'] },
    { name: 'dueDate', type: 'date' },
    { name: 'assignee', type: 'relation' },
  ],
};
const SAMPLE: Record<string, unknown[]> = {
  deal: [
    {
      id: 'd1',
      label: 'Acme renewal',
      fields: {
        name: 'Acme renewal',
        stage: 'won',
        amount: { amountMicros: 48_000_000_000, currency: 'USD' },
        closeDate: '2026-10-14',
      },
    },
    {
      id: 'd2',
      label: 'Globex pilot',
      fields: {
        name: 'Globex pilot',
        stage: 'proposal',
        amount: { amountMicros: 12_500_000_000, currency: 'USD' },
        closeDate: '2026-12-05',
      },
    },
  ],
  company: [
    {
      id: 'c1',
      label: 'Acme',
      fields: { name: 'Acme', industry: 'saas', employees: 420, domain: 'acme.com' },
    },
  ],
  task: [
    {
      id: 't1',
      label: 'Send proposal',
      fields: { title: 'Send proposal', status: 'todo', dueDate: '2026-11-20' },
    },
  ],
};

const tools: Anthropic.Tool[] = [
  {
    name: 'describe_schema',
    description: "The workspace's objects and their fields: API names, types and select options.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'query_records',
    description: 'Lists records of one object, filtered and sorted by its fields.',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'string' },
        filter: { type: 'object' },
        limit: { type: 'number' },
      },
      required: ['object'],
    },
  },
];

function runTool(name: string, input: Record<string, unknown>): string {
  if (name === 'describe_schema')
    return JSON.stringify({
      objects: Object.entries(SCHEMA).map(([object, fields]) => ({ object, fields })),
    });
  const object = String(input.object);
  if (!SCHEMA[object])
    return JSON.stringify({ error: { code: 'not_found', message: `no object ${object}` } });
  return JSON.stringify({ records: SAMPLE[object] ?? [], nextCursor: null });
}

const client = new Anthropic();

/** One agent turn: tool calls answered from the fake workspace until it ends. Returns its text. */
async function turn(
  messages: Anthropic.MessageParam[],
): Promise<{ text: string; requests: number }> {
  for (let requests = 1; requests <= 10; requests++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: [
        { type: 'text', text: BASE_SYSTEM_PROMPT },
        { type: 'text', text: DASHBOARD_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      tools,
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'refusal')
      throw new Error(`refused: ${response.stop_details?.category}`);
    const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || !uses.length) {
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { text, requests };
    }
    messages.push({
      role: 'user',
      content: uses.map((u) => ({
        type: 'tool_result' as const,
        tool_use_id: u.id,
        content: runTool(u.name, u.input as Record<string, unknown>),
      })),
    });
  }
  throw new Error('too many tool rounds');
}

const programsIn = (text: string) =>
  [...text.matchAll(/```openui-lang[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');

/** Names the program uses that the fake workspace doesn't have. */
function schemaProblems(program: string): string[] {
  const problems: string[] = [];
  for (const [, args] of program.matchAll(/\bQuery\(\s*"[^"]*"\s*,\s*(\{[^\n]*?\})\s*,/g)) {
    const object = /object:\s*"([^"]+)"/.exec(args ?? '')?.[1];
    const fields = SCHEMA[object ?? ''];
    if (!fields) {
      problems.push(`unknown object ${object}`);
      continue;
    }
    const names = new Set(fields.map((f) => f.name));
    for (const [, name] of (args ?? '').matchAll(/(?:field|groupBy):\s*"([^"]+)"/g))
      if (!names.has(name ?? '')) problems.push(`${object} has no field ${name}`);
    const groupBy = /groupBy:\s*"([^"]+)"/.exec(args ?? '')?.[1];
    if (groupBy && fields.find((f) => f.name === groupBy)?.type !== 'select')
      problems.push(`groupBy ${groupBy} is not a select field`);
  }
  return problems;
}

type Case = { ask: string; expect: 'dashboard' | 'text'; then?: string };
const CASES: Case[] = [
  {
    ask: 'Build me a dashboard of our deals by stage, with the total pipeline and the biggest deals.',
    expect: 'dashboard',
    then: 'Make the bar chart show the amount per stage instead of the count, and add a headline for won revenue.',
  },
  {
    ask: 'Show open tasks by status, and a table of the overdue ones as of 2026-11-26.',
    expect: 'dashboard',
  },
  { ask: 'Companies by industry, and the 10 largest by employees.', expect: 'dashboard' },
  {
    ask: 'A dashboard of deals closing in Q4 2026 (Oct 1 to Dec 31): count, pipeline and by stage.',
    expect: 'dashboard',
  },
  { ask: 'Which stage is the Acme renewal deal in?', expect: 'text' },
];

let passed = 0;
let total = 0;
for (const c of CASES) {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: c.ask }];
  const steps: { label: string; ask: string }[] = [{ label: 'ask', ask: c.ask }];
  if (c.then) steps.push({ label: 'edit', ask: c.then });
  let program = '';
  for (const [i, step] of steps.entries()) {
    if (i > 0) messages.push({ role: 'user', content: step.ask });
    total++;
    const started = Date.now();
    const { text, requests } = await turn(messages);
    const programs = programsIn(text);
    const problems: string[] = [];
    if (c.expect === 'text') {
      if (programs.length) problems.push('wrote a dashboard for a plain question');
    } else if (!programs.length) problems.push('no dashboard');
    for (const p of programs) program = program ? mergeDashboard(program, p) : p;
    if (programs.length) problems.push(...checkDashboard(program), ...schemaProblems(program));
    if (!problems.length) passed++;
    console.log(`\n=== ${step.label}: ${step.ask}`);
    console.log(
      `${problems.length ? 'FAIL' : 'PASS'} · ${requests} requests · ${((Date.now() - started) / 1000).toFixed(0)}s · patch ${programs.map((p) => p.trim().split('\n').length).join('+') || 0} lines`,
    );
    for (const p of problems) console.log(`  - ${p}`);
    console.log(text.trim());
  }
}
console.log(`\n${passed}/${total} passed`);
