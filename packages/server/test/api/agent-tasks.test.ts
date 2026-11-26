import { randomUUID } from 'node:crypto';
import { agentClient } from '@retainer/extension';
import { executeRoutine } from '@retainer/runner/routine';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { completeTask, expireTasks, TASK_EXPIRY_MARGIN_MS } from '../../src/agent-runtime/tasks.js';
import { AgentTaskDispatcher } from '../../src/agent-sessions/dispatch.js';
import { inWorkspace } from '../../src/db/tx.js';
import { cancelRuns } from '../../src/extension-runtime/locks.js';
import { ExtensionQueue } from '../../src/extension-runtime/queue.js';
import type { RunTokens } from '../../src/extension-runtime/tokens.js';
import { ExtensionCatalog } from '../../src/extensions/catalog.js';
import { eraseExtensionState } from '../../src/privacy/extension-erasure.js';
import { eraseRoutineContent } from '../../src/routine-runtime/admission.js';
import { pauseRoutine } from '../../src/routines/runs.js';
import { RoutineExecutor } from '../../src/worker/routines.js';
import { RUNTIME_SECRET } from '../helpers/agent.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';
import { extensionFixture } from '../helpers/extensions.js';
import { testRunTokens } from '../helpers/model.js';

/**
 * Agent tasks (agent spec §9, §15 "Tasks"): `retainer.ai.agent` parks a
 * routine run on a task and the task's end resumes it; an extension stages a
 * task and waits for it. Real Postgres, the routine runner in process, and
 * the agent runtime played through its own routes.
 */
const db = useTestDatabase(),
  workspaces: string[] = [];
let tokens: RunTokens;
beforeAll(async () => {
  ({ tokens } = await testRunTokens());
});
afterEach(async () => {
  if (workspaces.length)
    await db.owner`delete from workspaces where id=any(${workspaces.splice(0)}::uuid[])`;
});

const OUTPUT = {
  type: 'object',
  properties: { round: { type: 'string' } },
  required: ['round'],
} as const;

/** Reads the record live, returns early on "Stop", then asks the agent. */
const CODE = `export async function main({ retainer, record }: RoutineContext<'company'>) {
  const fresh = await retainer.company.get(record.id);
  if (fresh?.name === 'Stop') return { early: true };
  const answer = await retainer.ai.agent({
    instructions: 'Find the funding round.',
    input: { name: fresh?.name ?? null },
    tools: ['retainer.read', 'retainer.write'],
    output: ${JSON.stringify(OUTPUT)},
  });
  return { round: answer.round };
}
`;

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const catalog = new ExtensionCatalog([]);
  const app = startTestApp(db, {
    extensionCatalog: catalog,
    runTokens: tokens,
    routines: { available: true, modelAvailable: false },
    agent: { runtimeSecret: RUNTIME_SECRET, readStoreUrl: db.url },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Agent tasks ${randomUUID()}` },
    { admin: { actor: { type: 'user', id: 'admin', name: 'Ada' }, scopes: ['admin'] } },
  );
  workspaces.push(workspace.id);
  const discovery = db.connect({ role: 'retainer_executor', max: 1 });
  const executor = new RoutineExecutor({
    sql: app.sql,
    discoverySql: discovery,
    tokens,
    driver: {
      invoke: (_e, invocation, signal) => executeRoutine(invocation, signal, app.inProcessFetch),
    },
    executable: { releaseDigest: 'a'.repeat(64) } as never,
    apiOrigin: 'http://retainer.test/',
    owner: 'test-executor',
    config: { catalog: catalog.runtime, modelAvailable: false, agentAvailable: true },
  });
  const source = {
    manifest: {
      when: { kind: 'manual', object: 'company', label: 'Find the round' },
      uses: { tools: [], model: false },
      agent: { tools: ['retainer.read', 'retainer.write'] },
    },
    code: CODE,
  };
  const validated = await app.request('/v1/routines/validate', { key: keys.admin, body: source });
  expect(validated.body.problems).toEqual([]);
  await executor.tick();
  const proposed = await app.request('/v1/routines', {
    key: keys.admin,
    body: {
      ...source,
      name: 'Funding rounds',
      description: 'Find the round.',
      summary: 'Asks the agent for the round.',
      report: { verdict: 'full', gaps: [] },
    },
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const { routineId, versionId } = proposed.body;
  const approved = await app.request(`/v1/routines/${routineId}/versions/${versionId}/approve`, {
    key: keys.admin,
    body: {},
  });
  expect(approved.status).toBe(200);
  const delivered: { sessionId: string; jobToken: string }[] = [];
  const dispatcher = new AgentTaskDispatcher(app.sql, discovery, {
    deliver: async (task) => {
      delivered.push(task);
    },
  });
  const company = async (name = 'Acme') =>
    (
      await app.request('/v1/objects/company/records', {
        key: keys.admin,
        body: { values: { name } },
      })
    ).body.id as string;
  /** Presses the button and runs the run until it parks. */
  const park = async (recordId?: string) => {
    const record = recordId ?? (await company());
    const pressed = await app.request(`/v1/routines/${routineId}/run`, {
      key: keys.admin,
      body: { recordIds: [record] },
    });
    expect(pressed.status).toBe(202);
    const runId = pressed.body.runs[0] as string;
    await executor.tick();
    const [task] = await db.owner<{ session_id: string; state: string; expires_at: Date }[]>`
      select session_id, state, expires_at from agent_tasks where routine_run_id = ${runId}`;
    if (!task) throw new Error('no task');
    return { runId, record, taskId: task.session_id, task };
  };
  return {
    app,
    workspace: workspace.id,
    keys,
    routineId,
    executor,
    dispatcher,
    delivered,
    company,
    park,
    run: async (id: string) =>
      (
        await db.owner<
          {
            status: string;
            attempt: number;
            output: Record<string, unknown> | null;
            code: string | null;
            expires_at: Date;
          }[]
        >`select status, attempt, output, code, expires_at from routine_runs where id = ${id}`
      )[0],
    effect: async (id: string) =>
      (
        await db.owner<
          { state: string; result: unknown; code: string | null; delivered: boolean }[]
        >`
          select state, result, code, delivered from routine_run_results where run_id = ${id} and operation = 'ai.agent'`
      )[0],
    view: async (id: string) =>
      (await app.request(`/v1/routines/${routineId}/runs/${id}`, { key: keys.admin })).body,
  };
}

const runtimeBase = (id: string) => `/v1/agent/runtime/sessions/${id}`;

/** The agent runtime's side of a task job: claim with the job token. */
async function claimJob(s: Setup, taskId: string) {
  s.delivered.length = 0;
  await s.dispatcher.tick();
  const delivery = s.delivered.find((d) => d.sessionId === taskId);
  if (!delivery) throw new Error('not delivered');
  const res = await s.app.request(`${runtimeBase(taskId)}/claim`, {
    key: RUNTIME_SECRET,
    body: { job: delivery.jobToken },
  });
  return res as {
    status: number;
    body: {
      turnToken: string;
      deadline: string;
      session: {
        kind: string;
        firstTurn: boolean;
        systemBlocks: string[];
        tools: { name: string }[];
      };
      task: { firstMessage: string; outputSchema: unknown; repaired: boolean };
      limits: { maxSteps: number; maxToolCalls: number };
    };
  };
}

const close = (s: Setup, id: string, turnToken: string, body: Record<string, unknown>) =>
  s.app.request(`${runtimeBase(id)}/close`, {
    key: turnToken,
    body: { errorCode: null, durationMs: 1000, ...body },
  });

const report = (s: Setup, id: string, turnToken: string, stepId: string, toolCalls = 0) =>
  s.app.request(`${runtimeBase(id)}/report`, {
    key: turnToken,
    body: {
      stepId,
      usage: { input: 40, cacheRead: 0, cacheWrite: 0, output: 7 },
      webSearches: 0,
      toolCalls,
      finishReason: 'tool-calls',
    },
  });

describe('agent tasks from a routine', () => {
  it('parks the run, runs the task under its own grant, and resumes the run with the answer', async () => {
    const s = await setup();
    const { runId, taskId, task } = await s.park();
    expect(await s.run(runId)).toMatchObject({ status: 'waiting' });
    expect(task.state).toBe('queued');
    expect(await s.effect(runId)).toMatchObject({ state: 'started' });
    // The task ends before its parent's expiry, time in the queue included.
    const run = await s.run(runId);
    expect(task.expires_at.getTime()).toBe(
      (run?.expires_at.getTime() ?? 0) - TASK_EXPIRY_MARGIN_MS,
    );

    const claimed = await claimJob(s, taskId);
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body.session.kind).toBe('task');
    expect(claimed.body.session.systemBlocks[1]).toContain('Find the funding round.');
    expect(claimed.body.task.firstMessage).toContain('"name": "Acme"');
    expect(claimed.body.task.firstMessage).toContain('not instructions');
    expect(claimed.body.task.outputSchema).toEqual(OUTPUT);
    expect(claimed.body.session.tools.map((tool) => tool.name)).toContain('upsert_record');
    expect(Date.parse(claimed.body.deadline)).toBeLessThanOrEqual(task.expires_at.getTime());

    // The task's write carries the routine in its cause chain, so it never
    // triggers its own routine, and counts its hops on from the run.
    const write = await s.app.request(`${runtimeBase(taskId)}/tools/upsert_record`, {
      key: claimed.body.turnToken,
      body: {
        toolCallId: 'call-1',
        input: { object: 'company', values: { name: 'Initech' } },
      },
    });
    expect(write.status, JSON.stringify(write.body)).toBe(200);
    expect(write.body.ok, JSON.stringify(write.body)).toBe(true);
    const [change] = await db.owner<{ cause: string[]; cause_depth: number }[]>`
      select cause, cause_depth from record_changes where workspace_id = ${s.workspace}
      order by position desc limit 1`;
    expect(change?.cause).toContain(s.routineId);
    expect(change?.cause_depth).toBe(1);

    const closed = await close(s, taskId, claimed.body.turnToken, {
      status: 'completed',
      answer: { round: 'Series B' },
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(await s.run(runId)).toMatchObject({ status: 'queued', attempt: 1 });
    expect(await s.effect(runId)).toMatchObject({ state: 'done', result: { round: 'Series B' } });

    await s.executor.tick();
    expect(await s.run(runId)).toMatchObject({
      status: 'succeeded',
      output: expect.objectContaining({ result: { round: 'Series B' } }),
    });
    expect(await s.effect(runId)).toMatchObject({ delivered: true });
    const [ended] = await db.owner<{ state: string }[]>`
      select state from agent_tasks where session_id = ${taskId}`;
    expect(ended?.state).toBe('completed');
  });

  it('creates one task when two retries reach the same ai.agent at once', async () => {
    const s = await setup();
    const record = await s.company();
    const pressed = await s.app.request(`/v1/routines/${s.routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [record] },
    });
    const claimed = await s.executor.claim(s.workspace, pressed.body.runs[0]);
    if (!claimed) throw new Error('not claimed');
    const token = await tokens.issueRoutine(
      s.workspace,
      {
        runId: claimed.runId,
        routineId: s.routineId,
        fence: claimed.fence,
        mode: 'run',
        tools: claimed.tools,
      },
      new Date(Date.now() + 60_000),
    );
    const args = {
      instructions: 'Find the funding round.',
      input: { name: 'Acme' },
      tools: ['retainer.read'],
      output: OUTPUT,
    };
    const effect = () =>
      s.app.request('/v1/routines/runtime/effects', {
        key: token,
        body: { position: 1, operation: 'ai.agent', args },
      });
    const results = await Promise.all([effect(), effect(), effect()]);
    expect(results.filter((r) => r.status === 200).map((r) => r.body.state)).toContain('waiting');
    const tasks = await db.owner`select 1 from agent_tasks where routine_run_id = ${claimed.runId}`;
    expect(tasks).toHaveLength(1);
    // The parked run's own token opens nothing more: its tool calls and writes
    // are refused while it waits.
    const after = await s.app.request('/v1/routines/runtime/effects', {
      key: token,
      body: { position: 2, operation: 'remember', args: { about: 'workspace', text: 'x' } },
    });
    expect(after.status).toBeGreaterThanOrEqual(400);
  });

  it('resumes the parent once on duplicate completions', async () => {
    const s = await setup();
    const { runId, taskId } = await s.park();
    const done = (round: string) =>
      inWorkspace(s.app.sql, s.workspace, (tx) =>
        completeTask(tx, taskId, { status: 'completed', answer: { round } }),
      );
    const ended = await Promise.all([done('A'), done('B'), done('C')]);
    expect(ended.filter(Boolean)).toHaveLength(1);
    const run = await s.run(runId);
    expect(run).toMatchObject({ status: 'queued', attempt: 1 });
    const [{ updates } = { updates: 0 }] = await db.owner<{ updates: number }[]>`
      select count(*)::int as updates from routine_run_results where run_id = ${runId} and state = 'done'`;
    expect(updates).toBe(1);
  });

  it('cancels its task when the waiting run is stopped, and ends the grant', async () => {
    const s = await setup();
    const { runId, taskId } = await s.park();
    const claimed = await claimJob(s, taskId);
    expect(claimed.status).toBe(200);
    await inWorkspace(s.app.sql, s.workspace, (tx) =>
      pauseRoutine(tx, s.routineId, 'paused', 'paused_by_admin'),
    );
    expect(await s.run(runId)).toMatchObject({ status: 'stopped' });
    const [task] = await db.owner<{ state: string }[]>`
      select state from agent_tasks where session_id = ${taskId}`;
    expect(task?.state).toBe('cancelled');
    const tool = await s.app.request(`${runtimeBase(taskId)}/tools/describe_schema`, {
      key: claimed.body.turnToken,
      body: { toolCallId: 'c', input: {} },
    });
    expect(tool.status).toBe(409);
  });

  it('ends a task past its deadline as timed_out, which ai.agent throws', async () => {
    const s = await setup();
    const { runId, taskId } = await s.park();
    await db.owner`update agent_tasks set expires_at = now() - interval '1 second' where session_id = ${taskId}`;
    await inWorkspace(s.app.sql, s.workspace, (tx) => expireTasks(tx));
    expect(await s.effect(runId)).toMatchObject({ state: 'failed', code: 'timed_out' });
    await s.executor.tick();
    const run = await s.run(runId);
    expect(run?.status).toBe('failed');
    expect(JSON.stringify(run?.output)).toContain('timed_out');
  });

  it('gives a job delivered again the task’s remaining steps; a late report counts once', async () => {
    const s = await setup();
    const { taskId } = await s.park();
    const first = await claimJob(s, taskId);
    expect(first.body.limits.maxSteps).toBe(100);
    for (const step of ['s1', 's2', 's3'])
      expect((await report(s, taskId, first.body.turnToken, step, 2)).status).toBe(200);
    // The delivery dies: its turn runs past its deadline and grace, and its
    // lease runs out.
    await db.owner`update agent_turns set deadline = now() - interval '5 minutes' where session_id = ${taskId}`;
    await db.owner`update agent_tasks set lease_until = now() - interval '1 second' where session_id = ${taskId}`;
    const second = await claimJob(s, taskId);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.limits.maxSteps).toBe(97);
    // The tool-call allowance is the whole task's too.
    expect(second.body.limits.maxToolCalls).toBe(first.body.limits.maxToolCalls - 6);
    expect(second.body.session.firstTurn).toBe(false);
    const late = await report(s, taskId, first.body.turnToken, 's3');
    expect(late.status).not.toBe(200);
    const [{ steps } = { steps: 0 }] = await db.owner<{ steps: number }[]>`
      select coalesce(sum(steps), 0)::int as steps from agent_turns where session_id = ${taskId}`;
    expect(steps).toBe(3);
  });

  it('ends a task whose steps ran out when its job comes back, and the ending sticks', async () => {
    const s = await setup();
    const { runId, taskId } = await s.park();
    await db.owner`update agent_sessions set limits = limits || '{"maxSteps": 2}' where id = ${taskId}`;
    const first = await claimJob(s, taskId);
    for (const step of ['s1', 's2']) await report(s, taskId, first.body.turnToken, step);
    await db.owner`update agent_turns set deadline = now() - interval '5 minutes' where session_id = ${taskId}`;
    await db.owner`update agent_tasks set lease_until = now() - interval '1 second' where session_id = ${taskId}`;
    const second = await claimJob(s, taskId);
    expect(second.status).toBe(429);
    const [task] = await db.owner<{ state: string; code: string }[]>`
      select state, code from agent_tasks where session_id = ${taskId}`;
    expect(task).toMatchObject({ state: 'failed', code: 'limit_reached' });
    expect(await s.effect(runId)).toMatchObject({ state: 'failed', code: 'limit_reached' });
  });

  it('ends a task that expired before its delivery claimed, and the ending sticks', async () => {
    const s = await setup();
    const { runId, taskId } = await s.park();
    s.delivered.length = 0;
    await s.dispatcher.tick();
    const delivery = s.delivered.find((d) => d.sessionId === taskId);
    await db.owner`update agent_tasks set expires_at = now() - interval '1 second' where session_id = ${taskId}`;
    const claim = await s.app.request(`${runtimeBase(taskId)}/claim`, {
      key: RUNTIME_SECRET,
      body: { job: delivery?.jobToken },
    });
    expect(claim.status).toBe(409);
    expect(await s.effect(runId)).toMatchObject({ state: 'failed', code: 'timed_out' });
  });

  it('cancels a waiting run’s task when forget erases routine content', async () => {
    const s = await setup();
    const { runId, taskId } = await s.park();
    await inWorkspace(s.app.sql, s.workspace, (tx) => eraseRoutineContent(tx, s.workspace));
    expect(await s.run(runId)).toMatchObject({ status: 'erased' });
    const [task] = await db.owner<{ state: string; code: string; input: unknown }[]>`
      select state, code, input from agent_tasks where session_id = ${taskId}`;
    expect(task).toMatchObject({ state: 'cancelled', code: 'run_erased', input: null });
    // A late answer is dropped: nothing reaches the erased run's effect.
    const stored = await inWorkspace(s.app.sql, s.workspace, (tx) =>
      completeTask(tx, taskId, { status: 'completed', answer: { round: 'Series A' } }),
    );
    expect(stored).toBe(false);
    expect(await s.effect(runId)).toMatchObject({ state: 'started', result: null });
  });

  it('ends a run whose input changed while it waited as diverged, flagged on its page', async () => {
    const s = await setup();
    const { runId, record, taskId } = await s.park();
    // The task writes the record its run read for its input.
    await s.app.request(`/v1/records/${record}`, {
      key: s.keys.admin,
      method: 'PATCH',
      body: { values: { name: 'Acme Holdings' } },
    });
    await inWorkspace(s.app.sql, s.workspace, (tx) =>
      completeTask(tx, taskId, { status: 'completed', answer: { round: 'Seed' } }),
    );
    await s.executor.tick();
    expect(await s.run(runId)).toMatchObject({ status: 'diverged' });
    expect(await s.effect(runId)).toMatchObject({ result: null });
    expect(await s.view(runId)).toMatchObject({ needsAttention: true });
    const runs = await db.owner`select 1 from routine_runs where routine_id = ${s.routineId}`;
    expect(runs).toHaveLength(1);
  });

  it('notes an answer the resumed run returned before reaching', async () => {
    const s = await setup();
    const { runId, record, taskId } = await s.park();
    await s.app.request(`/v1/records/${record}`, {
      key: s.keys.admin,
      method: 'PATCH',
      body: { values: { name: 'Stop' } },
    });
    await inWorkspace(s.app.sql, s.workspace, (tx) =>
      completeTask(tx, taskId, { status: 'completed', answer: { round: 'Seed' } }),
    );
    await s.executor.tick();
    expect(await s.run(runId)).toMatchObject({ status: 'succeeded' });
    expect(await s.effect(runId)).toMatchObject({ result: null, delivered: false });
    expect(await s.view(runId)).toMatchObject({ agentAnswerUnused: true });
  });

  it('runs a dry run’s task without writing', async () => {
    const s = await setup();
    await s.company();
    const preview = await s.app.request('/v1/routines/preview', {
      key: s.keys.admin,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'company', label: 'Find the round' },
          uses: { tools: [], model: false },
          agent: { tools: ['retainer.read', 'retainer.write'] },
        },
        code: CODE,
      },
    });
    expect(preview.status, JSON.stringify(preview.body)).toBeLessThan(300);
    await s.executor.tick();
    const [task] = await db.owner<{ session_id: string; mode: string }[]>`
      select session_id, mode from agent_tasks where workspace_id = ${s.workspace}`;
    expect(task?.mode).toBe('dry');
    const claimed = await claimJob(s, task?.session_id as string);
    expect(claimed.status).toBe(200);
    const before = await db.owner`select 1 from record_changes where workspace_id = ${s.workspace}`;
    const write = await s.app.request(
      `${runtimeBase(task?.session_id as string)}/tools/upsert_record`,
      {
        key: claimed.body.turnToken,
        body: { toolCallId: 'w', input: { object: 'company', values: { name: 'Dry Co' } } },
      },
    );
    expect(write.body).toMatchObject({ ok: true, output: { dryRun: true } });
    const after = await db.owner`select 1 from record_changes where workspace_id = ${s.workspace}`;
    expect(after.length).toBe(before.length);
  });
});

describe('agent tasks from an extension', () => {
  async function extensionSetup() {
    const fnId = randomUUID(),
      installId = randomUUID();
    const manifest = extensionFixture({
      functions: [
        {
          universalId: installId,
          name: 'setup',
          description: 'Agent fixture setup',
          handlerDigest: 'b'.repeat(64),
          timeoutSeconds: 60,
          trigger: { kind: 'install' },
          inputSchema: { type: 'object', additionalProperties: false },
        },
        {
          universalId: fnId,
          name: 'enrich',
          description: 'Asks the agent',
          handlerDigest: 'b'.repeat(64),
          timeoutSeconds: 60,
          trigger: { kind: 'job' } as never,
          inputSchema: {
            type: 'object',
            properties: { company: { type: 'string' } },
            additionalProperties: false,
          },
          uses: ['agent'],
          agent: { tools: ['retainer.read'] },
        },
      ],
    });
    const catalog = new ExtensionCatalog([
        { manifest, actorCeiling: 'integration', runtimeEnabled: true },
      ]),
      release = catalog.get(manifest.universalId, manifest.version);
    const app = startTestApp(db, {
      extensionCatalog: catalog,
      extensionActivation: new Set([release.digest]),
      runTokens: tokens,
      agent: { runtimeSecret: RUNTIME_SECRET, readStoreUrl: db.url },
    });
    const { workspace, keys } = await app.setupWorkspace(
      { name: `Agent ext ${randomUUID()}` },
      { admin: { actor: { type: 'user', id: 'admin', name: 'Ada' }, scopes: ['admin'] } },
    );
    workspaces.push(workspace.id);
    const input = { registrationId: manifest.universalId, version: manifest.version, settings: {} };
    const plan = await app.request('/v1/extensions/preview', { key: keys.admin, body: input });
    const installed = await app.request('/v1/extensions', {
      key: keys.admin,
      body: { ...input, planDigest: plan.body.planDigest },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(installed.status, JSON.stringify(installed.body)).toBe(201);
    const installationId = installed.body.id as string;
    const queue = new ExtensionQueue(app.sql, catalog.runtime);
    const [pending] = await db.owner<{ id: string }[]>`
      select id from extension_jobs where installation_id=${installationId} and trigger_kind='install'`;
    const setupRun = await queue.claim(workspace.id, pending?.id as string, 'setup');
    if (!setupRun) throw new Error('setup missing');
    await queue.complete(setupRun, { status: 'succeeded' });
    const start = async () => {
      const { id } = await queue.enqueue(workspace.id, installationId, {
        functionId: fnId,
        input: { company: 'Acme' },
        dedupeKey: randomUUID(),
      });
      const job = await queue.claim(workspace.id, id, 'worker');
      if (!job) throw new Error('job not claimed');
      const runToken = await tokens.issue(app.sql, job, manifest.universalId, job.scopes);
      const client = agentClient(
        { apiOrigin: 'http://retainer.test', runToken, installationId },
        app.inProcessFetch as typeof fetch,
      );
      return { job, client };
    };
    return { app, workspace: workspace.id, installationId, queue, start };
  }
  const request = {
    instructions: 'Find the funding round.',
    input: { company: 'Acme' },
    tools: ['retainer.read' as const],
    output: OUTPUT,
  };

  it('stages a task until the invocation waits, then resumes it once with the answer', async () => {
    const e = await extensionSetup();
    const { job, client } = await e.start();
    const { taskId } = await client.start(request);
    const [staged] = await db.owner<
      { state: string }[]
    >`select state from agent_tasks where session_id = ${taskId}`;
    expect(staged?.state).toBe('staged');
    const due = await db.connect({ role: 'retainer_executor', max: 1 })<{ session_id: string }[]>`
      select session_id from retainer_agent_tasks_due(100)`;
    expect(due.map((row) => row.session_id)).not.toContain(taskId);

    const waited = await e.queue.complete(job, { status: 'succeeded', wait: taskId });
    expect(waited.status).toBe('waiting');
    const [parked] = await db.owner<{ status: string; agent_task_id: string }[]>`
      select status, agent_task_id from extension_jobs where id = ${job.jobId}`;
    expect(parked).toMatchObject({ status: 'waiting', agent_task_id: taskId });

    // A change-triggered invocation's pinned change reaches the answer's call too.
    await db.owner`update extension_jobs set change_snapshot = '{"position": "7"}' where id = ${job.jobId}`;
    const done = () =>
      inWorkspace(e.app.sql, e.workspace, (tx) =>
        completeTask(tx, taskId, { status: 'completed', answer: { round: 'Series A' } }),
      );
    await Promise.all([done(), done()]);
    const children = await db.owner<{ status: string; input: unknown; change_snapshot: unknown }[]>`
      select status, input, change_snapshot from extension_jobs where agent_task_id = ${taskId} and id <> ${job.jobId}`;
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      status: 'queued',
      input: { company: 'Acme' },
      change_snapshot: { position: '7' },
    });
    const [parent] = await db.owner<{ status: string }[]>`
      select status from extension_jobs where id = ${job.jobId}`;
    expect(parent?.status).toBe('succeeded');
  });

  it('drops a staged task its invocation ends without waiting for', async () => {
    const e = await extensionSetup();
    const { job, client } = await e.start();
    const { taskId } = await client.start(request);
    await e.queue.complete(job, { status: 'succeeded' });
    const rows = await db.owner`select 1 from agent_tasks where session_id = ${taskId}`;
    expect(rows).toHaveLength(0);
  });

  it('requeues a waiting invocation and cancels its task when privacy erases', async () => {
    const e = await extensionSetup();
    const { job, client } = await e.start();
    const { taskId } = await client.start(request);
    await e.queue.complete(job, { status: 'succeeded', wait: taskId });
    await inWorkspace(e.app.sql, e.workspace, (tx) =>
      eraseExtensionState(tx, e.workspace, [], [], [], []),
    );
    const [task] = await db.owner<{ state: string; code: string; input: unknown }[]>`
      select state, code, input from agent_tasks where session_id = ${taskId}`;
    expect(task).toMatchObject({ state: 'cancelled', code: 'privacy_erased', input: null });
    const [parent] = await db.owner<{ status: string; agent_task_id: string | null }[]>`
      select status, agent_task_id from extension_jobs where id = ${job.jobId}`;
    expect(parent).toMatchObject({ status: 'queued', agent_task_id: null });
  });

  it('cancels the task of a waiting invocation that is cancelled', async () => {
    const e = await extensionSetup();
    const { job, client } = await e.start();
    const { taskId } = await client.start(request);
    await e.queue.complete(job, { status: 'succeeded', wait: taskId });
    await inWorkspace(e.app.sql, e.workspace, (tx) => cancelRuns(tx, e.installationId));
    const [task] = await db.owner<
      { state: string }[]
    >`select state from agent_tasks where session_id = ${taskId}`;
    expect(task?.state).toBe('cancelled');
    const [parent] = await db.owner<{ status: string }[]>`
      select status from extension_jobs where id = ${job.jobId}`;
    expect(parent?.status).toBe('cancelled');
  });
});
