import { randomUUID } from 'node:crypto';
import { executeRoutine } from '@retainer/runner/routine';
import { generateKeyPair } from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RunTokens } from '../../src/extension-runtime/tokens.js';
import {
  type RoutineDriver,
  RoutineExecutor,
  RoutineMaintenance,
} from '../../src/worker/routines.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { useTestDatabase } from '../helpers/db.js';

/**
 * Routines end to end (routines spec §11.2): REST in, the real executor, the
 * real routine runner in its sandbox, and the runtime API it calls, all
 * against real Postgres. Only the transport is in-process.
 */
const db = useTestDatabase(),
  workspaces: string[] = [];
let tokens: RunTokens;
beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA');
  tokens = new RunTokens({
    issuer: 'https://retainer.test',
    keyId: 'routines',
    signingKey: pair.privateKey,
    verificationKey: pair.publicKey,
  });
});
afterEach(async () => {
  if (workspaces.length)
    await db.owner`delete from workspaces where id=any(${workspaces.splice(0)}::uuid[])`;
});

async function setup(
  options: { modelCallsPerDay?: number; driver?: (app: TestApp) => RoutineDriver } = {},
) {
  const app = startTestApp(db, {
    runTokens: tokens,
    routines: {
      modelAvailable: true,
      modelOrigin: 'http://model.test/',
      modelName: 'claude-opus-5-5',
      modelCallsPerDay: options.modelCallsPerDay ?? 1000,
    },
  });
  const { workspace, keys } = await app.setupWorkspace(
    { name: `Routines ${randomUUID()}` },
    {
      admin: { actor: { type: 'user', id: 'admin', name: 'Ada Admin' }, scopes: ['admin'] },
      agent: {
        actor: { type: 'agent', id: 'agent:builder', name: 'Builder' },
        scopes: ['read', 'write'],
      },
    },
  );
  workspaces.push(workspace.id);
  const schema = await app.request('/v1/schema/changes', {
    key: keys.admin,
    body: {
      operations: [
        {
          op: 'create_field',
          object: 'company',
          field: { name: 'tier', label: 'Tier', type: 'text' },
        },
      ],
      reason: 'Routine tests',
    },
  });
  expect(schema.status).toBe(200);
  const caps = await app.request('/v1/routines/capabilities', { key: keys.agent });
  expect(caps.status).toBe(200);
  const company = caps.body.objects.find((o: { name: string }) => o.name === 'company');
  const key = (name: string) =>
    company.fields.find((f: { name: string }) => f.name === name).key as string;
  const executor = new RoutineExecutor({
    sql: app.sql,
    discoverySql: db.connect({ role: 'retainer_executor', max: 1 }),
    tokens,
    driver: options.driver?.(app) ?? {
      invoke: (_exe, invocation, signal) => executeRoutine(invocation, signal, app.inProcessFetch),
    },
    executable: {
      registrationId: randomUUID(),
      functionId: randomUUID(),
      releaseDigest: 'a'.repeat(64),
      driverTarget: 'routine-runner',
    } as never,
    apiOrigin: 'http://retainer.test/',
    owner: 'test-executor',
    config: { modelAvailable: true },
  });
  const maintenance = new RoutineMaintenance(
    app.sql,
    db.connect({ role: 'retainer_executor', max: 1 }),
  );
  return { app, workspace: workspace.id, keys, caps: caps.body, key, executor, maintenance };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const TIER_ROUTINE = (tier: string, name: string) => ({
  manifest: {
    when: { kind: 'record', object: 'company', on: ['created'] },
    if: { [name]: { contains: 'Acme' } },
    uses: { tools: [], model: false },
  },
  code: `export async function main({ retainer, record }: RoutineContext<'company'>) {
  await retainer.company.update(record.id, { ${JSON.stringify(tier)}: 'gold' });
  return { tiered: record.id };
}
`,
});

/** Validates (running the sandbox check), proposes as the agent and approves as the admin. */
async function activate(s: Setup, source: { manifest: unknown; code: string }) {
  const { app, keys, executor } = s;
  const validated = await app.request('/v1/routines/validate', { key: keys.agent, body: source });
  expect(validated.status).toBe(200);
  expect(validated.body.problems).toEqual([]);
  if (validated.body.valid === null) {
    await executor.tick();
    const job = await app.request(`/v1/routines/jobs/${validated.body.jobId}`, { key: keys.agent });
    if (job.body.valid !== true) console.error(JSON.stringify(job.body));
    expect(job.body).toMatchObject({ valid: true, problems: [] });
  }
  const proposed = await app.request('/v1/routines', {
    key: keys.agent,
    body: {
      ...source,
      name: 'Tier Acme companies',
      description: 'When a company called Acme is created, set its tier to gold.',
      summary: 'Sets new Acme companies to the gold tier.',
      report: { verdict: 'full', gaps: [] },
    },
  });
  expect(proposed.status).toBe(201);
  const { routineId, versionId } = proposed.body;
  const refused = await app.request(`/v1/routines/${routineId}/versions/${versionId}/approve`, {
    key: keys.agent,
    body: {},
  });
  expect(refused.status).toBe(403);
  const approved = await app.request(`/v1/routines/${routineId}/versions/${versionId}/approve`, {
    key: keys.admin,
    body: {},
  });
  expect(approved.status).toBe(200);
  return { routineId: routineId as string, versionId: versionId as string };
}

async function createCompany(app: TestApp, key: string, name: string) {
  const created = await app.request('/v1/objects/company/records', {
    key,
    body: { values: { name } },
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe('routines', () => {
  it('reports manifest problems as fixed logic, before anything runs', async () => {
    const { app, keys } = await setup();
    const res = await app.request('/v1/routines/validate', {
      key: keys.agent,
      body: {
        manifest: {
          when: { kind: 'schedule', cron: '* * * * *', object: 'nothing' },
          uses: { tools: ['send_email'], model: false },
        },
        code: "import fs from 'node:fs';\nexport const x = 1;\n",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.problems.map((p: { code: string }) => p.code).sort()).toEqual(
      ['import_not_allowed', 'missing_main', 'no_tool', 'over_limit', 'unknown_object'].sort(),
    );
  });

  it('a type error fails the sandbox check, with its position', async () => {
    const s = await setup();
    const res = await s.app.request('/v1/routines/validate', {
      key: s.keys.agent,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'company', label: 'Go' },
          uses: { tools: [], model: false },
        },
        code: `export async function main({ record }: RoutineContext<'company'>) {\n  const n: number = record.id;\n  return n;\n}\n`,
      },
    });
    expect(res.body.valid).toBe(null);
    await s.executor.tick();
    const job = await s.app.request(`/v1/routines/jobs/${res.body.jobId}`, { key: s.keys.agent });
    expect(job.body).toMatchObject({
      valid: false,
      problems: [expect.objectContaining({ at: '2:9', code: 'TS2322' })],
    });
    const proposed = await s.app.request('/v1/routines', {
      key: s.keys.agent,
      body: {
        manifest: {
          when: { kind: 'manual', object: 'company', label: 'Go' },
          uses: { tools: [], model: false },
        },
        code: `export async function main({ record }: RoutineContext<'company'>) {\n  const n: number = record.id;\n  return n;\n}\n`,
        name: 'x',
        description: 'x',
        summary: 'x',
        report: { verdict: 'full', gaps: [] },
      },
    });
    expect(proposed.status).toBe(409);
  });

  it('runs an approved routine on matching records only, writing as the routine', async () => {
    const s = await setup();
    const { routineId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Corp');
    const other = await createCompany(s.app, s.keys.admin, 'Other Inc');
    await s.maintenance.maintain();
    await s.executor.tick();
    const record = async (id: string) =>
      (await s.app.request(`/v1/records/${id}`, { key: s.keys.admin })).body;
    expect((await record(acme)).fields.tier).toBe('gold');
    expect((await record(other)).fields.tier ?? null).toBe(null);
    const runs = await db.owner<{ record_id: string; status: string; code: string | null }[]>`
      select record_id,status,code from routine_runs where routine_id=${routineId} order by created_at`;
    expect(runs).toEqual(
      expect.arrayContaining([
        { record_id: acme, status: 'succeeded', code: null },
        { record_id: other, status: 'skipped', code: 'condition_false' },
      ]),
    );
    const [assertion] = await db.owner<{ actor: { type: string; id: string; name: string } }[]>`
      select a.actor from field_assertions a join fields f on f.id=a.field_id
      where a.record_id=${acme} and f.name='tier'`;
    expect(assertion?.actor).toMatchObject({ type: 'agent', id: routineId });
    expect(assertion?.actor.name).toContain('Tier Acme companies (routine, version 1');
    // Its own write does not trigger it again.
    await s.maintenance.maintain();
    const [count] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from routine_runs where routine_id=${routineId}`;
    expect(count?.n).toBe(2);
  });

  it('a run interrupted mid-loop is retried and ends with each write made once', async () => {
    let crashed = true;
    const s = await setup({
      driver: (app) => ({
        invoke: async (_exe, invocation, signal) => {
          if (crashed) return executeRoutine(invocation, signal, app.inProcessFetch);
          // The first attempt dies after its third write, like a lost container.
          crashed = true;
          const stop = new AbortController();
          let writes = 0;
          const transport = (async (url: string | URL | Request, init?: RequestInit) => {
            const response = await app.inProcessFetch(url, init);
            if (String(url).endsWith('/runtime/effects') && ++writes === 3) stop.abort();
            return response;
          }) as typeof fetch;
          await executeRoutine(invocation, AbortSignal.any([signal, stop.signal]), transport).catch(
            () => {},
          );
          throw new Error('the runner died');
        },
      }),
    });
    const tier = s.key('tier');
    const { routineId } = await activate(s, {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Ten' },
        uses: { tools: [], model: false },
      },
      code: `export async function main({ retainer, record }: RoutineContext<'company'>) {
  for (let i = 0; i < 10; i++) await retainer.company.create({ name: record.id + ' #' + i });
  await retainer.company.update(record.id, { ${JSON.stringify(tier)}: 'done' });
  return 'ok';
}
`,
    });
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Loop');
    crashed = false;
    const pressed = await s.app.request(`/v1/routines/${routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [acme] },
    });
    const runId = pressed.body.runs[0] as string;
    await s.executor.tick();
    const [after] = await db.owner<
      { status: string }[]
    >`select status from routine_runs where id=${runId}`;
    expect(after?.status).toBe('queued');
    await db.owner`update routine_runs set available_at=now() where id=${runId}`;
    await s.executor.tick();
    const [run] = await db.owner<{ status: string; attempt: number }[]>`
      select status,attempt from routine_runs where id=${runId}`;
    expect(run).toEqual({ status: 'succeeded', attempt: 2 });
    const made = await s.app.request('/v1/objects/company/query', {
      key: s.keys.admin,
      body: { filter: { name: { contains: `${acme} #` } }, limit: 100 },
    });
    expect(made.body.records).toHaveLength(10);
  });

  it("a routine's write to a value a person set waits for review", async () => {
    const s = await setup();
    const tier = s.key('tier');
    await activate(s, TIER_ROUTINE(tier, s.key('name')));
    const created = await s.app.request('/v1/objects/company/records', {
      key: s.keys.admin,
      body: { values: { name: 'Acme Ranked', tier: 'silver' } },
    });
    await s.maintenance.maintain();
    await s.executor.tick();
    const record = await s.app.request(`/v1/records/${created.body.id}`, { key: s.keys.admin });
    expect(record.body.fields.tier).toBe('silver');
  });

  it('approving a new version discards runs not yet started', async () => {
    const s = await setup();
    const source = TIER_ROUTINE(s.key('tier'), s.key('name'));
    const { routineId } = await activate(s, source);
    await createCompany(s.app, s.keys.admin, 'Acme Waiting');
    await s.maintenance.maintain();
    const v2 = await s.app.request('/v1/routines', {
      key: s.keys.agent,
      body: {
        ...source,
        routineId,
        name: 'Tier Acme companies',
        description: 'Version two.',
        summary: 'Sets new Acme companies to the gold tier.',
        report: { verdict: 'full', gaps: [] },
      },
    });
    expect(v2.status).toBe(201);
    const approved = await s.app.request(
      `/v1/routines/${routineId}/versions/${v2.body.versionId}/approve`,
      { key: s.keys.admin, body: {} },
    );
    expect(approved.body.discardedRuns).toBe(1);
    const runs = await db.owner<{ status: string }[]>`
      select status from routine_runs where routine_id=${routineId}`;
    expect(runs.map((r) => r.status)).toEqual(['discarded']);
  });

  it('removing a field the code uses pauses the routine before it acts', async () => {
    const s = await setup();
    const { routineId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const removed = await s.app.request('/v1/schema/changes', {
      key: s.keys.admin,
      body: {
        operations: [{ op: 'delete_field', object: 'company', field: 'tier' }],
        reason: 'gone',
      },
    });
    expect(removed.status).toBe(200);
    const acme = await createCompany(s.app, s.keys.admin, 'Acme After');
    await s.maintenance.maintain();
    await s.executor.tick();
    const routine = await s.app.request(`/v1/routines/${routineId}`, { key: s.keys.admin });
    expect(routine.body).toMatchObject({ status: 'needs_attention', pausedReason: 'check_failed' });
    const [run] = await db.owner<{ status: string; code: string }[]>`
      select status,code from routine_runs where routine_id=${routineId} and record_id=${acme}`;
    expect(run).toEqual({ status: 'failed', code: 'check_failed' });
  });

  it('replays a recorded effect instead of repeating it, and diverges on another operation', async () => {
    const s = await setup();
    const tier = s.key('tier');
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(tier, s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Test');
    // A test run on one record: claimed, then driven by hand through the runtime API.
    const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
      key: s.keys.admin,
      body: { recordId: acme },
    });
    expect(tested.status).toBe(202);
    const runId = tested.body.runId as string;
    const claimed = await s.executor.claim(s.workspace, runId);
    if (!claimed) throw new Error('run not claimed');
    const token = await tokens.issueRoutine(
      s.workspace,
      { runId, routineId, fence: claimed.fence, mode: claimed.mode, tools: [] },
      new Date(Date.now() + 60000),
    );
    const effect = (position: number, operation: string, args: Record<string, unknown>) =>
      s.app.request('/v1/routines/runtime/effects', {
        key: token,
        body: { position, operation, args },
      });
    const update = { object: 'company', id: acme, values: { [tier]: 'silver' } };
    // The same position at once: one write, one replay.
    const [a, b] = await Promise.all([
      effect(1, 'record.update', update),
      effect(1, 'record.update', update),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    const [writes] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from field_assertions a join fields f on f.id=a.field_id
      where a.record_id=${acme} and f.name='tier'`;
    expect(writes?.n).toBe(1);
    // Different arguments at a recorded position are not repeated; they are flagged.
    const changed = await effect(1, 'record.update', { ...update, values: { [tier]: 'bronze' } });
    expect(changed.body).toMatchObject({ state: 'done', replayed: true, differs: true });
    // Another operation at a recorded position ends the run.
    const diverged = await effect(1, 'remember', { about: acme, text: 'x' });
    expect(diverged.body.error.code).toBe('run_diverged');
    const [run] = await db.owner<
      { status: string }[]
    >`select status from routine_runs where id=${runId}`;
    expect(run?.status).toBe('diverged');
    // A run that ended takes no more effects.
    expect((await effect(2, 'record.update', update)).status).toBeGreaterThanOrEqual(400);
    // The routine token reaches nothing outside the runtime.
    expect((await s.app.request(`/v1/records/${acme}`, { key: token })).status).toBe(403);
  });

  it('two executors claiming one run at once: exactly one gets it', async () => {
    const s = await setup();
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(s.key('tier'), s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Race');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
        key: s.keys.admin,
        body: { recordId: acme },
      });
      ids.push(tested.body.runId);
    }
    for (const id of ids) {
      const claims = await Promise.all([
        s.executor.claim(s.workspace, id),
        s.executor.claim(s.workspace, id),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
    }
    const [fences] = await db.owner<{ n: number }[]>`
      select count(*)::int as n from routine_runs where id=any(${ids}::uuid[]) and fence=1 and attempt=1`;
    expect(fences?.n).toBe(5);
  });

  it('a paused routine refuses the next effect of a run already going', async () => {
    const s = await setup();
    const source = {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Tier it' },
        uses: { tools: [], model: false },
      },
      code: TIER_ROUTINE(s.key('tier'), s.key('name')).code,
    };
    const { routineId } = await activate(s, source);
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Manual');
    const pressed = await s.app.request(`/v1/routines/${routineId}/run`, {
      key: s.keys.admin,
      body: { recordIds: [acme] },
    });
    expect(pressed.status).toBe(202);
    const [queued] = await db.owner<{ id: string }[]>`
      select id from routine_runs where routine_id=${routineId} and status='queued'`;
    const claimed = await s.executor.claim(s.workspace, queued?.id as string);
    if (!claimed) throw new Error('run not claimed');
    const token = await tokens.issueRoutine(
      s.workspace,
      { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'run', tools: [] },
      new Date(Date.now() + 60000),
    );
    expect(
      (await s.app.request(`/v1/routines/${routineId}/pause`, { key: s.keys.admin, body: {} }))
        .status,
    ).toBe(200);
    const refused = await s.app.request('/v1/routines/runtime/effects', {
      key: token,
      body: {
        position: 1,
        operation: 'record.update',
        args: { object: 'company', id: acme, values: {} },
      },
    });
    expect(refused.body.error.code).toBe('routine_paused');
  });

  it('forget erases stored results and ends runs in flight as erased', async () => {
    const s = await setup();
    const tier = s.key('tier');
    const { routineId, versionId } = await activate(s, TIER_ROUTINE(tier, s.key('name')));
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Forget');
    const doomed = await createCompany(s.app, s.keys.admin, 'Doomed Ltd');
    const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
      key: s.keys.admin,
      body: { recordId: acme },
    });
    const claimed = await s.executor.claim(s.workspace, tested.body.runId);
    if (!claimed) throw new Error('run not claimed');
    const token = await tokens.issueRoutine(
      s.workspace,
      { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'test', tools: [] },
      new Date(Date.now() + 60000),
    );
    const effect = (position: number) =>
      s.app.request('/v1/routines/runtime/effects', {
        key: token,
        body: {
          position,
          operation: 'record.update',
          args: { object: 'company', id: acme, values: { [tier]: 'gold' } },
        },
      });
    expect((await effect(1)).body.state).toBe('done');
    const forgot = await s.app.request(`/v1/records/${doomed}/forget`, {
      key: s.keys.admin,
      method: 'POST',
    });
    expect(forgot.status).toBe(200);
    const [stored] = await db.owner<{ result: unknown }[]>`
      select result from routine_run_results where run_id=${claimed.runId}`;
    expect(stored?.result).toBe(null);
    const [run] = await db.owner<
      { status: string }[]
    >`select status from routine_runs where id=${claimed.runId}`;
    expect(run?.status).toBe('erased');
    expect((await effect(2)).body.error.code).toMatch(/run_erased|lease_expired/);
  });

  it('a preview dry-runs the code on recent matches and writes nothing', async () => {
    const s = await setup();
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Preview');
    const res = await s.app.request('/v1/routines/preview', {
      key: s.keys.agent,
      body: TIER_ROUTINE(s.key('tier'), s.key('name')),
    });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBeGreaterThanOrEqual(1);
    await s.executor.tick();
    const preview = await s.app.request(`/v1/routines/previews/${res.body.previewId}`, {
      key: s.keys.agent,
    });
    expect(preview.body.done).toBe(true);
    const run = preview.body.runs.find((r: { recordId: string }) => r.recordId === acme);
    expect(run.status).toBe('succeeded');
    expect(run.calls).toEqual([
      expect.objectContaining({ position: 1, operation: 'record.update', state: 'reported' }),
    ]);
    const record = await s.app.request(`/v1/records/${acme}`, { key: s.keys.admin });
    expect(record.body.fields.tier ?? null).toBe(null);
  });

  it('reserves model calls against the daily cap atomically', async () => {
    const s = await setup({ modelCallsPerDay: 3 });
    const source = {
      manifest: {
        when: { kind: 'manual', object: 'company', label: 'Ask' },
        uses: { tools: [], model: true },
      },
      code: `export async function main({ retainer }: RoutineContext<'company'>) {
  return retainer.ai.generate({ instructions: 'Say hi', input: null, output: { type: 'string' } });
}
`,
    };
    const { routineId, versionId } = await activate(s, source);
    const acme = await createCompany(s.app, s.keys.admin, 'Acme Model');
    const runTokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const tested = await s.app.request(`/v1/routines/${routineId}/versions/${versionId}/test`, {
        key: s.keys.admin,
        body: { recordId: acme },
      });
      const claimed = await s.executor.claim(s.workspace, tested.body.runId);
      if (!claimed) throw new Error('run not claimed');
      runTokens.push(
        await tokens.issueRoutine(
          s.workspace,
          { runId: claimed.runId, routineId, fence: claimed.fence, mode: 'test', tools: [] },
          new Date(Date.now() + 60000),
        ),
      );
    }
    const answers = await Promise.all(
      runTokens.map((key) =>
        s.app.request('/v1/routines/runtime/effects', {
          key,
          body: {
            position: 1,
            operation: 'ai.generate',
            args: { instructions: 'Say hi', input: null, output: { type: 'string' } },
          },
        }),
      ),
    );
    const states = answers.map((a) => a.body.state ?? a.body.error?.code).sort();
    expect(states).toEqual([
      'budget_exhausted',
      'budget_exhausted',
      'budget_exhausted',
      'model',
      'model',
      'model',
    ]);
    const [day] = await db.owner<{ count: number }[]>`
      select count from routine_model_days where workspace_id=${s.workspace}`;
    expect(day?.count).toBe(3);
  });
});
